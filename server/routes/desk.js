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
import { execSync } from "child_process";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { parseSkillMetadata } from "../../lib/skills/skill-metadata.js";
import { t } from "../i18n.js";

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

export function createDeskRoute(engine, hub) {
  const route = new Hono();

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
  route.get("/desk/activities", async (c) => {
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
    return c.json({ activities: allActivities });
  });

  /** 读取指定活动的 session 对话消息（只读查看用） */
  route.get("/desk/activities/:id/session", async (c) => {
    const id = c.req.param("id");
    // 从所有 agent 的 activityStore 中查找
    const { entry, agentId: foundAgentId } = findActivityEntry(id);
    if (!entry) return c.json({ error: "activity not found" });
    if (!entry.sessionFile) return c.json({ error: "no session file" });

    const activityDir = path.join(engine.agentsDir, foundAgentId, "activity");
    const sessionPath = path.join(activityDir, entry.sessionFile);
    if (!fs.existsSync(sessionPath)) return c.json({ error: "session file missing" });

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

      return c.json({
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
      });
    } catch (err) {
      return c.json({ error: err.message });
    }
  });

  /** 将活动 session 提升为正常 session（从 activity/ 移到 sessions/） */
  route.post("/desk/activities/:id/promote", async (c) => {
    const id = c.req.param("id");
    const { entry, agentId: foundAgentId } = findActivityEntry(id);
    if (!entry) return c.json({ error: "activity not found" });
    if (!entry.sessionFile) return c.json({ error: "no session file" });

    // promote 需要先切到对应 agent（promoteActivitySession 操作当前焦点 agent 的目录）
    if (foundAgentId !== engine.currentAgentId) {
      return c.json({ error: t("error.activeSessionOnly") });
    }

    const newPath = engine.promoteActivitySession(entry.sessionFile);
    if (!newPath) return c.json({ error: "promote failed" });

    return c.json({ ok: true, sessionPath: newPath });
  });

  /** 用小工具模型快速摘要（DevTools 调试用） */
  route.post("/desk/activities/summarize", async (c) => {
    const body = await safeJson(c);
    const { id } = body;
    if (!id) return c.json({ error: "id required" });
    try {
      const summary = await engine.summarizeActivityQuick(id);
      return c.json({ summary: summary || null });
    } catch (err) {
      return c.json({ error: err.message });
    }
  });

  /** DevTools 日志（历史） */
  route.get("/desk/logs", async (c) => {
    return c.json({ logs: engine.getDevLogs() });
  });

  /** 手动触发心跳巡检（调试用） */
  route.post("/desk/heartbeat", async (c) => {
    const hb = hub?.scheduler?.heartbeat;
    if (!hb) return c.json({ error: "Heartbeat not initialized" });
    hb.triggerNow();
    return c.json({ ok: true, message: t("error.heartbeatTriggered") });
  });

  // ════════════════════════════
  //  Cron 任务
  // ════════════════════════════

  /** 列出 cron 任务 */
  route.get("/desk/cron", async (c) => {
    const store = engine.agent.cronStore;
    if (!store) return c.json({ jobs: [] });
    return c.json({ jobs: store.listJobs() });
  });

  /** 操作 cron 任务 */
  route.post("/desk/cron", async (c) => {
    const store = engine.agent.cronStore;
    if (!store) return c.json({ error: "Desk not initialized" });

    const body = await safeJson(c);
    const { action, ...params } = body;

    switch (action) {
      case "add": {
        if (!params.type || !params.schedule || !params.prompt) {
          return c.json({ error: "type, schedule, prompt required" });
        }
        const job = store.addJob(params);
        return c.json({ ok: true, job, jobs: store.listJobs() });
      }

      case "remove": {
        if (!params.id) return c.json({ error: "id required" });
        const ok = store.removeJob(params.id);
        if (!ok) return c.json({ error: "not found" });
        return c.json({ ok: true, jobs: store.listJobs() });
      }

      case "toggle": {
        if (!params.id) return c.json({ error: "id required" });
        const job = store.toggleJob(params.id);
        if (!job) return c.json({ error: "not found" });
        return c.json({ ok: true, job, jobs: store.listJobs() });
      }

      case "update": {
        if (!params.id) return c.json({ error: "id required" });
        const { id, ...fields } = params;
        const job = store.updateJob(id, fields);
        if (!job) return c.json({ error: "not found" });
        return c.json({ ok: true, job, jobs: store.listJobs() });
      }

      default:
        return c.json({ error: `unknown action: ${action}` });
    }
  });

  // ════════════════════════════
  //  工作空间文件（直接使用 cwd）
  // ════════════════════════════

  /** 扫描工作空间下的项目级技能 */
  route.get("/desk/skills", async (c) => {
    const dir = c.req.query("dir") ? decodeURIComponent(c.req.query("dir")) : engine.deskCwd;
    if (!dir) return c.json({ skills: [] });
    if (c.req.query("dir") && !isApprovedDir(dir, engine)) return c.json({ skills: [] });

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
            const meta = parseSkillMetadata(content, entry.name);
            results.push({
              name: meta.name,
              description: meta.description,
              source: label,
              dirPath: skillsDir,
              filePath: skillFile,
              baseDir: path.join(skillsDir, entry.name),
            });
          } catch {}
        }
      } catch {}
    }
    return c.json({ skills: results });
  });

  /**
   * 拖拽安装项目技能
   * 接收文件路径，自动创建 .agents/skills/ 并安装
   * 支持文件夹（直接复制）和 .zip/.skill（解压）
   */
  route.post("/desk/install-skill", async (c) => {
    const body = await safeJson(c);
    const { filePath, dir } = body;
    const cwd = dir || engine.deskCwd;
    if (!filePath || !cwd) {
      return c.json({ error: "filePath and active workspace required" }, 400);
    }

    try {
      const stat = fs.statSync(filePath);
      const skillsDir = path.join(cwd, ".agents", "skills");

      // 确保 .agents/skills/ 存在
      fs.mkdirSync(skillsDir, { recursive: true });

      // macOS: 隐藏 .agents 目录（chflags hidden）
      if (process.platform === "darwin") {
        const agentsDir = path.join(cwd, ".agents");
        try { execSync(`chflags hidden "${agentsDir}"`); } catch {}
      }

      if (stat.isDirectory()) {
        // 直接复制文件夹
        const destName = path.basename(filePath);
        const dest = path.join(skillsDir, destName);
        fs.cpSync(filePath, dest, { recursive: true });
        return c.json({ ok: true, name: destName });
      }

      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".zip" || ext === ".skill") {
        // 解压到 skills 目录
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
        return c.json({ ok: true, name: skillName });
      }

      return c.json({ error: "Unsupported file type. Use folder, .zip or .skill" }, 400);
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  /** 删除项目技能 */
  route.post("/desk/delete-skill", async (c) => {
    const body = await safeJson(c);
    const { skillDir } = body;
    if (!skillDir) {
      return c.json({ error: "skillDir is required" }, 400);
    }
    // 安全检查：必须在当前工作区的已知技能目录下
    const cwd = engine.deskCwd;
    if (!cwd) {
      return c.json({ error: "No active workspace" }, 400);
    }
    const ALLOWED_SKILL_SUBS = [
      ".claude/skills", ".codex/skills", ".openclaw/skills",
      ".agents/skills", ".pi/skills",
    ];
    const allowed = ALLOWED_SKILL_SUBS.some(sub =>
      isInsidePath(skillDir, path.join(cwd, sub))
    );
    if (!allowed) {
      return c.json({ error: "Only skills in current workspace skill directories can be deleted" }, 403);
    }
    try {
      fs.rmSync(skillDir, { recursive: true, force: true });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  /** 工作空间路径 */
  route.get("/desk/path", async (c) => {
    const dir = c.req.query("dir") ? decodeURIComponent(c.req.query("dir")) : engine.deskCwd;
    if (!dir) return c.json({ path: null });
    if (c.req.query("dir") && !isApprovedDir(dir, engine)) return c.json({ error: t("error.dirNotAllowed") });
    fs.mkdirSync(dir, { recursive: true });
    return c.json({ path: dir });
  });

  /** 列出工作空间文件（支持 ?subdir=xxx 浏览子目录, ?dir=xxx 覆盖基目录） */
  route.get("/desk/files", async (c) => {
    const dir = c.req.query("dir") ? decodeURIComponent(c.req.query("dir")) : engine.deskCwd;
    if (!dir) return c.json({ files: [], subdir: "", basePath: null });
    if (c.req.query("dir") && !isApprovedDir(dir, engine)) return c.json({ error: t("error.dirNotAllowed") });
    const subdir = c.req.query("subdir") || "";
    // 安全：禁止路径穿越
    if (subdir && (subdir.includes("\\") || subdir.includes("..") || subdir.startsWith("."))) {
      return c.json({ error: "invalid subdir" });
    }
    const target = subdir ? path.join(dir, subdir) : dir;
    if (!isInsidePath(target, dir)) return c.json({ error: "invalid path" });
    return c.json({ files: listWorkspaceFiles(target), subdir: subdir || "", basePath: dir });
  });

  /** 读取指定目录的 jian.md */
  route.get("/desk/jian", async (c) => {
    const dir = c.req.query("dir") ? decodeURIComponent(c.req.query("dir")) : engine.deskCwd;
    if (!dir) return c.json({ content: null });
    if (c.req.query("dir") && !isApprovedDir(dir, engine)) return c.json({ error: t("error.dirNotAllowed") });
    const subdir = c.req.query("subdir") || "";
    if (subdir && (subdir.includes("\\") || subdir.includes("..") || subdir.startsWith("."))) {
      return c.json({ error: "invalid subdir" });
    }
    const target = subdir ? path.join(dir, subdir) : dir;
    if (!isInsidePath(target, dir)) return c.json({ error: "invalid path" });
    const jianPath = path.join(target, "jian.md");
    if (!fs.existsSync(jianPath)) return c.json({ content: null });
    try {
      return c.json({ content: fs.readFileSync(jianPath, "utf-8") });
    } catch {
      return c.json({ content: null });
    }
  });

  /** 保存指定目录的 jian.md（自动创建 / 内容为空时删除） */
  route.post("/desk/jian", async (c) => {
    const body = await safeJson(c);
    const dir = body.dir ? body.dir : engine.deskCwd;
    if (!dir) return c.json({ error: t("error.noWorkspace") });
    if (body.dir && !isApprovedDir(dir, engine)) return c.json({ error: t("error.dirNotAllowed") });
    const { subdir, content } = body;
    const sub = subdir || "";
    if (sub && (sub.includes("\\") || sub.includes("..") || sub.startsWith("."))) {
      return c.json({ error: "invalid subdir" });
    }
    const target = sub ? path.join(dir, sub) : dir;
    if (!isInsidePath(target, dir)) return c.json({ error: "invalid path" });
    const jianPath = path.join(target, "jian.md");

    try {
      if (content === null || content === undefined || content.trim() === "") {
        // 内容为空 → 删除 jian.md
        if (fs.existsSync(jianPath)) fs.unlinkSync(jianPath);
        return c.json({ ok: true, content: null });
      }
      // 确保目录存在
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(jianPath, content, "utf-8");
      return c.json({ ok: true, content });
    } catch (err) {
      return c.json({ error: err.message });
    }
  });

  /** 工作空间文件操作（支持 subdir + dir override） */
  route.post("/desk/files", async (c) => {
    const body = await safeJson(c);
    const baseDir = body.dir || engine.deskCwd;
    if (!baseDir) return c.json({ error: t("error.noWorkspace") });
    if (body.dir && !isApprovedDir(baseDir, engine)) return c.json({ error: t("error.dirNotAllowed") });
    fs.mkdirSync(baseDir, { recursive: true });

    const { action, subdir: sub, paths, name, content, oldName, newName } = body;

    // 解析子目录
    const subdirStr = sub || "";
    if (subdirStr && (subdirStr.includes("\\") || subdirStr.includes("..") || subdirStr.startsWith("."))) {
      return c.json({ error: "invalid subdir" });
    }
    const dir = subdirStr ? path.join(baseDir, subdirStr) : baseDir;
    if (!isInsidePath(dir, baseDir)) return c.json({ error: "invalid path" });

    switch (action) {
      case "upload": {
        if (!Array.isArray(paths) || paths.length === 0) {
          return c.json({ error: "paths required" });
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
        return c.json({ ok: true, results, files: listWorkspaceFiles(dir) });
      }

      case "create": {
        if (!name || content === undefined) {
          return c.json({ error: "name and content required" });
        }
        const createTarget = path.join(dir, path.basename(name));
        if (!isInsidePath(createTarget, dir)) return c.json({ error: "invalid name" });
        fs.writeFileSync(createTarget, content, "utf-8");
        return c.json({ ok: true, files: listWorkspaceFiles(dir) });
      }

      case "mkdir": {
        if (!name) return c.json({ error: "name required" });
        const mkTarget = path.join(dir, path.basename(name));
        if (!isInsidePath(mkTarget, dir)) return c.json({ error: "invalid name" });
        if (fs.existsSync(mkTarget)) return c.json({ error: "already exists" });
        fs.mkdirSync(mkTarget, { recursive: true });
        return c.json({ ok: true, files: listWorkspaceFiles(dir) });
      }

      case "rename": {
        if (!oldName || !newName) return c.json({ error: "oldName and newName required" });
        const src = path.join(dir, path.basename(oldName));
        const dest = path.join(dir, path.basename(newName));
        if (!isInsidePath(src, dir) || !isInsidePath(dest, dir)) return c.json({ error: "invalid name" });
        if (!fs.existsSync(src)) return c.json({ error: "not found" });
        if (fs.existsSync(dest)) return c.json({ error: "target already exists" });
        fs.renameSync(src, dest);
        return c.json({ ok: true, files: listWorkspaceFiles(dir) });
      }

      case "move": {
        const names = body.names;
        const destFolder = body.destFolder;
        if (!Array.isArray(names) || names.length === 0 || !destFolder) {
          return c.json({ error: "names[] and destFolder required" });
        }
        if (names.includes(destFolder)) {
          return c.json({ error: "cannot move folder into itself" });
        }
        const destDir = path.join(dir, path.basename(destFolder));
        if (!isInsidePath(destDir, dir)) return c.json({ error: "invalid destFolder" });
        if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
          return c.json({ error: "destFolder is not a directory" });
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
        return c.json({ ok: true, results, files: listWorkspaceFiles(dir) });
      }

      case "remove": {
        if (!name) return c.json({ error: "name required" });
        const rmTarget = path.join(dir, path.basename(name));
        if (!isInsidePath(rmTarget, dir)) return c.json({ error: "invalid name" });
        if (!fs.existsSync(rmTarget)) return c.json({ error: "not found" });
        fs.rmSync(rmTarget, { recursive: true, force: true });
        return c.json({ ok: true, files: listWorkspaceFiles(dir) });
      }

      default:
        return c.json({ error: `unknown action: ${action}` });
    }
  });

  return route;
}
