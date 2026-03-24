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

function validateId(id) {
  return id && !id.includes("..") && !id.includes("/") && !id.includes("\\");
}

function agentExists(engine, id) {
  return fs.existsSync(path.join(engine.agentsDir, id, "config.yaml"));
}

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

/** 递归复制目录 */
function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

/** 递归删除目录 */
function rmDirSync(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function createSkillsRoute(engine) {
  const route = new Hono();

  route.get("/skills", async (c) => {
    try {
      const agentId = c.req.query("agentId");
      return c.json({ skills: engine.getAllSkills(agentId || undefined) });
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

      const partial = { skills: { enabled } };
      const configPath = path.join(engine.agentsDir, id, "config.yaml");
      saveConfig(configPath, partial);

      // active agent 需要额外触发 skill 同步
      if (id === engine.currentAgentId) {
        await engine.updateConfig(partial);
      }

      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 安装用户技能 ──
  route.post("/skills/install", async (c) => {
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

      // 重新加载 skills 并自动启用
      await engine.reloadSkills();

      // 将新技能加入当前 agent 的 enabled 列表
      const agentId = engine.currentAgentId;
      if (agentId) {
        const configPath = path.join(engine.agentsDir, agentId, "config.yaml");
        if (fs.existsSync(configPath)) {
          const { loadConfig } = await import("../../lib/memory/config-loader.js");
          const cfg = loadConfig(configPath);
          const enabled = new Set(cfg?.skills?.enabled || []);
          enabled.add(safeName);
          saveConfig(configPath, { skills: { enabled: [...enabled] } });
          // 同步 engine 内存状态
          await engine.updateConfig({ skills: { enabled: [...enabled] } });
        }
      }

      const skill = engine.getAllSkills().find(s => s.name === safeName);
      return c.json({
        ok: true,
        skill: skill || { name: safeName, type: "user" },
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
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
    try {
      const name = c.req.param("name");
      if (!sanitizeSkillName(name)) {
        return c.json({ error: t("error.skillInvalidName") }, 400);
      }

      // 外部技能不可删除
      const allSkills = engine.getAllSkills();
      const target = allSkills.find(s => s.name === name);
      if (target?.readonly) {
        return c.json({ error: t("error.skillExternalCannotDelete") }, 403);
      }

      // 优先查用户技能目录，再查 agent 自学目录
      const userSkillPath = path.join(engine.skillsDir, name);
      const agentDir = engine.agent?.agentDir;
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
  });

  // POST /skills/reload — 强制重新加载所有技能
  route.post("/skills/reload", async (c) => {
    try {
      await engine.reloadSkills();
      return c.json({ ok: true, skills: engine.getAllSkills() });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
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
