/**
 * 配置管理 REST 路由
 */
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { t } from "../i18n.js";
import { debugLog } from "../../lib/debug-log.js";
import { getRawConfig, clearConfigCache } from "../../lib/memory/config-loader.js";
import { FactStore } from "../../lib/memory/fact-store.js";
import { splitByScope, injectGlobalFields } from '../../shared/config-scope.js';
import { resolveAgent, resolveAgentStrict, AgentNotFoundError } from "../utils/resolve-agent.js";
import { formatSkillsForPrompt } from "../../lib/pi-sdk/index.js";
import {
  buildInlineProviderCredentialUpdate,
  clearInlineProviderCredentialFields,
  hasInlineProviderCredentialPatch,
} from "./provider-credentials.js";

export function createConfigRoute(engine) {
  const route = new Hono();

  // 读取配置（脱敏：隐藏 API key，附带 _raw 原始结构 + providers）
  route.get("/config", async (c) => {
    try {
      const config = { ...engine.config };
      const raw = getRawConfig(engine.configPath) || {};

      // 本地应用，直接返回完整 key（前端用 type="password" 控制显隐）

      // 附带原始配置结构（未经 fallback 解析，让前端知道用户显式设了什么）
      config._raw = {
        api: { provider: raw.api?.provider || "", base_url: raw.api?.base_url || "" },
        embedding_api: { provider: raw.embedding_api?.provider || "", base_url: raw.embedding_api?.base_url || "" },
        utility_api: { provider: raw.utility_api?.provider || "", base_url: raw.utility_api?.base_url || "" },
      };

      // 供应商列表（附带 model_count）
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

      // 自动注入全局字段（schema-driven）
      injectGlobalFields(config, engine);
      // cwd_history 过滤（agent-scope，但需要 existsSync 验证）
      if (Array.isArray(config.cwd_history)) {
        config.cwd_history = config.cwd_history.filter(p => existsSync(p));
      }

      return c.json(config);
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 更新配置
  route.put("/config", async (c) => {
    try {
      const partial = await safeJson(c);
      if (!partial || typeof partial !== "object") {
        return c.json({ error: t("error.invalidJson") }, 400);
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
      const rawConfig = getRawConfig(engine.configPath) || {};
      for (const blockName of ["api", "embedding_api", "utility_api"]) {
        const block = agentPartial[blockName];
        if (hasInlineProviderCredentialPatch(block)) {
          const { provider: provName, update: provUpdate } = buildInlineProviderCredentialUpdate(
            block,
            rawConfig?.[blockName]?.provider || "",
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
        try {
          await engine.onProviderChanged();
          debugLog()?.log("api", `onProviderChanged OK after provider change (${engine.availableModels.length} models)`);
        } catch (e) {
          console.error("[config] onProviderChanged failed:", e.message);
        }
      }

      if (providersChanged && Object.keys(agentPartial).length === 0) {
        clearConfigCache();
        await engine.updateConfig({});
        return c.json({ ok: true });
      }

      if (Object.keys(agentPartial).length === 0) return c.json({ ok: true });
      debugLog()?.log("api", `PUT /api/config keys=[${Object.keys(agentPartial).join(",")}]`);
      if (providersChanged) clearConfigCache();
      await engine.updateConfig(agentPartial);
      return c.json({ ok: true });
    } catch (err) {
      debugLog()?.error("api", `PUT /api/config failed: ${err.message}`);
      return c.json({ error: err.message }, 500);
    }
  });

  // ── System Prompt（只读，供 DevTools 查看）──
  // 注意：agent.systemPrompt 不含 skills 块（#399 修复后由 SDK 内部统一注入），
  // 这里手动拼接以保持开发者视图与 SDK 实际发送给 LLM 的 prompt 一致。

  route.get("/system-prompt", async (c) => {
    try {
      const agent = resolveAgent(engine, c);
      let content = agent.systemPrompt || "";
      const enabledSkills = agent.enabledSkills || [];
      if (enabledSkills.length > 0) {
        content += formatSkillsForPrompt(enabledSkills);
      }
      return c.json({ content });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 人格文件（ishiki.md）──

  // 读取 ishiki.md 内容
  route.get("/ishiki", async (c) => {
    try {
      const ishikiPath = path.join(resolveAgent(engine, c).agentDir, "ishiki.md");
      const content = await fs.readFile(ishikiPath, "utf-8");
      return c.json({ content });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 保存 ishiki.md 内容，并触发 system prompt 重建
  route.put("/ishiki", async (c) => {
    try {
      const body = await safeJson(c);
      const { content } = body;
      if (typeof content !== "string") {
        return c.json({ error: "content must be a string" }, 400);
      }
      const agent = resolveAgentStrict(engine, c);
      const ishikiPath = path.join(agent.agentDir, "ishiki.md");
      await fs.writeFile(ishikiPath, content, "utf-8");
      debugLog()?.log("api", `PUT /api/ishiki (saved, ${content.length} chars)`);
      // 触发 system prompt 重建（updateConfig 内部会重新读取 ishiki.md）
      await engine.updateConfig({}, { agentId: agent.id });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      debugLog()?.error("api", `PUT /api/ishiki failed: ${err.message}`);
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 身份简介（identity.md）──

  route.get("/identity", async (c) => {
    try {
      const identityPath = path.join(resolveAgent(engine, c).agentDir, "identity.md");
      const content = await fs.readFile(identityPath, "utf-8");
      return c.json({ content });
    } catch (err) {
      if (err.code === "ENOENT") return c.json({ content: "" });
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/identity", async (c) => {
    try {
      const body = await safeJson(c);
      const { content } = body;
      if (typeof content !== "string") {
        return c.json({ error: "content must be a string" }, 400);
      }
      const agent = resolveAgentStrict(engine, c);
      const identityPath = path.join(agent.agentDir, "identity.md");
      await fs.writeFile(identityPath, content, "utf-8");
      debugLog()?.log("api", `PUT /api/identity (saved, ${content.length} chars)`);
      await engine.updateConfig({}, { agentId: agent.id });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      debugLog()?.error("api", `PUT /api/identity failed: ${err.message}`);
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 用户档案（user.md）──

  // 读取 user.md 内容
  route.get("/user-profile", async (c) => {
    try {
      const userPath = path.join(engine.userDir, "user.md");
      const content = await fs.readFile(userPath, "utf-8");
      return c.json({ content });
    } catch (err) {
      // 文件不存在时返回空字符串（user.md 是可选的）
      if (err.code === "ENOENT") return c.json({ content: "" });
      return c.json({ error: err.message }, 500);
    }
  });

  // 保存 user.md 内容，并触发 system prompt 重建
  route.put("/user-profile", async (c) => {
    try {
      const body = await safeJson(c);
      const { content } = body;
      if (typeof content !== "string") {
        return c.json({ error: "content must be a string" }, 400);
      }
      const userPath = path.join(engine.userDir, "user.md");
      await fs.writeFile(userPath, content, "utf-8");
      debugLog()?.log("api", `PUT /api/user-profile (saved, ${content.length} chars)`);
      await engine.updateConfig({});
      return c.json({ ok: true });
    } catch (err) {
      debugLog()?.error("api", `PUT /api/user-profile failed: ${err.message}`);
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 置顶记忆（pinned.md）──

  // 读取 pinned.md，解析为逐条数组
  route.get("/pinned", async (c) => {
    try {
      const pinnedPath = path.join(resolveAgent(engine, c).agentDir, "pinned.md");
      let content = "";
      try {
        content = await fs.readFile(pinnedPath, "utf-8");
      } catch (err) {
        if (err.code === "ENOENT") return c.json({ pins: [] });
        throw err;
      }
      const pins = content
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => line.replace(/^-\s*/, ""));
      return c.json({ pins });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 保存 pinned.md（覆盖写入），触发 system prompt 重建
  route.put("/pinned", async (c) => {
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
      const agent = resolveAgentStrict(engine, c);
      const pinnedPath = path.join(agent.agentDir, "pinned.md");
      await fs.writeFile(pinnedPath, content, "utf-8");
      debugLog()?.log("api", `PUT /api/pinned (${pins.length} items)`);
      // 触发 system prompt 重建（updateConfig 内部会重新读取 pinned.md）
      await engine.updateConfig({}, { agentId: agent.id });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      debugLog()?.error("api", `PUT /api/pinned failed: ${err.message}`);
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 记忆管理 ──

  /**
   * 获取指定 agent 的 FactStore。
   * 如果 agentId 就是当前 active agent，直接用 engine.factStore；
   * 否则临时打开那个 agent 的 facts.db。
   * 返回 { store, isTemp }，调用方用完 isTemp===true 的 store 需要 close。
   */
  function getStoreForAgent(agentId) {
    if (!agentId) throw new Error("agentId is required");
    const resolvedId = agentId;
    const agent = engine.getAgent(resolvedId);
    if (agent?.factStore) {
      return { store: agent.factStore, isTemp: false };
    }
    if (/[\/\\.]/.test(resolvedId)) throw new Error("Invalid agent ID");
    const dbPath = path.join(engine.agentsDir, resolvedId, "memory", "facts.db");
    try {
      const store = new FactStore(dbPath);
      return { store, isTemp: true };
    } catch (err) {
      throw new Error(`Cannot open fact DB for agent "${resolvedId}": ${err.message}`);
    }
  }

  // 获取所有元事实
  route.get("/memories", async (c) => {
    let tempStore = null;
    try {
      const { store, isTemp } = getStoreForAgent(c.req.query("agentId"));
      if (isTemp) tempStore = store;
      return c.json({ memories: store.exportAll() });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    } finally {
      tempStore?.close();
    }
  });

  // 读取编译后的 memory.md
  route.get("/memories/compiled", async (c) => {
    try {
      const agent = resolveAgent(engine, c);
      const mdPath = agent.memoryMdPath;
      const content = await fs.readFile(mdPath, "utf-8").catch(() => "");
      return c.json({ content });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 清除编译产物（today/week/longterm/facts/memory.md + fingerprints）
  route.delete("/memories/compiled", async (c) => {
    try {
      const agent = resolveAgent(engine, c);
      const memDir = path.dirname(agent.memoryMdPath);
      const targets = ["memory.md", "today.md", "week.md", "longterm.md", "facts.md"];
      for (const f of targets) {
        const p = path.join(memDir, f);
        await fs.writeFile(p, "", "utf-8").catch(() => {});
        await fs.unlink(p + ".fingerprint").catch(() => {});
      }
      debugLog()?.log("api", `DELETE /api/memories/compiled agent=${path.basename(agent.agentDir)}`);
      const agentId = path.basename(agent.agentDir);
      const resolvedAgent = engine.getAgent(agentId);
      if (resolvedAgent) await resolvedAgent.updateConfig({});
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 清除所有记忆（facts.db + memory.md）
  route.delete("/memories", async (c) => {
    let tempStore = null;
    try {
      const agent = resolveAgent(engine, c);
      const { store, isTemp } = getStoreForAgent(c.req.query("agentId"));
      if (isTemp) tempStore = store;
      store.clearAll();
      const mdPath = agent.memoryMdPath;
      await fs.writeFile(mdPath, "", "utf-8");
      debugLog()?.log("api", `DELETE /api/memories agent=${path.basename(agent.agentDir)}`);
      const agentId = path.basename(agent.agentDir);
      const resolvedAgent = engine.getAgent(agentId);
      if (resolvedAgent) await resolvedAgent.updateConfig({});
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    } finally {
      tempStore?.close();
    }
  });

  // 导出记忆（JSON）
  route.get("/memories/export", async (c) => {
    let tempStore = null;
    try {
      const { store, isTemp } = getStoreForAgent(c.req.query("agentId"));
      if (isTemp) tempStore = store;
      return c.json({
        version: 2,
        exportedAt: new Date().toISOString(),
        facts: store.exportAll(),
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    } finally {
      tempStore?.close();
    }
  });

  // 导入记忆（直接写入，无需 embedding）
  route.post("/memories/import", async (c) => {
    let tempStore = null;
    try {
      const body = await safeJson(c);
      const { facts, memories } = body;
      // 兼容 v1 导出格式（memories 字段）和 v2 格式（facts 字段）
      const entries = facts || memories;
      if (!Array.isArray(entries) || entries.length === 0) {
        return c.json({ error: "facts must be a non-empty array" }, 400);
      }

      const importEntries = entries.map((e) => ({
        fact: e.fact || e.content || "",
        tags: e.tags || [],
        time: e.time || e.date || null,
        session_id: e.session_id || "imported",
      }));

      const { store, isTemp } = getStoreForAgent(c.req.query("agentId"));
      if (isTemp) tempStore = store;
      store.importAll(importEntries);
      debugLog()?.log("api", `POST /api/memories/import: ${importEntries.length} entries`);
      return c.json({ ok: true, imported: importEntries.length });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    } finally {
      tempStore?.close();
    }
  });

  // ── 搜索 API Key 验证 ──

  route.post("/search/verify", async (c) => {
    const body = await safeJson(c);
    const { provider, api_key } = body;
    if (!provider) {
      return c.json({ ok: false, error: "provider is required" }, 400);
    }
    if (!api_key) {
      return c.json({ ok: false, error: "api_key is required" }, 400);
    }
    try {
      const { verifySearchKey } = await import("../../lib/tools/web-search.js");
      await verifySearchKey(provider, api_key);
      engine.setSearchConfig({ provider, api_key });
      await engine.updateConfig({ search: { provider, api_key } });
      debugLog()?.log("api", `POST /api/search/verify provider=${provider} (ok)`);
      return c.json({ ok: true });
    } catch (err) {
      debugLog()?.warn("api", `POST /api/search/verify provider=${provider} failed: ${err.message}`);
      return c.json({ ok: false, error: err.message });
    }
  });

  return route;
}
