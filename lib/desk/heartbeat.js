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

/**
 * 巡检系统在工作区内自己管辖的目录名。
 * 所有 agent 的 patrol-log 与主动创建的文件都收纳在此（按 agent 名分子目录）。
 * 快照差量检测需要跳过它，否则巡检自己的写入会把下一轮触发成"有变化"。
 */
export const HEARTBEAT_ACTIVITY_DIR = "HeartBeat";

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
 *
 * @param {object} opts
 * @param {boolean} opts.deskChanged - 工作区文件是否有变化
 * @param {{added: string[], modified: string[], removed: string[]}} opts.changedFiles - 变化的文件
 * @param {string|null} opts.overwatch
 * @param {string} opts.agentName
 * @param {boolean} opts.isZh
 * @param {string|null} opts.patrolLog - 近期巡检记录（截断后的内容）
 */
function buildHeartbeatContext({ deskChanged, changedFiles, overwatch, agentName, isZh, patrolLog }) {
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

  // 工作区文件变化（差量上报）
  if (deskChanged && changedFiles) {
    parts.push(isZh ? "## 工作区文件变动：" : "## Workspace file changes:");
    if (changedFiles.added.length > 0) {
      parts.push(isZh ? "新增：" : "Added:");
      for (const f of changedFiles.added) parts.push(`  + ${f}`);
    }
    if (changedFiles.modified.length > 0) {
      parts.push(isZh ? "修改：" : "Modified:");
      for (const f of changedFiles.modified) parts.push(`  ~ ${f}`);
    }
    if (changedFiles.removed.length > 0) {
      parts.push(isZh ? "删除：" : "Removed:");
      for (const f of changedFiles.removed) parts.push(`  - ${f}`);
    }
    parts.push("");
  } else {
    parts.push(isZh ? "## 工作区状态：无文件变动。" : "## Workspace status: no file changes.");
    parts.push("");
  }

  // 近期巡检记录
  if (patrolLog) {
    parts.push(isZh ? "## 近期巡检记录" : "## Recent Patrol Log");
    parts.push(patrolLog);
    parts.push("");
  }

  // 自主活动目录规则（统一收纳在 HeartBeat/ 下，按 agent 名分子目录）
  const activityDir = `${HEARTBEAT_ACTIVITY_DIR}/${agentName || "Hanako"}`;
  parts.push("---");
  const patrolLogPath = `${activityDir}/patrol-log.md`;
  parts.push(isZh
    ? [
        `1. **先查看自主活动目录**：用 ls 工具查看 \`${activityDir}/\` 目录下已有的文件，了解你之前创建过什么内容，避免重复创建。`,
        "2. **参考近期巡检记录**：查看上方的「近期巡检记录」，不要重复做已经做过的事情。",
        "3. 结合你的记忆，判断是否有可以**主动帮用户做的事情**（整理资料、生成摘要、提醒待办等）。",
        "4. 如果发现需要关注的事项，用 notify 工具通知用户。",
        `5. 如果需要**主动创建文件**（基于记忆或判断，而非处理已有文件），请将文件放到工作区的 \`${activityDir}/\` 目录下（不存在则创建）。`,
        "",
        "你也可以利用巡检的空闲时间**自主学习**：搜索你感兴趣的话题、研究用户近期关心的领域、阅读相关资料来充实自己的知识。学到的有价值内容可以记在自主活动目录下，之后和用户聊天时自然地用上。",
        "",
        "不要主动查询定时任务状态等未在上文列出的系统信息。",
        "如果一切正常、没有可主动做的事、也没有想学的东西，不要调用任何工具（但仍需写巡检日志）。",
        "",
        `6. **巡检结束后写日志**：把你本轮做了什么追加到 \`${patrolLogPath}\` 末尾，格式：\`- [YYYY-MM-DD HH:mm] 做了什么\`。如果没有做任何事，写 \`- [YYYY-MM-DD HH:mm] 巡检完毕，无需行动\`。`,
      ].join("\n")
    : [
        `1. **Check the activity directory first**: Use the ls tool to list files under \`${activityDir}/\`, understand what you've created before, and avoid duplicates.`,
        "2. **Review the recent patrol log**: Check the \"Recent Patrol Log\" section above — do not repeat what has already been done.",
        "3. Based on your memory, determine if there is anything you can **proactively do for the user** (organize files, generate summaries, remind about tasks, etc.).",
        "4. If you find something noteworthy, use the notify tool to alert the user.",
        `5. If you need to **create files proactively** (based on memory or judgment, not processing existing files), place them under \`${activityDir}/\` in the workspace (create the directory if it doesn't exist).`,
        "",
        "You may also use patrol downtime to **learn on your own**: search topics that interest you, research areas the user has been focused on recently, or read up on relevant material to enrich your knowledge. Save valuable findings under the autonomous activity directory — you can draw on them naturally in future conversations.",
        "",
        "Do not proactively query system status such as cron jobs that is not listed above.",
        "If everything is fine, there's nothing to proactively do, and nothing you want to learn, do not call any tools (but still write the patrol log).",
        "",
        `6. **Write patrol log when done**: Append what you did this round to \`${patrolLogPath}\`, format: \`- [YYYY-MM-DD HH:mm] what you did\`. If nothing was done, write \`- [YYYY-MM-DD HH:mm] Patrol complete, no action needed\`.`,
      ].join("\n")
  );

  return parts.join("\n");
}

/**
 * 从 jian 内容中分离用户指令和执行记录
 */
function splitJianContent(raw) {
  const startTag = "<!-- exec-log -->";
  const endTag = "<!-- /exec-log -->";
  const startIdx = raw.indexOf(startTag);
  if (startIdx === -1) return { instructions: raw.trim(), execLog: "" };
  const endIdx = raw.indexOf(endTag, startIdx);
  const logBlock = endIdx === -1
    ? raw.slice(startIdx + startTag.length).trim()
    : raw.slice(startIdx + startTag.length, endIdx).trim();
  return {
    instructions: raw.slice(0, startIdx).trim(),
    execLog: logBlock,
  };
}

/**
 * 笺目录专用 prompt（支持 i18n）
 */
function buildJianPrompt({ dirPath, jianContent, files, jianChanged, filesChanged, isZh }) {
  const { instructions, execLog } = splitJianContent(jianContent);

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
  parts.push(instructions);
  parts.push("");

  if (execLog) {
    parts.push(isZh ? "## 过往执行记录" : "## Past Execution Log");
    parts.push(execLog);
    parts.push("");
  }

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
    ? [
        "## 行动规则",
        "",
        "1. **先看执行记录**，判断每条指令的性质：",
        "   - 一次性任务（如「交电费」）：已有记录则跳过",
        "   - 周期性任务（如「每天整理新闻」）：每次巡检都执行",
        "   - 条件性任务（如「直到 XX 完成」）：检查条件是否已满足",
        "2. 执行完毕后，将本次结果追加到 jian.md 的执行记录区域，格式：",
        "   ```",
        "   <!-- exec-log -->",
        "   - [YYYY-MM-DD HH:mm] 任务摘要 | 执行结果简述",
        "   <!-- /exec-log -->",
        "   ```",
        "   如果已有 `<!-- exec-log -->` 标签，在标签内追加新行；没有则在笺末尾新建。",
        "3. 如果无需行动，不要调用任何工具，也不要写执行记录。",
      ].join("\n")
    : [
        "## Action Rules",
        "",
        "1. **Check the execution log first** to determine each instruction's nature:",
        "   - One-time tasks (e.g. 'pay electricity bill'): skip if already logged",
        "   - Recurring tasks (e.g. 'organize news daily'): execute every patrol",
        "   - Conditional tasks (e.g. 'until XX is done'): check if condition is met",
        "2. After completing tasks, append results to the exec-log section in jian.md:",
        "   ```",
        "   <!-- exec-log -->",
        "   - [YYYY-MM-DD HH:mm] Task summary | Brief result",
        "   <!-- /exec-log -->",
        "   ```",
        "   If `<!-- exec-log -->` tags already exist, append inside them; otherwise create at the end.",
        "3. If no action is needed, do not call any tools or write any log entries.",
      ].join("\n")
  );

  return parts.join("\n");
}

// ═══════════════════════════════════════
//  巡检日志（patrol-log）
// ═══════════════════════════════════════

const PATROL_LOG_MAX_ENTRIES = 50;

/**
 * 读取并截断 patrol-log.md，保留最近 N 条
 * @param {string} filePath
 * @returns {string|null} 截断后的内容（null = 文件不存在或为空）
 */
function readAndTruncatePatrolLog(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  if (!raw.trim()) return null;

  const lines = raw.split("\n");
  const entries = lines.filter(l => l.startsWith("- ["));
  if (entries.length === 0) return null;

  if (entries.length > PATROL_LOG_MAX_ENTRIES) {
    const kept = entries.slice(-PATROL_LOG_MAX_ENTRIES);
    try {
      fs.writeFileSync(filePath, kept.join("\n") + "\n", "utf-8");
    } catch {}
    return kept.join("\n");
  }
  return entries.join("\n");
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
 * @param {() => Array|Promise<Array>} [opts.getDeskFiles] - 获取根目录文件列表（支持 async）
 * @param {() => string} [opts.getWorkspacePath] - 获取工作空间路径
 * @param {() => string} [opts.getAgentName] - 获取当前 agent 名称
 * @param {string} [opts.registryPath] - jian-registry.json 存储路径
 * @param {(prompt: string) => Promise<void>} opts.onBeat - 工作空间巡检回调
 * @param {(prompt: string, cwd: string) => Promise<void>} [opts.onJianBeat] - 笺巡检回调（带 cwd）
 * @param {number} [opts.intervalMinutes] - 巡检间隔（分钟），默认 15
 * @param {(text: string, level?: string) => void} [opts.emitDevLog]
 * @returns {{ start, stop, beat, triggerNow }}
 */
export function createHeartbeat({
  getDeskFiles, getWorkspacePath, getAgentName, registryPath,
  onBeat, onJianBeat,
  intervalMinutes, emitDevLog,
  overwatchPath, locale,
}) {
  const isZh = !locale || String(locale).startsWith("zh");
  const devlog = (text, level = "heartbeat") => {
    emitDevLog?.(text, level);
  };
  const INTERVAL = (intervalMinutes || 31) * 60 * 1000;
  const COOLDOWN = 2 * 60 * 1000;
  const BEAT_TIMEOUT = 5 * 60 * 1000;

  let _timer = null;
  let _running = false;
  let _beatPromise = null;
  let _lastTrigger = 0;
  /** @type {Map<string, number>} name → mtime */
  let _lastDeskSnapshot = new Map();

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
      const deskFiles = (await getDeskFiles?.()) || [];

      // 差量 diff：对比上一轮快照，算出 added / modified / removed
      const currentSnapshot = new Map(deskFiles.map(f => [f.name, f.mtime || 0]));
      const changedFiles = { added: [], modified: [], removed: [] };
      for (const [name, mtime] of currentSnapshot) {
        if (!_lastDeskSnapshot.has(name)) changedFiles.added.push(name);
        else if (_lastDeskSnapshot.get(name) !== mtime) changedFiles.modified.push(name);
      }
      for (const name of _lastDeskSnapshot.keys()) {
        if (!currentSnapshot.has(name)) changedFiles.removed.push(name);
      }
      const deskChanged = changedFiles.added.length > 0 || changedFiles.modified.length > 0 || changedFiles.removed.length > 0;
      // 更新快照（不管有没有变化都更新，保持准确）
      _lastDeskSnapshot = currentSnapshot;

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
      const changeCount = changedFiles.added.length + changedFiles.modified.length + changedFiles.removed.length;
      const summaryParts = [isZh ? `文件: ${deskFiles.length}${deskChanged ? ` (${changeCount} 变化)` : ""}` : `files: ${deskFiles.length}${deskChanged ? ` (${changeCount} changed)` : ""}`];
      if (overwatch) summaryParts.push(isZh ? "overwatch: 有内容" : "overwatch: active");
      if (jianDirs.length > 0) summaryParts.push(isZh ? `笺: ${jianDirs.length} 目录, ${jianChanges.length} 变化` : `jian: ${jianDirs.length} dirs, ${jianChanges.length} changed`);
      const summary = summaryParts.join("  |  ");
      console.log(`${tag}  ${summary}`);
      devlog(summary);

      // ── Phase 1: 工作空间巡检（始终执行，让 agent 结合记忆判断） ──
      {
        const agentName = getAgentName?.() || "Hanako";
        // 读取巡检日志（截断）
        const patrolLogPath = wsPath ? path.join(wsPath, HEARTBEAT_ACTIVITY_DIR, agentName, "patrol-log.md") : null;
        const patrolLog = patrolLogPath ? readAndTruncatePatrolLog(patrolLogPath) : null;
        const prompt = buildHeartbeatContext({ deskChanged, changedFiles, overwatch, agentName, isZh, patrolLog });
        console.log(`${tag}  Phase 1: 工作空间巡检 (${prompt.length} chars, ${deskChanged ? "有变化" : "无变化"})`);
        devlog(`Phase 1: 工作空间巡检执行中...${deskChanged ? "" : " (无文件变化)"}`);
        {
          let timer;
          try {
            await Promise.race([
              onBeat(prompt),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(isZh ? "心跳执行超时 (5min)" : "Heartbeat timed out (5min)")), BEAT_TIMEOUT); }),
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
      const label = dir.name === "." ? (isZh ? "根目录" : "root") : dir.name;
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
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(isZh ? `笺 [${label}] 执行超时 (5min)` : `Jian [${label}] timed out (5min)`)), BEAT_TIMEOUT); }),
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
