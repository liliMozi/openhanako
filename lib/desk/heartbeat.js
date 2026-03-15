/**
 * heartbeat.js — 日常巡检 + 笺目录扫描
 *
 * 让 agent 从被动应答变成主动行动的关键机制。
 * 两个阶段：
 *   Phase 1: 工作空间文件变化检测
 *   Phase 2: 笺扫描（根目录 + 一级子目录的 jian.md，指纹比对后隔离执行）
 *
 * 定时任务（cron）由独立的 cron-scheduler 调度，不经过巡检。
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { debugLog } from "../debug-log.js";

/** 12 位 MD5 短指纹 */
function quickHash(str) {
  return createHash("md5").update(str).digest("hex").slice(0, 12);
}

/** 人类可读文件大小 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ═══════════════════════════════════════
//  Prompt 构建
// ═══════════════════════════════════════

/**
 * 工作空间巡检 prompt（支持 i18n）
 */
function buildHeartbeatContext({ deskFiles, overwatch, isZh }) {
  const now = new Date();
  const timeStr = now.toLocaleString(isZh ? "zh-CN" : "en-US", { hour12: false });

  const parts = isZh
    ? [
        `[心跳巡检] 现在是 ${timeStr}`,
        "",
        "**注意：这是系统自动触发的巡检消息，不是用户发来的。用户目前没有在跟你对话，不要把巡检当作用户的提问来回应。**",
        "你需要独立判断是否有需要主动处理的事项，如果有就直接执行，不要向用户提问或等待回复。",
        "",
      ]
    : [
        `[Heartbeat Patrol] Current time: ${timeStr}`,
        "",
        "**Note: This is an automated patrol message, NOT from the user. The user is not currently talking to you — do not treat this as a user query.**",
        "Independently determine if there are items that need proactive handling. If so, act directly — do not ask the user or wait for a reply.",
        "",
      ];

  if (overwatch) {
    parts.push("## Overwatch");
    parts.push(overwatch);
    parts.push("");
  }

  if (deskFiles && deskFiles.length > 0) {
    parts.push(isZh ? "## 工作空间文件：" : "## Workspace files:");
    for (const f of deskFiles) {
      parts.push(`- ${f.isDir ? "📁 " : ""}${f.name}`);
    }
    parts.push("");
  }

  parts.push("---");
  parts.push(isZh
    ? "请**仅根据以上提供的内容**判断是否有需要主动处理的事项。不要主动查询定时任务状态等未在上文列出的系统信息。发现需要关注的事项时，用 notify 工具通知用户。如果一切正常，不要调用任何工具。"
    : "Determine if anything needs proactive attention **based solely on the information provided above**. Do not proactively query system status such as cron jobs that is not listed above. If you find anything noteworthy, use the notify tool to alert the user. If everything is fine, do not call any tools.");

  return parts.join("\n");
}

/**
 * 笺目录专用 prompt（支持 i18n）
 */
function buildJianPrompt({ dirPath, jianContent, files, jianChanged, filesChanged, isZh }) {
  const parts = isZh
    ? [
        `[目录巡检] ${dirPath}`,
        "",
        "**注意：这是系统自动触发的目录巡检，不是用户发来的消息。**",
        "请根据笺的指令独立判断并处理，不要向用户提问或等待回复。",
        "",
      ]
    : [
        `[Directory Patrol] ${dirPath}`,
        "",
        "**Note: This is an automated directory patrol, NOT a user message.**",
        "Follow the jian instructions independently — do not ask the user or wait for a reply.",
        "",
      ];

  parts.push(isZh ? "## 笺" : "## Jian");
  parts.push(jianContent);
  parts.push("");

  if (files.length > 0) {
    parts.push(isZh ? "## 文件列表" : "## File list");
    for (const f of files) {
      const prefix = f.isDir ? "📁 " : "📄 ";
      const size = f.isDir ? "" : ` (${formatSize(f.size)})`;
      parts.push(`- ${prefix}${f.name}${size}`);
    }
    parts.push("");
  }

  parts.push(isZh ? "## 变化" : "## Changes");
  parts.push(`- jian.md: ${jianChanged ? (isZh ? "已变化" : "changed") : (isZh ? "未变" : "unchanged")}`);
  parts.push(`- ${isZh ? "文件" : "files"}: ${filesChanged ? (isZh ? "有变化" : "changed") : (isZh ? "未变" : "unchanged")}`);
  parts.push("");
  parts.push(isZh
    ? "请根据笺的指令处理。如果无需行动，不要调用任何工具。"
    : "Follow the jian instructions. If no action is needed, do not call any tools.");

  return parts.join("\n");
}

// ═══════════════════════════════════════
//  笺目录扫描
// ═══════════════════════════════════════

/**
 * 列出目录下的文件（排除 . 开头和 jian.md 本身）
 */
function listDirFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !e.name.startsWith(".") && e.name !== "jian.md")
      .map(e => {
        const fp = path.join(dir, e.name);
        let stat;
        try { stat = fs.lstatSync(fp); } catch { return null; }
        if (stat.isSymbolicLink()) return null; // 跳过 symlink
        return {
          name: e.name,
          isDir: e.isDirectory(),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 扫描工作空间，找到所有含 jian.md 的目录（根目录 + 一级子目录）
 */
function scanJianDirs(wsPath) {
  if (!wsPath || !fs.existsSync(wsPath)) return [];

  const dirs = [];

  // 根目录
  if (fs.existsSync(path.join(wsPath, "jian.md"))) {
    try {
      dirs.push({
        name: ".",
        absPath: wsPath,
        jianContent: fs.readFileSync(path.join(wsPath, "jian.md"), "utf-8"),
        files: listDirFiles(wsPath),
      });
    } catch {}
  }

  // 一级子目录
  try {
    const entries = fs.readdirSync(wsPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const subPath = path.join(wsPath, e.name);
      const jianFile = path.join(subPath, "jian.md");
      if (!fs.existsSync(jianFile)) continue;
      try {
        dirs.push({
          name: e.name,
          absPath: subPath,
          jianContent: fs.readFileSync(jianFile, "utf-8"),
          files: listDirFiles(subPath),
        });
      } catch {}
    }
  } catch {}

  return dirs;
}

// ═══════════════════════════════════════
//  心跳调度器
// ═══════════════════════════════════════

/**
 * 创建心跳调度器
 *
 * @param {object} opts
 * @param {() => Array} [opts.getDeskFiles] - 获取根目录文件列表
 * @param {() => string} [opts.getWorkspacePath] - 获取工作空间路径
 * @param {string} [opts.registryPath] - jian-registry.json 存储路径
 * @param {(prompt: string) => Promise<void>} opts.onBeat - 工作空间巡检回调
 * @param {(prompt: string, cwd: string) => Promise<void>} [opts.onJianBeat] - 笺巡检回调（带 cwd）
 * @param {number} [opts.intervalMinutes] - 巡检间隔（分钟），默认 15
 * @param {(text: string, level?: string) => void} [opts.emitDevLog]
 * @returns {{ start, stop, beat, triggerNow }}
 */
export function createHeartbeat({
  getDeskFiles, getWorkspacePath, registryPath,
  onBeat, onJianBeat,
  intervalMinutes, emitDevLog,
  overwatchPath, locale,
}) {
  const isZh = !locale || String(locale).startsWith("zh");
  const devlog = (text, level = "heartbeat") => {
    emitDevLog?.(text, level);
  };
  const INTERVAL = (intervalMinutes || 17) * 60 * 1000;
  const COOLDOWN = 2 * 60 * 1000;
  const BEAT_TIMEOUT = 5 * 60 * 1000;

  let _timer = null;
  let _running = false;
  let _beatPromise = null;
  let _lastTrigger = 0;
  let _lastDeskFingerprint = "";

  // ── 指纹注册表 ──

  function loadRegistry() {
    if (!registryPath) return {};
    try {
      return JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    } catch {
      return {};
    }
  }

  function saveRegistry(reg) {
    if (!registryPath) return;
    try {
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
      fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2), "utf-8");
    } catch (err) {
      console.warn(`[heartbeat] saveRegistry 失败: ${err.message}`);
    }
  }

  // ── 心跳执行 ──

  async function beat() {
    if (_running) return;
    _running = true;
    const p = _doBeat();
    _beatPromise = p;
    await p;
  }

  async function _doBeat() {
    try {
      const tag = "\x1b[36m[heartbeat]\x1b[0m";
      console.log(`${tag} ── 心跳开始 ──`);
      debugLog()?.log("heartbeat", "beat start");
      devlog("── 心跳开始 ──");

      // ── 收集上下文 ──
      const deskFiles = getDeskFiles?.() || [];
      const deskFingerprint = deskFiles.map(f => `${f.name}:${f.mtime || 0}`).join("|");
      const deskChanged = deskFingerprint !== _lastDeskFingerprint;

      // Overwatch 注意力清单
      let overwatch = null;
      if (overwatchPath) {
        try {
          const content = fs.readFileSync(overwatchPath, "utf-8").trim();
          if (content) overwatch = content;
        } catch {}
      }

      // 笺目录扫描
      const wsPath = getWorkspacePath?.();
      const jianDirs = (onJianBeat && wsPath) ? scanJianDirs(wsPath) : [];
      const jianChanges = _detectJianChanges(jianDirs);

      // 汇总日志
      const summaryParts = [`文件: ${deskFiles.length}${deskChanged ? " (变化)" : ""}`];
      if (overwatch) summaryParts.push("overwatch: 有内容");
      if (jianDirs.length > 0) summaryParts.push(`笺: ${jianDirs.length} 目录, ${jianChanges.length} 变化`);
      const summary = summaryParts.join("  |  ");
      console.log(`${tag}  ${summary}`);
      devlog(summary);

      // 全部无事，跳过
      if (!deskChanged && !overwatch && jianChanges.length === 0) {
        console.log(`${tag}  无待处理事项，跳过`);
        devlog("无待处理事项，跳过");
        return;
      }

      // ── Phase 1: 工作空间文件变化 / Overwatch ──
      if (deskChanged || overwatch) {
        if (deskChanged) _lastDeskFingerprint = deskFingerprint;
        const prompt = buildHeartbeatContext({ deskFiles, overwatch, isZh });
        console.log(`${tag}  Phase 1: 工作空间巡检 (${prompt.length} chars)`);
        devlog("Phase 1: 工作空间巡检执行中...");
        {
          let timer;
          try {
            await Promise.race([
              onBeat(prompt),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("心跳执行超时 (5min)")), BEAT_TIMEOUT); }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
      }

      // ── Phase 2: 笺目录执行 ──
      if (jianChanges.length > 0) {
        await _processJianChanges(jianChanges, tag);
      }

      console.log(`${tag} ── 心跳完成 ──`);
      debugLog()?.log("heartbeat", "beat done");
      devlog("── 心跳完成 ──");
    } catch (err) {
      console.error(`[heartbeat] beat error: ${err.message}`);
      debugLog()?.error("heartbeat", `beat error: ${err.message}`);
      devlog(`错误: ${err.message}`, "error");
    } finally {
      _running = false;
    }
  }

  /**
   * 对比注册表，找出有变化的笺目录
   */
  function _detectJianChanges(jianDirs) {
    if (jianDirs.length === 0) return [];

    const registry = loadRegistry();
    const result = [];

    for (const dir of jianDirs) {
      const key = dir.absPath;
      const jianHash = quickHash(dir.jianContent);
      const filesHash = quickHash(dir.files.map(f => `${f.name}:${f.mtime}`).join("|"));

      const prev = registry[key];
      const jianChanged = !prev || prev.jianHash !== jianHash;
      const filesChanged = !prev || prev.filesHash !== filesHash;

      // 有内容就触发，agent 自己决定要不要行动
      result.push({ ...dir, jianHash, filesHash, jianChanged, filesChanged });
    }

    return result;
  }

  /**
   * 逐个执行有变化的笺目录
   */
  async function _processJianChanges(changes, tag) {
    const registry = loadRegistry();

    for (const dir of changes) {
      const label = dir.name === "." ? "根目录" : dir.name;
      console.log(`${tag}  Phase 2: 笺 [${label}] 有变化，执行中...`);
      devlog(`笺 [${label}] 有变化，执行中...`);

      const prompt = buildJianPrompt({
        dirPath: dir.absPath,
        jianContent: dir.jianContent,
        files: dir.files,
        jianChanged: dir.jianChanged,
        filesChanged: dir.filesChanged,
        isZh,
      });

      try {
        {
          let timer;
          try {
            await Promise.race([
              onJianBeat(prompt, dir.absPath),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`笺 [${label}] 执行超时 (5min)`)), BEAT_TIMEOUT); }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }

        // 执行成功 → 重新扫描目录，用执行后的指纹存入 registry
        // 避免任务自身修改文件导致下次心跳重复触发（自激振荡）
        const postFiles = listDirFiles(dir.absPath);
        const postFilesHash = quickHash(postFiles.map(f => `${f.name}:${f.mtime}`).join("|"));
        let postJianHash = dir.jianHash;
        try {
          const postJian = fs.readFileSync(path.join(dir.absPath, "jian.md"), "utf-8");
          postJianHash = quickHash(postJian);
        } catch {}

        registry[dir.absPath] = {
          jianHash: postJianHash,
          filesHash: postFilesHash,
          lastCheckedAt: new Date().toISOString(),
        };
        saveRegistry(registry);

        devlog(`笺 [${label}] 执行完成`);
      } catch (err) {
        devlog(`笺 [${label}] 执行失败: ${err.message}`, "error");
      }
    }
  }

  // ── 调度 ──

  function start() {
    if (_timer) return;
    const now = Date.now();
    const msIntoSlot = now % INTERVAL;
    const delay = INTERVAL - msIntoSlot;
    const nextTime = new Date(now + delay);
    console.log(`\x1b[90m[heartbeat] 已启动，下次心跳: ${nextTime.toLocaleTimeString("zh-CN", { hour12: false })}\x1b[0m`);
    debugLog()?.log("heartbeat", `started, next: ${nextTime.toLocaleTimeString("zh-CN", { hour12: false })}`);
    devlog(`心跳已启动，下次: ${nextTime.toLocaleTimeString("zh-CN", { hour12: false })}`);
    _timer = setTimeout(function fire() {
      beat();
      _timer = setInterval(() => beat(), INTERVAL);
      if (_timer.unref) _timer.unref();
    }, delay);
    if (_timer.unref) _timer.unref();
  }

  async function stop() {
    if (_timer) {
      clearTimeout(_timer);
      clearInterval(_timer);
      _timer = null;
    }
    if (_beatPromise) {
      await _beatPromise.catch(() => {});
    }
    _running = false; // 确保 stop 后状态干净
    debugLog()?.log("heartbeat", "stopped");
    devlog("心跳已停止");
  }

  function triggerNow() {
    const now = Date.now();
    if (now - _lastTrigger < COOLDOWN) {
      devlog("手动触发冷却中，跳过");
      return false;
    }
    _lastTrigger = now;
    devlog("手动触发心跳");
    beat();
    return true;
  }

  return { start, stop, beat, triggerNow };
}
