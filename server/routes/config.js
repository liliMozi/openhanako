/**
 * 配置管理 REST 路由
 */
import fs from "fs/promises";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { t } from "../i18n.js";
import { debugLog } from "../../lib/debug-log.js";
import { getRawConfig, getAllProviders, saveGlobalProviders, clearConfigCache } from "../../lib/memory/config-loader.js";
import { FactStore } from "../../lib/memory/fact-store.js";
import { splitByScope, injectGlobalFields } from '../../shared/config-scope.js';

export default async function configRoute(app, { engine }) {

  // 读取配置（脱敏：隐藏 API key，附带 _raw 原始结构 + providers）
  app.get("/api/config", async (req, reply) => {
    try {
      const config = { ...engine.config };
      const raw = getRawConfig(engine.configPath) || {};

      // 脱敏 API key
      const mask = (key) => {
        if (!key || key.length < 8) return key ? "****" : "";
        return key.slice(0, 4) + "..." + key.slice(-4);
      };

      if (config.api) {
        config.api = { ...config.api, api_key: mask(config.api.api_key) };
      }
      if (config.embedding_api) {
        config.embedding_api = { ...config.embedding_api, api_key: mask(config.embedding_api.api_key) };
      }
      if (config.utility_api) {
        config.utility_api = { ...config.utility_api, api_key: mask(config.utility_api.api_key) };
      }
      if (config.search) {
        config.search = { ...config.search, api_key: mask(config.search?.api_key) };
      }

      // 附带原始配置结构（未经 fallback 解析，让前端知道用户显式设了什么）
      config._raw = {
        api: { provider: raw.api?.provider || "", base_url: raw.api?.base_url || "" },
        embedding_api: { provider: raw.embedding_api?.provider || "", base_url: raw.embedding_api?.base_url || "" },
        utility_api: { provider: raw.utility_api?.provider || "", base_url: raw.utility_api?.base_url || "" },
      };

      // 供应商列表（脱敏 api_key，附带 model_count）
      const providers = getAllProviders(engine.configPath);
      const maskedProviders = {};
      for (const [name, p] of Object.entries(providers)) {
        maskedProviders[name] = {
          base_url: p.base_url || "",
          api: p.api || "",
          api_key: mask(p.api_key),
          models: p.models || [],
          model_count: (p.models || []).length,
        };
      }
      config.providers = maskedProviders;

      // 自动注入全局字段（schema-driven）
      injectGlobalFields(config, engine);
      // cwd_history 过滤（agent-scope，但需要 existsSync 验证）
      if (Array.isArray(config.cwd_history)) {
        config.cwd_history = config.cwd_history.filter(p => existsSync(p));
      }

      return config;
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 更新配置
  app.put("/api/config", async (req, reply) => {
    try {
      const partial = req.body;
      if (!partial || typeof partial !== "object") {
        reply.code(400);
        return { error: t("error.invalidJson") };
      }
      // ── schema-driven 全局字段分流 ──
      const { global: globalFields, agent: agentPartial } = splitByScope(partial);
      for (const { setter, value } of globalFields) {
        engine[setter](value);
      }

      // providers 块 → 全局 providers.yaml
      let providersChanged = false;
      if (agentPartial.providers) {
        // 删除 provider 时（值为 null），同步清理 models.json + favorites
        const deletedProviders = Object.keys(agentPartial.providers)
          .filter(name => agentPartial.providers[name] === null);
        if (deletedProviders.length > 0) {
          try {
            const modelsJsonPath = engine.modelsJsonPath;
            const modelsJson = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));
            // 收集被删 provider 下的所有模型 ID
            const orphanedModels = new Set();
            let changed = false;
            for (const name of deletedProviders) {
              const provData = modelsJson.providers?.[name];
              if (provData) {
                for (const m of (provData.models || [])) {
                  orphanedModels.add(typeof m === "string" ? m : m?.id);
                }
                delete modelsJson.providers[name];
                changed = true;
              }
            }
            if (changed) {
              writeFileSync(modelsJsonPath, JSON.stringify(modelsJson, null, 4) + "\n", "utf-8");
            }
            // 从 favorites 中移除已删 provider 的模型
            if (orphanedModels.size > 0) {
              const favorites = engine.readFavorites();
              const cleaned = favorites.filter(id => !orphanedModels.has(id));
              if (cleaned.length !== favorites.length) {
                await engine.saveFavorites(cleaned);
              }
            }
          } catch {}
        }
        saveGlobalProviders({ providers: agentPartial.providers });
        delete agentPartial.providers;
        providersChanged = true;
      }

      // 内联 API 凭证 → 全局 providers.yaml 对应条目
      const rawConfig = getRawConfig(engine.configPath) || {};
      for (const blockName of ["api", "embedding_api", "utility_api"]) {
        const block = agentPartial[blockName];
        if (block?.api_key || block?.base_url) {
          const provName = typeof block.provider === "string" && block.provider.trim()
            ? block.provider.trim()
            : (rawConfig?.[blockName]?.provider || "").trim();
          if (!provName) {
            reply.code(400);
            return { error: `${blockName}.provider is required when saving credentials` };
          }
          const provUpdate = {};
          if (block.api_key) provUpdate.api_key = block.api_key;
          if (block.base_url) provUpdate.base_url = block.base_url;
          saveGlobalProviders({ providers: { [provName]: provUpdate } });
          block.api_key = "";
          block.base_url = "";
          providersChanged = true;
        }
      }

      // providers 变更后确保运行时刷新
      const needsModelSync = providersChanged && !agentPartial.models;
      if (providersChanged && Object.keys(agentPartial).length === 0) {
        clearConfigCache();
        await engine.updateConfig({});
        if (needsModelSync) {
          try { await engine.syncModelsAndRefresh(); } catch (e) {
            debugLog()?.warn("api", `syncModelsAndRefresh after provider change: ${e.message}`);
          }
        }
        return { ok: true };
      }

      if (Object.keys(agentPartial).length === 0) return { ok: true };
      debugLog()?.log("api", `PUT /api/config keys=[${Object.keys(agentPartial).join(",")}]`);
      if (providersChanged) clearConfigCache();
      await engine.updateConfig(agentPartial);
      if (needsModelSync) {
        try { await engine.syncModelsAndRefresh(); } catch (e) {
          debugLog()?.warn("api", `syncModelsAndRefresh after config update: ${e.message}`);
        }
      }
      return { ok: true };
    } catch (err) {
      debugLog()?.error("api", `PUT /api/config failed: ${err.message}`);
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── System Prompt（只读，供 DevTools 查看）──

  app.get("/api/system-prompt", async (req, reply) => {
    try {
      return { content: engine.agent.systemPrompt || "" };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 人格文件（ishiki.md）──

  // 读取 ishiki.md 内容
  app.get("/api/ishiki", async (req, reply) => {
    try {
      const ishikiPath = engine.agentDir + "/ishiki.md";
      const content = await fs.readFile(ishikiPath, "utf-8");
      return { content };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 保存 ishiki.md 内容，并触发 system prompt 重建
  app.put("/api/ishiki", async (req, reply) => {
    try {
      const { content } = req.body || {};
      if (typeof content !== "string") {
        reply.code(400);
        return { error: "content must be a string" };
      }
      const ishikiPath = engine.agentDir + "/ishiki.md";
      await fs.writeFile(ishikiPath, content, "utf-8");
      debugLog()?.log("api", `PUT /api/ishiki (saved, ${content.length} chars)`);
      // 触发 system prompt 重建（updateConfig 内部会重新读取 ishiki.md）
      await engine.updateConfig({});
      return { ok: true };
    } catch (err) {
      debugLog()?.error("api", `PUT /api/ishiki failed: ${err.message}`);
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 身份简介（identity.md）──

  app.get("/api/identity", async (req, reply) => {
    try {
      const identityPath = engine.agentDir + "/identity.md";
      const content = await fs.readFile(identityPath, "utf-8");
      return { content };
    } catch (err) {
      if (err.code === "ENOENT") return { content: "" };
      reply.code(500);
      return { error: err.message };
    }
  });

  app.put("/api/identity", async (req, reply) => {
    try {
      const { content } = req.body || {};
      if (typeof content !== "string") {
        reply.code(400);
        return { error: "content must be a string" };
      }
      const identityPath = engine.agentDir + "/identity.md";
      await fs.writeFile(identityPath, content, "utf-8");
      debugLog()?.log("api", `PUT /api/identity (saved, ${content.length} chars)`);
      await engine.updateConfig({});
      return { ok: true };
    } catch (err) {
      debugLog()?.error("api", `PUT /api/identity failed: ${err.message}`);
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 用户档案（user.md）──

  // 读取 user.md 内容
  app.get("/api/user-profile", async (req, reply) => {
    try {
      const userPath = engine.userDir + "/user.md";
      const content = await fs.readFile(userPath, "utf-8");
      return { content };
    } catch (err) {
      // 文件不存在时返回空字符串（user.md 是可选的）
      if (err.code === "ENOENT") return { content: "" };
      reply.code(500);
      return { error: err.message };
    }
  });

  // 保存 user.md 内容，并触发 system prompt 重建
  app.put("/api/user-profile", async (req, reply) => {
    try {
      const { content } = req.body || {};
      if (typeof content !== "string") {
        reply.code(400);
        return { error: "content must be a string" };
      }
      const userPath = engine.userDir + "/user.md";
      await fs.writeFile(userPath, content, "utf-8");
      debugLog()?.log("api", `PUT /api/user-profile (saved, ${content.length} chars)`);
      await engine.updateConfig({});
      return { ok: true };
    } catch (err) {
      debugLog()?.error("api", `PUT /api/user-profile failed: ${err.message}`);
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 置顶记忆（pinned.md）──

  // 读取 pinned.md，解析为逐条数组
  app.get("/api/pinned", async (req, reply) => {
    try {
      const pinnedPath = engine.agentDir + "/pinned.md";
      let content = "";
      try {
        content = await fs.readFile(pinnedPath, "utf-8");
      } catch (err) {
        if (err.code === "ENOENT") return { pins: [] };
        throw err;
      }
      const pins = content
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => line.replace(/^-\s*/, ""));
      return { pins };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 保存 pinned.md（覆盖写入），触发 system prompt 重建
  app.put("/api/pinned", async (req, reply) => {
    try {
      const { pins } = req.body || {};
      if (!Array.isArray(pins)) {
        reply.code(400);
        return { error: "pins must be an array" };
      }
      const content = pins
        .map(p => (typeof p === "string" ? p.trim() : ""))
        .filter(p => p.length > 0)
        .map(p => `- ${p}`)
        .join("\n")
        + "\n";
      const pinnedPath = engine.agentDir + "/pinned.md";
      await fs.writeFile(pinnedPath, content, "utf-8");
      debugLog()?.log("api", `PUT /api/pinned (${pins.length} items)`);
      // 触发 system prompt 重建（updateConfig 内部会重新读取 pinned.md）
      await engine.updateConfig({});
      return { ok: true };
    } catch (err) {
      debugLog()?.error("api", `PUT /api/pinned failed: ${err.message}`);
      reply.code(500);
      return { error: err.message };
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
    const activeId = path.basename(engine.agent.agentDir);
    if (!agentId || agentId === activeId) {
      return { store: engine.factStore, isTemp: false };
    }
    if (/[\/\\.]/.test(agentId)) {
      throw new Error("Invalid agent ID");
    }
    const dbPath = path.join(engine.agentsDir, agentId, "memory", "facts.db");
    try {
      const store = new FactStore(dbPath);
      return { store, isTemp: true };
    } catch (err) {
      throw new Error(`Cannot open fact DB for agent "${agentId}": ${err.message}`);
    }
  }

  // 获取所有元事实
  app.get("/api/memories", async (req, reply) => {
    let tempStore = null;
    try {
      const { store, isTemp } = getStoreForAgent(req.query.agentId);
      if (isTemp) tempStore = store;
      return { memories: store.exportAll() };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    } finally {
      tempStore?.close();
    }
  });

  // 读取编译后的 memory.md
  app.get("/api/memories/compiled", async (req, reply) => {
    try {
      const agentId = req.query.agentId;
      const activeId = path.basename(engine.agent.agentDir);
      const mdPath = (!agentId || agentId === activeId)
        ? engine.memoryMdPath
        : path.join(engine.agentsDir, agentId, "memory", "memory.md");
      const content = await fs.readFile(mdPath, "utf-8").catch(() => "");
      return { content };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 清除编译产物（today/week/longterm/facts/memory.md + fingerprints）
  app.delete("/api/memories/compiled", async (req, reply) => {
    try {
      const agentId = req.query.agentId;
      const activeId = path.basename(engine.agent.agentDir);
      const memDir = (!agentId || agentId === activeId)
        ? path.dirname(engine.memoryMdPath)
        : path.join(engine.agentsDir, agentId, "memory");
      const targets = ["memory.md", "today.md", "week.md", "longterm.md", "facts.md"];
      for (const f of targets) {
        const p = path.join(memDir, f);
        await fs.writeFile(p, "", "utf-8").catch(() => {});
        await fs.unlink(p + ".fingerprint").catch(() => {});
      }
      debugLog()?.log("api", `DELETE /api/memories/compiled agent=${agentId || activeId}`);
      if (!agentId || agentId === activeId) await engine.updateConfig({});
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 清除所有记忆（facts.db + memory.md）
  app.delete("/api/memories", async (req, reply) => {
    let tempStore = null;
    try {
      const agentId = req.query.agentId;
      const { store, isTemp } = getStoreForAgent(agentId);
      if (isTemp) tempStore = store;
      store.clearAll();
      const activeId = path.basename(engine.agent.agentDir);
      const mdPath = (!agentId || agentId === activeId)
        ? engine.memoryMdPath
        : path.join(engine.agentsDir, agentId, "memory", "memory.md");
      await fs.writeFile(mdPath, "", "utf-8");
      debugLog()?.log("api", `DELETE /api/memories agent=${agentId || activeId}`);
      if (!isTemp) await engine.updateConfig({});
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    } finally {
      tempStore?.close();
    }
  });

  // 导出记忆（JSON）
  app.get("/api/memories/export", async (req, reply) => {
    let tempStore = null;
    try {
      const { store, isTemp } = getStoreForAgent(req.query.agentId);
      if (isTemp) tempStore = store;
      return {
        version: 2,
        exportedAt: new Date().toISOString(),
        facts: store.exportAll(),
      };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    } finally {
      tempStore?.close();
    }
  });

  // 导入记忆（直接写入，无需 embedding）
  app.post("/api/memories/import", async (req, reply) => {
    let tempStore = null;
    try {
      const { facts, memories } = req.body || {};
      // 兼容 v1 导出格式（memories 字段）和 v2 格式（facts 字段）
      const entries = facts || memories;
      if (!Array.isArray(entries) || entries.length === 0) {
        reply.code(400);
        return { error: "facts must be a non-empty array" };
      }

      const importEntries = entries.map((e) => ({
        fact: e.fact || e.content || "",
        tags: e.tags || [],
        time: e.time || e.date || null,
        session_id: e.session_id || "imported",
      }));

      const { store, isTemp } = getStoreForAgent(req.query.agentId);
      if (isTemp) tempStore = store;
      store.importAll(importEntries);
      debugLog()?.log("api", `POST /api/memories/import: ${importEntries.length} entries`);
      return { ok: true, imported: importEntries.length };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    } finally {
      tempStore?.close();
    }
  });

  // ── 全局 Favorites（跨 agent 共享的收藏模型列表）──

  app.get("/api/favorites", async (req, reply) => {
    try {
      return { favorites: engine.readFavorites() };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  app.put("/api/favorites", async (req, reply) => {
    try {
      const { favorites } = req.body || {};
      if (!Array.isArray(favorites)) {
        reply.code(400);
        return { error: "favorites must be an array" };
      }
      debugLog()?.log("api", `PUT /api/favorites (${favorites.length} items)`);
      await engine.saveFavorites(favorites);
      return { ok: true };
    } catch (err) {
      debugLog()?.error("api", `PUT /api/favorites failed: ${err.message}`);
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 搜索 API Key 验证 ──

  app.post("/api/search/verify", async (req, reply) => {
    const { provider, api_key } = req.body || {};
    if (!provider) {
      reply.code(400);
      return { ok: false, error: "provider is required" };
    }
    if (!api_key) {
      reply.code(400);
      return { ok: false, error: "api_key is required" };
    }
    try {
      const { verifySearchKey } = await import("../../lib/tools/web-search.js");
      await verifySearchKey(provider, api_key);
      engine.setSearchConfig({ provider, api_key });
      await engine.updateConfig({ search: { provider, api_key } });
      debugLog()?.log("api", `POST /api/search/verify provider=${provider} (ok)`);
      return { ok: true };
    } catch (err) {
      debugLog()?.warn("api", `POST /api/search/verify provider=${provider} failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });
}
