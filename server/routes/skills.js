/**
 * Skills 管理路由
 *
 * GET    /skills              — 列出所有可用 skill（含当前 agent 的 enabled 状态）
 * PUT    /agents/:id/skills   — 更新指定 agent 的 enabled skills 列表
 * POST   /skills/install      — 安装用户技能（文件夹路径 / .zip / .skill）
 * DELETE /skills/:name        — 删除用户技能
 */
import path from "path";
import fs from "fs";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { extractZip } from "../../lib/extract-zip.js";
import { saveConfig } from "../../lib/memory/config-loader.js";
import { sanitizeSkillName, safetyReview } from "../../lib/tools/install-skill.js";
import { t } from "../i18n.js";
import { safeCopyDir } from "../../shared/safe-fs.js";
import { resolveAgent } from "../utils/resolve-agent.js";
import { validateId, agentExists } from "../utils/validation.js";

/** 从 SKILL.md frontmatter 解析 name */
function parseSkillName(skillMdPath) {
  try {
    const content = fs.readFileSync(skillMdPath, "utf-8");
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
    return nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : null;
  } catch {
    return null;
  }
}

/** 递归删除目录 */
function rmDirSync(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function createSkillsRoute(engine) {
  const route = new Hono();

  // 安装/删除/reload 共享互斥锁，防止 reloadSkills() 并发导致 500
  let _installLock = Promise.resolve();
  function withInstallLock(fn) {
    const prev = _installLock;
    let resolve;
    _installLock = new Promise(r => { resolve = r; });
    return prev.then(fn).finally(resolve);
  }

  route.get("/skills", async (c) => {
    try {
      const agentId = c.req.query("agentId");
      const runtime = c.req.query("runtime") === "1";
      // 必须显式指定 agentId — 不允许从全局焦点指针推导，避免前后端 agent 错位
      // 后用户在 desk 上 toggle skill 时把错位 agent 的列表写入当前 agent (#397)
      if (!agentId) {
        return c.json({ error: "agentId is required" }, 400);
      }
      if (!validateId(agentId) || !agentExists(engine, agentId)) {
        return c.json({ error: "agent not found" }, 404);
      }
      return c.json({
        skills: runtime ? engine.getRuntimeSkills(agentId) : engine.getAllSkills(agentId),
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/agents/:id/skills", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const body = await safeJson(c);
      const { enabled } = body;
      if (!Array.isArray(enabled)) {
        return c.json({ error: "enabled must be an array of skill names" }, 400);
      }

      // 防御性过滤：把请求体里的 enabled 与该 agent 实际可见的 skill 集合做交集，
      // 防止前端因 store 错位（例如 agent 切换 race）把别的 agent 的列表写进来 (#397)
      const visible = engine.getAllSkills(id).map(s => s.name);
      const visibleSet = new Set(visible);
      const filtered = enabled.filter(name => visibleSet.has(name));

      const partial = { skills: { enabled: filtered } };

      // 走 engine.updateConfig (ConfigCoordinator)，它会在 partial.skills 存在时
      // 调用 syncAgentSkills 把新 enabled 列表同步到 agent 的内存态和 system prompt。
      // 直接调 agent.updateConfig 会绕过这一步，导致写盘成功但内存未刷新。
      const agent = engine.getAgent(id);
      if (agent) {
        await engine.updateConfig(partial, { agentId: id });
      } else {
        const configPath = path.join(engine.agentsDir, id, "config.yaml");
        saveConfig(configPath, partial);
      }

      return c.json({ ok: true, enabled: filtered });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 安装用户技能 ──
  route.post("/skills/install", async (c) => {
    return withInstallLock(async () => {
    try {
      const body = await safeJson(c);
      const { path: srcPath } = body;
      if (!srcPath || !path.isAbsolute(srcPath)) {
        return c.json({ error: t("error.skillNeedAbsolutePath") }, 400);
      }

      if (!fs.existsSync(srcPath)) {
        return c.json({ error: t("error.skillPathNotExists") }, 400);
      }

      const userDir = engine.userSkillsDir;
      const stat = fs.statSync(srcPath);

      let skillDir; // 最终包含 SKILL.md 的目录

      if (stat.isDirectory()) {
        // 直接是文件夹
        if (!fs.existsSync(path.join(srcPath, "SKILL.md"))) {
          return c.json({ error: t("error.skillMissingSkillMd") }, 400);
        }
        skillDir = srcPath;
      } else {
        // .zip 或 .skill 文件
        const ext = path.extname(srcPath).toLowerCase();
        if (ext !== ".zip" && ext !== ".skill") {
          return c.json({ error: t("error.skillUnsupportedFormat") }, 400);
        }

        // 解压到临时目录
        const tmpDir = path.join(userDir, ".tmp-install-" + Date.now());
        fs.mkdirSync(tmpDir, { recursive: true });
        try {
          extractZip(srcPath, tmpDir);

          // 找到 SKILL.md：可能在根目录或一层子目录内
          if (fs.existsSync(path.join(tmpDir, "SKILL.md"))) {
            skillDir = tmpDir;
          } else {
            const sub = fs.readdirSync(tmpDir, { withFileTypes: true })
              .filter(e => e.isDirectory() && !e.name.startsWith("."));
            const found = sub.find(e => fs.existsSync(path.join(tmpDir, e.name, "SKILL.md")));
            if (found) {
              skillDir = path.join(tmpDir, found.name);
            } else {
              rmDirSync(tmpDir);
              return c.json({ error: t("error.skillMissingSkillMdInZip") }, 400);
            }
          }
        } catch (err) {
          rmDirSync(tmpDir);
          return c.json({ error: t("error.skillExtractFailed", { msg: err.message }) }, 400);
        }
      }

      // 解析技能名称
      const skillName = parseSkillName(path.join(skillDir, "SKILL.md"));
      if (!skillName) {
        // 清理临时目录
        if (skillDir !== srcPath) rmDirSync(path.dirname(skillDir) === userDir ? skillDir : path.join(userDir, ".tmp-install-" + Date.now()));
        return c.json({ error: t("error.skillMissingName") }, 400);
      }

      // 安全校验名称
      const safeName = sanitizeSkillName(skillName);
      if (!safeName) {
        return c.json({ error: t("error.skillNameInvalid", { name: skillName }) }, 400);
      }

      // 手动安装（用户行为）不做安全审查，直接放行

      // 复制到用户技能目录
      const dstDir = path.join(userDir, safeName);
      if (skillDir === srcPath) {
        // 文件夹模式：复制
        safeCopyDir(skillDir, dstDir);
      } else {
        // zip 解压模式：移动（从临时目录）
        if (fs.existsSync(dstDir)) rmDirSync(dstDir);
        fs.renameSync(skillDir, dstDir);
        // 清理临时目录残留
        const tmpParent = skillDir.includes(".tmp-install-")
          ? (path.dirname(skillDir).includes(".tmp-install-") ? path.dirname(skillDir) : null)
          : path.dirname(skillDir);
        // 简单处理：找到 .tmp-install- 前缀的目录并清理
        for (const entry of fs.readdirSync(userDir)) {
          if (entry.startsWith(".tmp-install-")) {
            rmDirSync(path.join(userDir, entry));
          }
        }
      }

      // 重新加载 skills
      await engine.reloadSkills();

      // 可选：如果传了 agentId 就顺便加入该 agent 的 enabled 列表（历史行为）。
      // 新布局下 SkillsTab 顶部"技能管理"区走全局安装（不传 agentId），只做
      // 文件注册；用户自己到 Agent 配置区打开开关。原则：全局的管全局的。
      const agentId = c.req.query("agentId");
      if (agentId) {
        const configPath = path.join(engine.agentsDir, agentId, "config.yaml");
        if (fs.existsSync(configPath)) {
          const { loadConfig } = await import("../../lib/memory/config-loader.js");
          const cfg = loadConfig(configPath);
          const enabled = new Set(cfg?.skills?.enabled || []);
          enabled.add(safeName);
          // 走 ConfigCoordinator 路径：写盘 + syncAgentSkills 同步内存态
          // 必须传 agentId，否则 fallback 到焦点 agent 会同步错对象 (#397)
          await engine.updateConfig({ skills: { enabled: [...enabled] } }, { agentId });
        }
      }

      // 返回 skill 详情：有 agentId 就取该 agent 视角，没有就 fallback 到焦点
      const viewAgentId = agentId || engine.currentAgentId || "";
      const skill = viewAgentId
        ? engine.getAllSkills(viewAgentId).find(s => s.name === safeName)
        : null;
      return c.json({
        ok: true,
        skill: skill || { name: safeName, type: "user" },
      });
    } catch (err) {
      console.error("[skills] install failed:", err);
      return c.json({ error: err.message }, 500);
    }
    }); // withInstallLock
  });

  // ── 外部兼容技能路径 ──
  route.get("/skills/external-paths", async (c) => {
    try {
      return c.json(engine.getExternalSkillPaths());
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/skills/external-paths", async (c) => {
    try {
      const body = await safeJson(c);
      const { paths } = body;
      if (!Array.isArray(paths)) {
        return c.json({ error: "paths must be an array" }, 400);
      }
      for (const p of paths) {
        if (!path.isAbsolute(p)) {
          return c.json({ error: t("error.skillPathMustBeAbsolute", { path: p }) }, 400);
        }
        if (path.resolve(p) === path.resolve(engine.skillsDir)) {
          return c.json({ error: t("error.skillCannotAddSelfDir") }, 400);
        }
      }
      await engine.setExternalSkillPaths(paths);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 删除技能 ──
  route.delete("/skills/:name", async (c) => {
    return withInstallLock(async () => {
    try {
      const name = c.req.param("name");
      if (!sanitizeSkillName(name)) {
        return c.json({ error: t("error.skillInvalidName") }, 400);
      }

      // SkillsTab 的 per-agent selector 会显式带上 agentId,此时必须严格按该 agent
      // 定位 learned-skills 目录,不能 fallback 到焦点 agent(#419 cross-agent 串删)。
      // 历史调用方(无 query 参数)仍走 resolveAgent 保持兼容。
      const queryAgentId = c.req.query("agentId");
      let targetAgentId;
      let agentDir;
      if (queryAgentId) {
        if (!validateId(queryAgentId) || !agentExists(engine, queryAgentId)) {
          return c.json({ error: "agent not found" }, 404);
        }
        targetAgentId = queryAgentId;
        agentDir = engine.getAgent(queryAgentId)?.agentDir
          || path.join(engine.agentsDir, queryAgentId);
      } else {
        const resolved = resolveAgent(engine, c);
        agentDir = resolved?.agentDir;
        targetAgentId = agentDir ? path.basename(agentDir) : "";
      }

      // 外部技能不可删除（用该 agent 的视角查 readonly 即可，与 enabled 无关）
      const allSkills = targetAgentId ? engine.getAllSkills(targetAgentId) : [];
      const target = allSkills.find(s => s.name === name);
      if (target?.readonly) {
        return c.json({ error: t("error.skillExternalCannotDelete") }, 403);
      }

      // 优先查用户技能目录，再查 agent 自学目录
      const userSkillPath = path.join(engine.skillsDir, name);
      const learnedSkillPath = agentDir ? path.join(agentDir, "learned-skills", name) : null;

      let skillPath;
      if (fs.existsSync(userSkillPath)) {
        skillPath = userSkillPath;
      } else if (learnedSkillPath && fs.existsSync(learnedSkillPath)) {
        skillPath = learnedSkillPath;
      } else {
        return c.json({ error: t("error.skillNotExists") }, 404);
      }

      // 删除目录
      rmDirSync(skillPath);

      // 从所有 agent 的 enabled 列表中移除
      const agentsDir = engine.agentsDir;
      for (const agentName of fs.readdirSync(agentsDir)) {
        const configPath = path.join(agentsDir, agentName, "config.yaml");
        if (!fs.existsSync(configPath)) continue;
        try {
          const { loadConfig } = await import("../../lib/memory/config-loader.js");
          const cfg = loadConfig(configPath);
          const enabled = cfg?.skills?.enabled;
          if (Array.isArray(enabled) && enabled.includes(name)) {
            const filtered = enabled.filter(n => n !== name);
            saveConfig(configPath, { skills: { enabled: filtered } });
          }
        } catch (e) {
          console.error(`[skills] 清理 agent ${agentName} 的 skill 引用失败:`, e.message);
        }
      }

      // 重新加载 skills
      await engine.reloadSkills();

      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
    }); // withInstallLock
  });

  // POST /skills/reload — 强制重新加载所有技能
  route.post("/skills/reload", async (c) => {
    return withInstallLock(async () => {
    try {
      await engine.reloadSkills();
      // 不返回 skills 列表（缺乏 agent 上下文），前端会 fallback 到 GET /skills?agentId=X
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
    }); // withInstallLock
  });

  // POST /skills/translate — 用工具模型翻译技能名
  route.post("/skills/translate", async (c) => {
    const body = await safeJson(c);
    const { names, lang } = body;
    if (!Array.isArray(names) || !lang || lang === "en") {
      return c.json({});
    }
    return c.json(await engine.translateSkillNames(names, lang));
  });

  return route;
}
