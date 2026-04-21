/**
 * 助手管理 REST 路由
 *
 * GET    /api/agents              — 列出所有助手
 * POST   /api/agents              — 创建新助手
 * POST   /api/agents/switch       — 切换到指定助手
 * DELETE /api/agents/:id          — 删除助手
 * PUT    /api/agents/primary      — 设置主助手
 * GET    /api/agents/:id/avatar   — 获取指定助手的头像
 * POST   /api/agents/:id/avatar   — 上传指定助手的头像
 * GET    /api/agents/:id/config   — 读取指定助手的 config
 * PUT    /api/agents/:id/config   — 写入指定助手的 config
 * GET    /api/agents/:id/identity — 读取 identity.md
 * PUT    /api/agents/:id/identity — 写入 identity.md
 * GET    /api/agents/:id/ishiki   — 读取 ishiki.md
 * PUT    /api/agents/:id/ishiki   — 写入 ishiki.md
 * GET    /api/agents/:id/pinned   — 读取 pinned.md
 * PUT    /api/agents/:id/pinned   — 写入 pinned.md
 * GET    /api/agents/:id/experience — 读取经验（合并）
 * PUT    /api/agents/:id/experience — 写入经验（拆分）
 */
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import YAML from "js-yaml";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { safeJson } from "../hono-helpers.js";
import { saveConfig, clearConfigCache } from "../../lib/memory/config-loader.js";
import { rebuildIndex } from "../../lib/tools/experience.js";
import { splitByScope, injectGlobalFields } from '../../shared/config-scope.js';
import { validateId, agentExists } from "../utils/validation.js";
import { OPTIONAL_TOOL_NAMES } from "../../shared/tool-categories.js";
import {
  buildInlineProviderCredentialUpdate,
  clearInlineProviderCredentialFields,
  hasInlineProviderCredentialPatch,
} from "./provider-credentials.js";

// ── 工具函数 ──

function agentDir(engine, id) {
  return path.join(engine.agentsDir, id);
}

// 本地应用，API key 不做掩码，前端用 type="password" 控制显隐

export function createAgentsRoute(engine) {
  const route = new Hono();

  // ════════════════════════════
  //  列表 / 创建 / 切换 / 删除 / 主助手
  // ════════════════════════════

  route.get("/agents", async (c) => {
    try {
      return c.json({ agents: engine.listAgents() });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/agents", async (c) => {
    try {
      const body = await safeJson(c);
      const { name, id, yuan } = body;
      if (!name?.trim()) {
        return c.json({ error: "name is required" }, 400);
      }
      const result = await engine.createAgent({ name, id, yuan });
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err.message }, err.message.includes("已存在") ? 409 : 500);
    }
  });

  route.post("/agents/switch", async (c) => {
    try {
      const body = await safeJson(c);
      const { id } = body;
      if (!id?.trim() || !validateId(id)) {
        return c.json({ error: "invalid id" }, 400);
      }
      await engine.switchAgent(id);
      return c.json({
        ok: true,
        agent: {
          id,
          name: engine.getAgent(id)?.agentName || id,
        },
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.delete("/agents/:id", async (c) => {
    try {
      const id = c.req.param("id");
      if (!validateId(id)) return c.json({ error: "invalid id" }, 400);
      await engine.deleteAgent(id);
      return c.json({ ok: true });
    } catch (err) {
      const code = err.message.includes("不能删除当前") ? 400
        : err.message.includes("不存在") ? 404
        : 500;
      return c.json({ error: err.message }, code);
    }
  });

  route.put("/agents/primary", async (c) => {
    try {
      const body = await safeJson(c);
      const { id } = body;
      if (!id?.trim()) {
        return c.json({ error: "id is required" }, 400);
      }
      engine.setPrimaryAgent(id);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ════════════════════════════
  //  排序
  // ════════════════════════════

  route.put("/agents/order", async (c) => {
    try {
      const body = await safeJson(c);
      const { order } = body;
      if (!Array.isArray(order)) {
        return c.json({ error: "order must be an array" }, 400);
      }
      engine.saveAgentOrder(order);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ════════════════════════════
  //  头像
  // ════════════════════════════

  route.get("/agents/:id/avatar", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    const avatarPath = path.join(agentDir(engine, id), "avatars");
    const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
    for (const ext of ["png", "jpg", "jpeg", "webp"]) {
      const p = path.join(avatarPath, `agent.${ext}`);
      try {
        await fs.access(p);
        const buf = await fs.readFile(p);
        c.header("Content-Type", mimeMap[ext]);
        c.header("Cache-Control", "no-cache");
        return c.body(buf);
      } catch {}
    }
    return c.json({ error: "no avatar" }, 404);
  });

  route.post("/agents/:id/avatar", bodyLimit({ maxSize: 15 * 1024 * 1024 }), async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    const body = await safeJson(c);
    const { data } = body;
    if (!data || typeof data !== "string") {
      return c.json({ error: "data (base64) is required" }, 400);
    }
    const match = data.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
    if (!match) {
      return c.json({ error: "invalid data URL format" }, 400);
    }
    const ext = match[1] === "jpeg" ? "jpg" : match[1];
    const buf = Buffer.from(match[2], "base64");
    const dir = path.join(agentDir(engine, id), "avatars");
    await fs.mkdir(dir, { recursive: true });
    for (const oldExt of ["png", "jpg", "jpeg", "webp"]) {
      try { await fs.unlink(path.join(dir, `agent.${oldExt}`)); } catch {}
    }
    await fs.writeFile(path.join(dir, `agent.${ext}`), buf);
    engine.invalidateAgentListCache();
    return c.json({ ok: true, ext });
  });

  route.delete("/agents/:id/avatar", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    const dir = path.join(agentDir(engine, id), "avatars");
    for (const ext of ["png", "jpg", "jpeg", "webp"]) {
      try { await fs.unlink(path.join(dir, `agent.${ext}`)); } catch {}
    }
    engine.invalidateAgentListCache();
    return c.json({ ok: true });
  });

  // ════════════════════════════
  //  Config（config.yaml）
  // ════════════════════════════

  route.get("/agents/:id/config", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const configPath = path.join(agentDir(engine, id), "config.yaml");
      // 直接解析 YAML，不走 loadConfig 全局缓存
      const config = YAML.load(await fs.readFile(configPath, "utf-8")) || {};

      // API key 不做掩码（本地应用，前端用 type="password" 控制显隐）

      // 附带 raw 结构
      config._raw = {
        api: { provider: config.api?.provider || "", base_url: config.api?.base_url || "" },
        embedding_api: { provider: config.embedding_api?.provider || "", base_url: config.embedding_api?.base_url || "" },
        utility_api: { provider: config.utility_api?.provider || "", base_url: config.utility_api?.base_url || "" },
      };

      // 自动注入全局字段（schema-driven，替代手写逐个注入）
      injectGlobalFields(config, engine);

      // 供应商列表
      try {
        const rawProviders = engine.providerRegistry.getAllProvidersRaw();
        const providerEntries = {};
        for (const [name, p] of Object.entries(rawProviders)) {
          const entry = engine.providerRegistry.get(name);
          providerEntries[name] = {
            base_url: p.base_url || entry?.baseUrl || "",
            api: p.api || entry?.api || "",
            api_key: p.api_key || "",
            models: p.models || [],
            model_count: (p.models || []).length,
          };
        }
        config.providers = providerEntries;
      } catch {
        config.providers = {};
      }

      // Expose the agent's currently-registered tool name list so the settings
      // UI can decide which optional-tool toggles to render. Uses the keyed
      // engine.getAgent(id) lookup rather than the focus pointer — state
      // ownership must be uniquely determined, not derived from focus.
      const agent = engine.getAgent(id);
      if (!agent) {
        // agentExists(engine, id) already guarded above; reaching here means
        // engine.getAgent diverged from agentExists. That's a bug, not a missing
        // resource — log it but don't 500 the response.
        console.warn(
          `GET /agents/${id}/config: agent not found by keyed lookup despite passing agentExists check`
        );
        config.availableTools = [];
      } else {
        config.availableTools = (agent.tools || [])
          .map((t) => t.name)
          .filter(Boolean);
      }

      return c.json(config);
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/agents/:id/config", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const partial = await safeJson(c);
      if (!partial || typeof partial !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }

      // Whitelist check: tools.disabled may only contain OPTIONAL_TOOL_NAMES.
      // Blocks attempts to disable core/standard tools via hand-crafted requests.
      if (partial.tools?.disabled !== undefined) {
        if (!Array.isArray(partial.tools.disabled)) {
          return c.json({ error: "tools.disabled must be an array" }, 400);
        }
        const invalid = partial.tools.disabled.filter(
          (n) => !OPTIONAL_TOOL_NAMES.includes(n)
        );
        if (invalid.length > 0) {
          return c.json(
            {
              error: `Invalid tool names in tools.disabled: ${invalid.join(", ")}. Only optional tools can be disabled.`,
            },
            400
          );
        }
      }

      // ── schema-driven 全局字段分流 ──
      const { global: globalFields, agent: agentPartial } = splitByScope(partial);
      for (const { setter, value } of globalFields) {
        engine[setter](value);
      }

      // providers 块 → 全局 added-models.yaml
      let providersChanged = false;
      if (agentPartial.providers) {
        for (const [name, data] of Object.entries(agentPartial.providers)) {
          if (data === null) {
            engine.providerRegistry.removeProvider(name);
          } else {
            engine.providerRegistry.saveProvider(name, data);
          }
        }
        delete agentPartial.providers;
        providersChanged = true;
      }

      // 内联 API 凭证 → 全局 added-models.yaml 对应条目
      for (const blockName of ["api", "embedding_api", "utility_api"]) {
        const block = agentPartial[blockName];
        if (hasInlineProviderCredentialPatch(block)) {
          const cfgPath = path.join(agentDir(engine, id), "config.yaml");
          const agentCfg = YAML.load(fsSync.readFileSync(cfgPath, "utf-8")) || {};
          const { provider: provName, update: provUpdate } = buildInlineProviderCredentialUpdate(
            block,
            agentCfg[blockName]?.provider || "",
          );
          if (!provName) {
            return c.json({ error: `${blockName}.provider is required when saving credentials` }, 400);
          }
          engine.providerRegistry.saveProvider(provName, provUpdate);
          clearInlineProviderCredentialFields(block);
          providersChanged = true;
        }
      }

      // providers 变更后确保运行时刷新
      if (providersChanged) {
        await engine.onProviderChanged();
        clearConfigCache();
      }

      // providers 是全局状态，变更后无论编辑的是哪个 agent，运行时都要刷新
      if (providersChanged) {
        await engine.updateConfig({});
      }

      if (Object.keys(agentPartial).length === 0) {
        return c.json({ ok: true });
      }

      // 记忆总开关：写入时间戳（用于过滤关闭期间的 session）
      if (agentPartial.memory && "enabled" in agentPartial.memory) {
        const now = new Date().toISOString();
        if (agentPartial.memory.enabled === false) {
          agentPartial.memory.disabledSince = now;
        } else {
          agentPartial.memory.reenableAt = now;
        }
      }

      const configPath = path.join(agentDir(engine, id), "config.yaml");
      saveConfig(configPath, agentPartial);
      engine.invalidateAgentListCache();
      // 触发目标 agent 模块刷新 + prompt 重建
      await engine.updateConfig(agentPartial, { agentId: id });
      // 记忆总开关：无论是否 active agent，都需要刷新运行时状态（因为 ticker 后台在跑）
      if (agentPartial.memory && "enabled" in agentPartial.memory) {
        engine.setMemoryMasterEnabled(id, agentPartial.memory.enabled !== false);
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ════════════════════════════
  //  Identity（identity.md）
  // ════════════════════════════

  route.get("/agents/:id/identity", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const content = await fs.readFile(path.join(agentDir(engine, id), "identity.md"), "utf-8");
      return c.json({ content });
    } catch (err) {
      if (err.code === "ENOENT") return c.json({ content: "" });
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/agents/:id/identity", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const body = await safeJson(c);
      const { content } = body;
      if (typeof content !== "string") {
        return c.json({ error: "content must be a string" }, 400);
      }
      await fs.writeFile(path.join(agentDir(engine, id), "identity.md"), content, "utf-8");
      engine.invalidateAgentListCache();
      await engine.updateConfig({}, { agentId: id });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ════════════════════════════
  //  Ishiki（ishiki.md）
  // ════════════════════════════

  route.get("/agents/:id/ishiki", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const content = await fs.readFile(path.join(agentDir(engine, id), "ishiki.md"), "utf-8");
      return c.json({ content });
    } catch (err) {
      if (err.code === "ENOENT") return c.json({ content: "" });
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/agents/:id/ishiki", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const body = await safeJson(c);
      const { content } = body;
      if (typeof content !== "string") {
        return c.json({ error: "content must be a string" }, 400);
      }
      await fs.writeFile(path.join(agentDir(engine, id), "ishiki.md"), content, "utf-8");
      await engine.updateConfig({}, { agentId: id });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ════════════════════════════
  //  Public Ishiki（public-ishiki.md）
  // ════════════════════════════

  route.get("/agents/:id/public-ishiki", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const content = await fs.readFile(path.join(agentDir(engine, id), "public-ishiki.md"), "utf-8");
      return c.json({ content });
    } catch (err) {
      if (err.code === "ENOENT") return c.json({ content: "" });
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/agents/:id/public-ishiki", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const body = await safeJson(c);
      const { content } = body;
      if (typeof content !== "string") {
        return c.json({ error: "content must be a string" }, 400);
      }
      await fs.writeFile(path.join(agentDir(engine, id), "public-ishiki.md"), content, "utf-8");
      await engine.updateConfig({}, { agentId: id });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ════════════════════════════
  //  Pinned（pinned.md）
  // ════════════════════════════

  route.get("/agents/:id/pinned", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const content = await fs.readFile(path.join(agentDir(engine, id), "pinned.md"), "utf-8");
      const pins = content
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => line.replace(/^-\s*/, ""));
      return c.json({ pins });
    } catch (err) {
      if (err.code === "ENOENT") return c.json({ pins: [] });
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/agents/:id/pinned", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const body = await safeJson(c);
      const { pins } = body;
      if (!Array.isArray(pins)) {
        return c.json({ error: "pins must be an array" }, 400);
      }
      const content = pins
        .map(p => (typeof p === "string" ? p.trim() : ""))
        .filter(p => p.length > 0)
        .map(p => `- ${p}`)
        .join("\n")
        + "\n";
      await fs.writeFile(path.join(agentDir(engine, id), "pinned.md"), content, "utf-8");
      await engine.updateConfig({}, { agentId: id });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ════════════════════════════
  //  Experience（experience/ 目录）
  // ════════════════════════════

  route.get("/agents/:id/experience", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const expDir = path.join(agentDir(engine, id), "experience");
      if (!fsSync.existsSync(expDir)) return c.json({ content: "" });

      const files = (await fs.readdir(expDir)).filter((f) => f.endsWith(".md")).sort();
      if (files.length === 0) return c.json({ content: "" });

      const blocks = [];
      for (const file of files) {
        const category = file.replace(/\.md$/, "");
        const body = await fs.readFile(path.join(expDir, file), "utf-8");
        blocks.push(`# ${category}\n${body.trimEnd()}`);
      }
      return c.json({ content: blocks.join("\n\n") + "\n" });
    } catch (err) {
      if (err.code === "ENOENT") return c.json({ content: "" });
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/agents/:id/experience", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const body = await safeJson(c);
      const { content } = body;
      if (typeof content !== "string") {
        return c.json({ error: "content must be a string" }, 400);
      }

      const dir = agentDir(engine, id);
      const expDir = path.join(dir, "experience");
      const indexPath = path.join(dir, "experience.md");

      // 解析合并 markdown → 按 ^# 分割成分类
      const categories = new Map();
      let currentCat = null;
      const lines = content.split("\n");

      for (const line of lines) {
        const headingMatch = line.match(/^#\s+(.+)/);
        if (headingMatch) {
          currentCat = headingMatch[1].trim();
          if (!categories.has(currentCat)) categories.set(currentCat, []);
        } else if (currentCat !== null) {
          categories.get(currentCat).push(line);
        }
      }

      // 确保目录存在
      await fs.mkdir(expDir, { recursive: true });

      // 写入各分类文件
      const newFiles = new Set();
      for (const [cat, catLines] of categories) {
        const catBody = catLines.join("\n").trim();
        if (!catBody) continue;
        const filename = `${cat}.md`;
        newFiles.add(filename);
        await fs.writeFile(path.join(expDir, filename), catBody + "\n", "utf-8");
      }

      // 清除不再存在的旧文件
      try {
        const existing = await fs.readdir(expDir);
        for (const f of existing) {
          if (f.endsWith(".md") && !newFiles.has(f)) {
            await fs.unlink(path.join(expDir, f));
          }
        }
      } catch {}

      // 重建索引
      rebuildIndex(expDir, indexPath);

      await engine.updateConfig({}, { agentId: id });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}
