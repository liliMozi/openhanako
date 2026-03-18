/**
 * desk.js — Desk 系统 REST API
 *
 * 提供 cron 任务、工作空间文件的 HTTP 接口。
 * 前端通过这些接口直接操作（不经过 agent/LLM），
 * agent 通过 tool 操作（走 WebSocket 推送更新）。
 */

import fs from "fs";
import path from "path";
import os from "os";

/** 解析真实路径（跟踪 symlink），失败返回 null */
function realPath(p) {
  try { return fs.realpathSync(path.resolve(p)); }
  catch { return null; }
}

/** 安全路径校验：target 必须在 baseDir 内部（解析 symlink 后比较） */
function isInsidePath(target, baseDir) {
  const base = realPath(baseDir);
  if (!base) return false;
  const resolved = realPath(target);
  if (resolved) return resolved === base || resolved.startsWith(base + path.sep);
  // 路径不存在（mkdir / rename 目标）：解析父目录 + 保留 basename
  const parentResolved = realPath(path.dirname(target));
  if (!parentResolved) return false;
  const full = path.join(parentResolved, path.basename(target));
  return full === base || full.startsWith(base + path.sep);
}

/** 校验 dir 覆盖：仅允许 engine 已知的根目录（解析 symlink 后比较） */
function isApprovedDir(dir, engine) {
  const approved = [
    engine.deskCwd,
    engine.homeCwd,
    os.homedir(),
  ].filter(Boolean);
  const resolved = realPath(dir);
  if (!resolved) return false;
  return approved.some(root => {
    const r = realPath(root);
    if (!r) return false;
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

/** 敏感 dot 目录（不允许 upload 从这些目录复制文件） */
const SENSITIVE_DIRS = [".ssh", ".gnupg", ".aws", ".config/gcloud", ".kube"];

function isSensitivePath(srcPath, hanakoHome) {
  const resolved = realPath(srcPath);
  if (!resolved) return true; // fail-closed
  const home = os.homedir();
  for (const d of SENSITIVE_DIRS) {
    const sensitive = path.join(home, d);
    if (resolved === sensitive || resolved.startsWith(sensitive + path.sep)) return true;
  }
  if (hanakoHome) {
    const realHome = realPath(hanakoHome);
    if (realHome && (resolved === realHome || resolved.startsWith(realHome + path.sep))) return true;
  }
  return false;
}

/** 列出工作空间目录下的文件 */
function listWorkspaceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith("."))
    .map(e => {
      const fullPath = path.join(dir, e.name);
      const stat = fs.statSync(fullPath);
      return {
        name: e.name,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        isDir: e.isDirectory(),
      };
    })
    .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
}

export default async function deskRoute(app, { engine, hub }) {

  /** 从所有 agent 的 activityStore 中按 ID 查找 entry */
  function findActivityEntry(activityId) {
    for (const ag of engine.listAgents()) {
      const store = engine.getActivityStore(ag.id);
      const entry = store?.get(activityId);
      if (entry) return { entry, agentId: ag.id };
    }
    return { entry: null, agentId: null };
  }

  // ════════════════════════════
  //  助手活动
  // ════════════════════════════

  /** 活动列表（合并所有 agent） */
  app.get("/api/desk/activities", async () => {
    const allActivities = [];
    for (const ag of engine.listAgents()) {
      const store = engine.getActivityStore(ag.id);
      const items = store?.list() || [];
      for (const a of items) {
        allActivities.push({
          ...a,
          agentId: a.agentId || ag.id,
          agentName: a.agentName || ag.name,
        });
      }
    }
    // 按 startedAt 倒序
    allActivities.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return { activities: allActivities };
  });

  /** 读取指定活动的 session 对话消息（只读查看用） */
  app.get("/api/desk/activities/:id/session", async (req) => {
    const { id } = req.params;
    // 从所有 agent 的 activityStore 中查找
    const { entry, agentId: foundAgentId } = findActivityEntry(id);
    if (!entry) return { error: "activity not found" };
    if (!entry.sessionFile) return { error: "no session file" };

    const activityDir = path.join(engine.agentsDir, foundAgentId, "activity");
    const sessionPath = path.join(activityDir, entry.sessionFile);
    if (!fs.existsSync(sessionPath)) return { error: "session file missing" };

    try {
      const raw = fs.readFileSync(sessionPath, "utf-8");
      const lines = raw.trim().split("\n").map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);

      const messages = [];
      for (const line of lines) {
        if (line.type !== "message") continue;
        const msg = line.message;
        if (!msg) continue;
        if (msg.role !== "user" && msg.role !== "assistant") continue;

        const content = Array.isArray(msg.content)
          ? msg.content.filter(b => b.type === "text" && b.text).map(b => b.text).join("")
          : (typeof msg.content === "string" ? msg.content : "");

        if (!content) continue;
        messages.push({ role: msg.role, content });
      }

      return {
        activity: {
          id: entry.id,
          type: entry.type,
          label: entry.label || null,
          agentId: entry.agentId || foundAgentId,
          agentName: entry.agentName || engine.getAgent(foundAgentId)?.agentName || foundAgentId,
          summary: entry.summary,
          startedAt: entry.startedAt,
          finishedAt: entry.finishedAt,
        },
        messages,
      };
    } catch (err) {
      return { error: err.message };
    }
  });

  /** 将活动 session 提升为正常 session（从 activity/ 移到 sessions/） */
  app.post("/api/desk/activities/:id/promote", async (req) => {
    const { id } = req.params;
    const { entry, agentId: foundAgentId } = findActivityEntry(id);
    if (!entry) return { error: "activity not found" };
    if (!entry.sessionFile) return { error: "no session file" };

    // promote 需要先切到对应 agent（promoteActivitySession 操作当前焦点 agent 的目录）
    if (foundAgentId !== engine.currentAgentId) {
      return { error: "只能提升当前助手的活动 session" };
    }

    const newPath = engine.promoteActivitySession(entry.sessionFile);
    if (!newPath) return { error: "promote failed" };

    return { ok: true, sessionPath: newPath };
  });

  /** 用小工具模型快速摘要（DevTools 调试用） */
  app.post("/api/desk/activities/summarize", async (req) => {
    const { id } = req.body || {};
    if (!id) return { error: "id required" };
    try {
      const summary = await engine.summarizeActivityQuick(id);
      return { summary: summary || null };
    } catch (err) {
      return { error: err.message };
    }
  });

  /** DevTools 日志（历史） */
  app.get("/api/desk/logs", async () => {
    return { logs: engine.getDevLogs() };
  });

  /** 手动触发心跳巡检（调试用） */
  app.post("/api/desk/heartbeat", async () => {
    const hb = hub?.scheduler?.heartbeat;
    if (!hb) return { error: "Heartbeat 未初始化" };
    hb.triggerNow();
    return { ok: true, message: "心跳已触发" };
  });

  // ════════════════════════════
  //  Cron 任务
  // ════════════════════════════

  /** 列出 cron 任务 */
  app.get("/api/desk/cron", async () => {
    const store = engine.agent.cronStore;
    if (!store) return { jobs: [] };
    return { jobs: store.listJobs() };
  });

  /** 操作 cron 任务 */
  app.post("/api/desk/cron", async (req) => {
    const store = engine.agent.cronStore;
    if (!store) return { error: "Desk 未初始化" };

    const { action, ...params } = req.body || {};

    switch (action) {
      case "add": {
        if (!params.type || !params.schedule || !params.prompt) {
          return { error: "type, schedule, prompt required" };
        }
        const job = store.addJob(params);
        return { ok: true, job, jobs: store.listJobs() };
      }

      case "remove": {
        if (!params.id) return { error: "id required" };
        const ok = store.removeJob(params.id);
        if (!ok) return { error: "not found" };
        return { ok: true, jobs: store.listJobs() };
      }

      case "toggle": {
        if (!params.id) return { error: "id required" };
        const job = store.toggleJob(params.id);
        if (!job) return { error: "not found" };
        return { ok: true, job, jobs: store.listJobs() };
      }

      case "update": {
        if (!params.id) return { error: "id required" };
        const { id, ...fields } = params;
        const job = store.updateJob(id, fields);
        if (!job) return { error: "not found" };
        return { ok: true, job, jobs: store.listJobs() };
      }

      default:
        return { error: `unknown action: ${action}` };
    }
  });

  // ════════════════════════════
  //  工作空间文件（直接使用 cwd）
  // ════════════════════════════

  /** 扫描工作空间下的项目级技能 */
  app.get("/api/desk/skills", async (req) => {
    const dir = req.query.dir ? decodeURIComponent(req.query.dir) : engine.deskCwd;
    if (!dir) return { skills: [] };
    if (req.query.dir && !isApprovedDir(dir, engine)) return { skills: [] };

    const CWD_SKILL_DIRS = [
      { sub: ".claude/skills",   label: "Claude Code" },
      { sub: ".codex/skills",    label: "Codex" },
      { sub: ".openclaw/skills", label: "OpenClaw" },
      { sub: ".agents/skills",   label: "Agents" },
      { sub: ".pi/skills",       label: "Pi" },
    ];

    const results = [];
    for (const { sub, label } of CWD_SKILL_DIRS) {
      const skillsDir = path.join(dir, sub);
      if (!fs.existsSync(skillsDir)) continue;
      try {
        for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
          if (!fs.existsSync(skillFile)) continue;
          try {
            const content = fs.readFileSync(skillFile, "utf-8");
            const nameMatch = content.match(/^name:\s*(.+?)\s*$/m);
            const descMatch = content.match(/^description:\s*(.+?)\s*$/m);
            results.push({
              name: nameMatch ? nameMatch[1].replace(/["']/g, "") : entry.name,
              description: descMatch ? descMatch[1].replace(/["']/g, "") : "",
              source: label,
              dirPath: skillsDir,
              filePath: skillFile,
              baseDir: path.join(skillsDir, entry.name),
            });
          } catch {}
        }
      } catch {}
    }
    return { skills: results };
  });

  /**
   * 拖拽安装项目技能
   * 接收文件路径，自动创建 .agents/skills/ 并安装
   * 支持文件夹（直接复制）和 .zip/.skill（解压）
   */
  app.post("/api/desk/install-skill", async (req, reply) => {
    const { filePath } = req.body || {};
    const cwd = engine.deskCwd;
    if (!filePath || !cwd) {
      reply.code(400);
      return { error: "filePath and active workspace required" };
    }

    try {
      const stat = fs.statSync(filePath);
      const skillsDir = path.join(cwd, ".agents", "skills");

      // 确保 .agents/skills/ 存在
      fs.mkdirSync(skillsDir, { recursive: true });

      // macOS: 隐藏 .agents 目录（chflags hidden）
      if (process.platform === "darwin") {
        const agentsDir = path.join(cwd, ".agents");
        try { require("child_process").execSync(`chflags hidden "${agentsDir}"`); } catch {}
      }

      if (stat.isDirectory()) {
        // 直接复制文件夹
        const destName = path.basename(filePath);
        const dest = path.join(skillsDir, destName);
        fs.cpSync(filePath, dest, { recursive: true });
        return { ok: true, name: destName };
      }

      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".zip" || ext === ".skill") {
        // 解压到 skills 目录
        const { execSync } = require("child_process");
        // 先解压到临时目录确认内容
        const tmpDir = path.join(skillsDir, `_tmp_${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        execSync(`unzip -o -q "${filePath}" -d "${tmpDir}"`);

        // 检查解压结果：如果只有一个子目录，用那个；否则用文件名
        const entries = fs.readdirSync(tmpDir).filter(e => !e.startsWith("."));
        let skillName;
        if (entries.length === 1 && fs.statSync(path.join(tmpDir, entries[0])).isDirectory()) {
          // 单目录包：移动到 skills
          skillName = entries[0];
          const dest = path.join(skillsDir, skillName);
          if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
          fs.renameSync(path.join(tmpDir, skillName), dest);
          fs.rmSync(tmpDir, { recursive: true });
        } else {
          // 散文件包：整个 tmp 目录就是技能
          skillName = path.basename(filePath, ext);
          const dest = path.join(skillsDir, skillName);
          if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
          fs.renameSync(tmpDir, dest);
        }
        return { ok: true, name: skillName };
      }

      reply.code(400);
      return { error: "Unsupported file type. Use folder, .zip or .skill" };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  /** 工作空间路径 */
  app.get("/api/desk/path", async (req) => {
    const dir = req.query.dir ? decodeURIComponent(req.query.dir) : engine.deskCwd;
    if (!dir) return { path: null };
    if (req.query.dir && !isApprovedDir(dir, engine)) return { error: "目录不在允许范围内" };
    fs.mkdirSync(dir, { recursive: true });
    return { path: dir };
  });

  /** 列出工作空间文件（支持 ?subdir=xxx 浏览子目录, ?dir=xxx 覆盖基目录） */
  app.get("/api/desk/files", async (req) => {
    const dir = req.query.dir ? decodeURIComponent(req.query.dir) : engine.deskCwd;
    if (!dir) return { files: [], subdir: "", basePath: null };
    if (req.query.dir && !isApprovedDir(dir, engine)) return { error: "目录不在允许范围内" };
    const subdir = req.query.subdir || "";
    // 安全：禁止路径穿越
    if (subdir && (subdir.includes("\\") || subdir.includes("..") || subdir.startsWith("."))) {
      return { error: "invalid subdir" };
    }
    const target = subdir ? path.join(dir, subdir) : dir;
    if (!isInsidePath(target, dir)) return { error: "invalid path" };
    return { files: listWorkspaceFiles(target), subdir: subdir || "", basePath: dir };
  });

  /** 读取指定目录的 jian.md */
  app.get("/api/desk/jian", async (req) => {
    const dir = req.query.dir ? decodeURIComponent(req.query.dir) : engine.deskCwd;
    if (!dir) return { content: null };
    if (req.query.dir && !isApprovedDir(dir, engine)) return { error: "目录不在允许范围内" };
    const subdir = req.query.subdir || "";
    if (subdir && (subdir.includes("\\") || subdir.includes("..") || subdir.startsWith("."))) {
      return { error: "invalid subdir" };
    }
    const target = subdir ? path.join(dir, subdir) : dir;
    if (!isInsidePath(target, dir)) return { error: "invalid path" };
    const jianPath = path.join(target, "jian.md");
    if (!fs.existsSync(jianPath)) return { content: null };
    try {
      return { content: fs.readFileSync(jianPath, "utf-8") };
    } catch {
      return { content: null };
    }
  });

  /** 保存指定目录的 jian.md（自动创建 / 内容为空时删除） */
  app.post("/api/desk/jian", async (req) => {
    const dir = req.body?.dir ? req.body.dir : engine.deskCwd;
    if (!dir) return { error: "未设置工作空间" };
    if (req.body?.dir && !isApprovedDir(dir, engine)) return { error: "目录不在允许范围内" };
    const { subdir, content } = req.body || {};
    const sub = subdir || "";
    if (sub && (sub.includes("\\") || sub.includes("..") || sub.startsWith("."))) {
      return { error: "invalid subdir" };
    }
    const target = sub ? path.join(dir, sub) : dir;
    if (!isInsidePath(target, dir)) return { error: "invalid path" };
    const jianPath = path.join(target, "jian.md");

    try {
      if (content === null || content === undefined || content.trim() === "") {
        // 内容为空 → 删除 jian.md
        if (fs.existsSync(jianPath)) fs.unlinkSync(jianPath);
        return { ok: true, content: null };
      }
      // 确保目录存在
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(jianPath, content, "utf-8");
      return { ok: true, content };
    } catch (err) {
      return { error: err.message };
    }
  });

  /** 工作空间文件操作（支持 subdir + dir override） */
  app.post("/api/desk/files", async (req) => {
    const baseDir = req.body?.dir || engine.deskCwd;
    if (!baseDir) return { error: "未设置工作空间" };
    if (req.body?.dir && !isApprovedDir(baseDir, engine)) return { error: "目录不在允许范围内" };
    fs.mkdirSync(baseDir, { recursive: true });

    const { action, subdir: sub, paths, name, content, oldName, newName } = req.body || {};

    // 解析子目录
    const subdirStr = sub || "";
    if (subdirStr && (subdirStr.includes("\\") || subdirStr.includes("..") || subdirStr.startsWith("."))) {
      return { error: "invalid subdir" };
    }
    const dir = subdirStr ? path.join(baseDir, subdirStr) : baseDir;
    if (!isInsidePath(dir, baseDir)) return { error: "invalid path" };

    switch (action) {
      case "upload": {
        if (!Array.isArray(paths) || paths.length === 0) {
          return { error: "paths required" };
        }
        const results = [];
        for (const srcPath of paths) {
          try {
            if (!path.isAbsolute(srcPath) || !fs.existsSync(srcPath)) {
              results.push({ src: srcPath, error: "invalid path" });
              continue;
            }
            if (isSensitivePath(srcPath, engine.hanakoHome)) {
              results.push({ src: srcPath, error: "sensitive path blocked" });
              continue;
            }
            const fname = path.basename(srcPath);
            const dest = path.join(dir, fname);
            const stat = fs.statSync(srcPath);
            if (stat.isDirectory()) {
              fs.cpSync(srcPath, dest, { recursive: true });
            } else {
              fs.copyFileSync(srcPath, dest);
            }
            results.push({ src: srcPath, name: fname });
          } catch (err) {
            results.push({ src: srcPath, error: err.message });
          }
        }
        return { ok: true, results, files: listWorkspaceFiles(dir) };
      }

      case "create": {
        if (!name || content === undefined) {
          return { error: "name and content required" };
        }
        const createTarget = path.join(dir, path.basename(name));
        if (!isInsidePath(createTarget, dir)) return { error: "invalid name" };
        fs.writeFileSync(createTarget, content, "utf-8");
        return { ok: true, files: listWorkspaceFiles(dir) };
      }

      case "mkdir": {
        if (!name) return { error: "name required" };
        const mkTarget = path.join(dir, path.basename(name));
        if (!isInsidePath(mkTarget, dir)) return { error: "invalid name" };
        if (fs.existsSync(mkTarget)) return { error: "already exists" };
        fs.mkdirSync(mkTarget, { recursive: true });
        return { ok: true, files: listWorkspaceFiles(dir) };
      }

      case "rename": {
        if (!oldName || !newName) return { error: "oldName and newName required" };
        const src = path.join(dir, path.basename(oldName));
        const dest = path.join(dir, path.basename(newName));
        if (!isInsidePath(src, dir) || !isInsidePath(dest, dir)) return { error: "invalid name" };
        if (!fs.existsSync(src)) return { error: "not found" };
        if (fs.existsSync(dest)) return { error: "target already exists" };
        fs.renameSync(src, dest);
        return { ok: true, files: listWorkspaceFiles(dir) };
      }

      case "move": {
        const names = req.body?.names;
        const destFolder = req.body?.destFolder;
        if (!Array.isArray(names) || names.length === 0 || !destFolder) {
          return { error: "names[] and destFolder required" };
        }
        if (names.includes(destFolder)) {
          return { error: "cannot move folder into itself" };
        }
        const destDir = path.join(dir, path.basename(destFolder));
        if (!isInsidePath(destDir, dir)) return { error: "invalid destFolder" };
        if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
          return { error: "destFolder is not a directory" };
        }
        const results = [];
        for (const n of names) {
          const src = path.join(dir, path.basename(n));
          const dest = path.join(destDir, path.basename(n));
          if (!isInsidePath(src, dir)) { results.push({ name: n, error: "invalid name" }); continue; }
          if (!fs.existsSync(src)) { results.push({ name: n, error: "not found" }); continue; }
          if (fs.existsSync(dest)) { results.push({ name: n, error: "target already exists" }); continue; }
          try {
            fs.renameSync(src, dest);
            results.push({ name: n, ok: true });
          } catch (err) {
            results.push({ name: n, error: err.message });
          }
        }
        return { ok: true, results, files: listWorkspaceFiles(dir) };
      }

      case "remove": {
        if (!name) return { error: "name required" };
        const rmTarget = path.join(dir, path.basename(name));
        if (!isInsidePath(rmTarget, dir)) return { error: "invalid name" };
        if (!fs.existsSync(rmTarget)) return { error: "not found" };
        fs.rmSync(rmTarget, { recursive: true, force: true });
        return { ok: true, files: listWorkspaceFiles(dir) };
      }

      default:
        return { error: `unknown action: ${action}` };
    }
  });
}
