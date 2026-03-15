/**
 * ConfigCoordinator — 运行时配置管理
 *
 * 从 Engine 提取，负责模型/搜索/utility 配置读写、
 * updateConfig 联动、Plan Mode、记忆开关、Provider 迁移。
 * 不持有 engine 引用，通过构造器注入依赖。
 */
import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { createModuleLogger } from "../lib/debug-log.js";
import {
  clearConfigCache,
  loadGlobalProviders,
  loadModelsRegistry,
  resolveApiKeyFromAuth,
} from "../lib/memory/config-loader.js";

const log = createModuleLogger("config");

/** Plan Mode / Bridge 只读工具名白名单 */
export const READ_ONLY_BUILTIN_TOOLS = ["read", "grep", "find", "ls"];

/** 全局共享模型字段 → preferences key 映射 */
export const SHARED_MODEL_KEYS = [
  ["utility",        "utility_model"],
  ["utility_large",  "utility_large_model"],
  ["summarizer",     "summarizer_model"],
  ["compiler",       "compiler_model"],
];

export class ConfigCoordinator {
  /**
   * @param {object} deps
   * @param {string} deps.hanakoHome
   * @param {string} deps.agentsDir
   * @param {() => object} deps.getAgent - 当前焦点 agent
   * @param {() => Map} deps.getAgents - 所有 agent Map
   * @param {() => import('./model-manager.js').ModelManager} deps.getModels
   * @param {() => import('./preferences-manager.js').PreferencesManager} deps.getPrefs
   * @param {() => import('./skill-manager.js').SkillManager} deps.getSkills
   * @param {() => object|null} deps.getSession - 当前 session
   * @param {() => object|null} deps.getHub
   * @param {(event, sp) => void} deps.emitEvent
   * @param {(text, level?) => void} deps.emitDevLog
   * @param {() => string|null} deps.getCurrentModel - currentModel name
   */
  constructor(deps) {
    this._d = deps;
    this._planMode = false;
  }

  get planMode() { return this._planMode; }

  // ── Home Folder ──

  getHomeFolder() {
    return this._prefs().home_folder || null;
  }

  setHomeFolder(folder) {
    const prefs = this._prefs();
    if (folder) {
      prefs.home_folder = folder;
    } else {
      delete prefs.home_folder;
    }
    this._savePrefs(prefs);
    log.log(`setHomeFolder: ${folder || "(cleared)"}`);
  }

  // ── Shared Models ──

  getSharedModels() {
    const prefs = this._prefs();
    const result = {};
    for (const [field, prefKey] of SHARED_MODEL_KEYS) {
      result[field] = prefs[prefKey] || null;
    }
    return result;
  }

  setSharedModels(partial) {
    const prefs = this._prefs();
    const changed = [];
    for (const [field, prefKey] of SHARED_MODEL_KEYS) {
      if (partial[field] !== undefined) {
        if (partial[field] !== null && partial[field] !== "") prefs[prefKey] = partial[field];
        else delete prefs[prefKey];
        changed.push(`${field}=${partial[field] || "(cleared)"}`);
      }
    }
    this._savePrefs(prefs);
    if (changed.length) {
      const fresh = this.getSharedModels();
      const agent = this._d.getAgent();
      agent._utilityModel = fresh.utility || null;
      log.log(`setSharedModels: ${changed.join(", ")}`);
    }
  }

  // ── Search Config ──

  getSearchConfig() {
    const prefs = this._prefs();
    return {
      provider: prefs.search_provider || null,
      api_key: prefs.search_api_key || null,
    };
  }

  setSearchConfig(partial) {
    const prefs = this._prefs();
    if (partial.provider !== undefined) {
      if (partial.provider) prefs.search_provider = partial.provider;
      else delete prefs.search_provider;
    }
    if (partial.api_key !== undefined) {
      if (partial.api_key) prefs.search_api_key = partial.api_key;
      else delete prefs.search_api_key;
    }
    this._savePrefs(prefs);
    log.log(`setSearchConfig: provider=${partial.provider || "(cleared)"}`);
  }

  // ── Utility API ──

  getUtilityApi() {
    const prefs = this._prefs();
    return {
      provider: prefs.utility_api_provider || null,
      base_url: prefs.utility_api_base_url || null,
      api_key: prefs.utility_api_key || null,
    };
  }

  setUtilityApi(partial) {
    const prefs = this._prefs();
    for (const [key, prefKey] of [
      ["provider", "utility_api_provider"],
      ["base_url", "utility_api_base_url"],
      ["api_key", "utility_api_key"],
    ]) {
      if (partial[key] !== undefined) {
        if (partial[key]) prefs[prefKey] = partial[key];
        else delete prefs[prefKey];
      }
    }
    this._savePrefs(prefs);
    log.log(`setUtilityApi: provider=${partial.provider || "-"}, base_url=${partial.base_url || "-"}`);
  }

  resolveUtilityConfig() {
    const models = this._d.getModels();
    return models.resolveUtilityConfig(
      this._d.getAgent().config,
      this.getSharedModels(),
      this.getUtilityApi(),
    );
  }

  // ── Favorites ──

  readFavorites() {
    return this._prefs().favorites || [];
  }

  async saveFavorites(favorites) {
    const prefs = this._prefs();
    prefs.favorites = favorites;
    this._savePrefs(prefs);
    log.log(`saveFavorites: ${favorites.length} items`);

    try {
      await this.syncModelsAndRefresh(favorites);
    } catch (err) {
      console.error("[config] favorites sync failed:", err.message);
    }
  }

  // ── Agent Order ──

  readAgentOrder() {
    return this._prefs().agentOrder || [];
  }

  saveAgentOrder(order) {
    const prefs = this._prefs();
    prefs.agentOrder = order;
    this._savePrefs(prefs);
  }

  // ── Model / Thinking ──

  async syncModelsAndRefresh(favorites) {
    const models = this._d.getModels();
    const agent = this._d.getAgent();
    const synced = await models.syncModelsAndRefresh(agent.configPath, {
      favorites: favorites || this.readFavorites(),
      sharedModels: this.getSharedModels(),
    });
    this.normalizeUtilityApiPreferences();
    return synced;
  }

  async setModel(modelId) {
    const models = this._d.getModels();
    const model = models.setModel(modelId);
    const session = this._d.getSession();
    if (session) {
      await session.setModel(model);
    }
  }

  setThinkingLevel(level) {
    // 持久化到全局 preference（跨 session 常驻）
    this._d.getPrefs().setThinkingLevel(level);
    const session = this._d.getSession();
    if (session) {
      session.setThinkingLevel(this._d.getModels().resolveThinkingLevel(level));
    }
  }

  /** 从 preference 读取用户设定的 thinking level */
  getThinkingLevel() {
    return this._d.getPrefs().getThinkingLevel();
  }

  // ── Memory ──

  setMemoryEnabled(val) {
    this._d.getAgent().setMemoryEnabled(val);
    this.persistMemoryEnabled();
  }

  setMemoryMasterEnabled(agentId, val) {
    const ag = this._d.getAgents().get(agentId);
    if (ag) ag.setMemoryMasterEnabled(val);
  }

  persistMemoryEnabled() {
    const session = this._d.getSession();
    const sessPath = session?.sessionManager?.getSessionFile?.();
    if (!sessPath) return;
    const agent = this._d.getAgent();
    const metaPath = path.join(agent.sessionDir, "session-meta.json");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch {}
        const sessKey = path.basename(sessPath);
        meta[sessKey] = { ...(meta[sessKey] || {}), memoryEnabled: agent.sessionMemoryEnabled };
        fs.writeFileSync(metaPath + ".tmp", JSON.stringify(meta, null, 2) + "\n");
        fs.renameSync(metaPath + ".tmp", metaPath);
        return;
      } catch (err) {
        if (attempt === 0) continue;
        console.error("[config] persistMemoryEnabled failed:", err.message);
      }
    }
  }

  // ── Plan Mode ──

  setPlanMode(enabled, allBuiltInTools) {
    this._planMode = !!enabled;
    const session = this._d.getSession();
    if (!session) return;
    const agent = this._d.getAgent();

    if (this._planMode) {
      const customNames = (agent.tools || []).map(t => t.name);
      session.setActiveToolsByName([...READ_ONLY_BUILTIN_TOOLS, ...customNames]);
    } else {
      const allNames = allBuiltInTools.map(t => t.name);
      const customNames = (agent.tools || []).map(t => t.name);
      session.setActiveToolsByName([...allNames, ...customNames]);
    }

    this._d.emitEvent({ type: "plan_mode", enabled: this._planMode }, null);
    this._d.emitDevLog(`Plan Mode: ${this._planMode ? "ON (只读)" : "OFF (正常)"}`, "info");
  }

  // ── updateConfig ──

  async updateConfig(partial) {
    const keys = Object.keys(partial);
    if (keys.length) log.log(`updateConfig: keys=[${keys.join(",")}]`);

    const agent = this._d.getAgent();
    const models = this._d.getModels();

    // agent 负责：写磁盘、刷新身份、刷新模块、重建 prompt
    agent.updateConfig(partial);

    // 模型同步
    if (partial.models) {
      try {
        await this.syncModelsAndRefresh();
      } catch (err) {
        console.error("[config] favorites sync failed:", err.message);
      }
    }

    if (partial.models?.chat) {
      const newModel = models.availableModels.find(m => m.id === partial.models.chat);
      if (newModel) {
        models.defaultModel = newModel;
        models.currentModel = newModel;
        log.log(`default model switched to: ${newModel.name || newModel.id}`);
        const session = this._d.getSession();
        if (session) {
          await session.setModel(newModel);
          session.setThinkingLevel(
            models.resolveThinkingLevel(this.getThinkingLevel())
          );
        }
      }
    }

    if (partial.skills) {
      this._d.getSkills().syncAgentSkills(agent);
    }

    if (partial.desk && "heartbeat_enabled" in partial.desk) {
      const hb = this._d.getHub()?.scheduler?.heartbeat;
      if (hb) {
        if (partial.desk.heartbeat_enabled === false) {
          this._d.emitDevLog("[heartbeat] 巡检已关闭");
          await hb.stop();
        } else {
          this._d.emitDevLog("[heartbeat] 巡检已开启");
          hb.start();
        }
      }
    }
  }

  // ── Provider Migration ──

  migrateProvidersToGlobal(log = () => {}) {
    const YAML_LOAD = (p) => { try { return YAML.load(fs.readFileSync(p, "utf-8")) || {}; } catch { return {}; } };
    const agentsDir = this._d.agentsDir;
    const hanakoHome = this._d.hanakoHome;
    const registryMigrationMarker = path.join(hanakoHome, ".providers-registry-migrated");

    let entries;
    try {
      entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    } catch { return; }

    const agentsToMigrate = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const configPath = path.join(agentsDir, entry.name, "config.yaml");
      if (!fs.existsSync(configPath)) continue;
      const raw = YAML_LOAD(configPath);
      if (!raw.providers || Object.keys(raw.providers).length === 0) {
        const hasInlineApi = raw.api?.api_key && raw.api.api_key.length > 0;
        const hasInlineEmbed = raw.embedding_api?.api_key && raw.embedding_api.api_key.length > 0;
        const hasInlineUtil = raw.utility_api?.api_key && raw.utility_api.api_key.length > 0;
        if (!hasInlineApi && !hasInlineEmbed && !hasInlineUtil) continue;
      }
      agentsToMigrate.push({ id: entry.name, configPath, raw });
    }

    const globalData = loadGlobalProviders();
    const globalProviders = globalData.providers || {};
    let globalChanged = false;
    let registryBackfilled = false;

    const registry = loadModelsRegistry();
    for (const [name, data] of Object.entries(registry.providers || {})) {
      const provider = globalProviders[name] || (globalProviders[name] = {});
      const existingAuthKey = resolveApiKeyFromAuth(name);

      if (data?.baseUrl && !provider.base_url) {
        provider.base_url = data.baseUrl;
        globalChanged = true;
        registryBackfilled = true;
      }
      if (data?.api && !provider.api) {
        provider.api = data.api;
        globalChanged = true;
        registryBackfilled = true;
      }
      if (Array.isArray(data?.models) && data.models.length > 0) {
        const existing = new Set(provider.models || []);
        const before = existing.size;
        for (const model of data.models) {
          const id = typeof model === "string" ? model : model?.id;
          if (id) existing.add(id);
        }
        if (existing.size > before) {
          provider.models = [...existing];
          globalChanged = true;
          registryBackfilled = true;
        }
      }
      if (data?.apiKey && !provider.api_key && !existingAuthKey) {
        provider.api_key = data.apiKey;
        globalChanged = true;
        registryBackfilled = true;
      }
    }

    for (const { id, configPath, raw } of agentsToMigrate) {
      let configChanged = false;

      if (raw.providers) {
        for (const [name, data] of Object.entries(raw.providers)) {
          if (!globalProviders[name]) {
            globalProviders[name] = structuredClone(data);
            globalChanged = true;
          } else {
            if (data.api_key && !globalProviders[name].api_key) {
              globalProviders[name].api_key = data.api_key;
              globalChanged = true;
            }
            if (data.base_url && !globalProviders[name].base_url) {
              globalProviders[name].base_url = data.base_url;
              globalChanged = true;
            }
            if (data.models?.length) {
              const existing = new Set(globalProviders[name].models || []);
              const before = existing.size;
              for (const m of data.models) existing.add(m);
              if (existing.size > before) {
                globalProviders[name].models = [...existing];
                globalChanged = true;
              }
            }
          }
        }
        delete raw.providers;
        configChanged = true;
      }

      for (const block of [raw.api, raw.embedding_api, raw.utility_api]) {
        if (!block) continue;
        if (block.api_key) {
          const provName = typeof block.provider === "string" ? block.provider.trim() : "";
          if (!provName) {
            log.warn("skip inline API migration: missing explicit provider");
            continue;
          }
          if (!globalProviders[provName]) globalProviders[provName] = {};
          if (!globalProviders[provName].api_key) {
            globalProviders[provName].api_key = block.api_key;
            globalChanged = true;
          }
          if (block.base_url && !globalProviders[provName].base_url) {
            globalProviders[provName].base_url = block.base_url;
            globalChanged = true;
          }
          delete block.api_key;
          delete block.base_url;
          configChanged = true;
        }
      }

      if (configChanged) {
        const header = "# Hanako 系统配置\n# 由设置页面管理，手动编辑也可以\n\n";
        const yamlStr = header + YAML.dump(raw, {
          indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"", forceQuotes: false,
        });
        const tmpPath = configPath + ".tmp";
        fs.writeFileSync(tmpPath, yamlStr, "utf-8");
        fs.renameSync(tmpPath, configPath);
        log(`  [migration] ${id}: providers 块已移除，内联凭证已清空`);
      }
    }

    if (globalChanged) {
      const providersPath = path.join(hanakoHome, "providers.yaml");
      const header = "# Hanako 供应商配置（全局，跨 agent 共享）\n# 由设置页面管理\n\n";
      const yamlStr = header + YAML.dump({ providers: globalProviders }, {
        indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"", forceQuotes: false,
      });
      const tmpPath = providersPath + ".tmp";
      fs.writeFileSync(tmpPath, yamlStr, "utf-8");
      fs.renameSync(tmpPath, providersPath);
      log(`  [migration] 全局 providers.yaml 已创建/更新`);
    }

    if (!fs.existsSync(registryMigrationMarker)) {
      fs.writeFileSync(
        registryMigrationMarker,
        `${new Date().toISOString()}\n`,
        "utf-8",
      );
      if (registryBackfilled) {
        log("  [migration] models.json 中缺失的 provider 注册信息已补入 providers.yaml");
      }
    }

    clearConfigCache();
  }

  normalizeUtilityApiPreferences(logFn = null) {
    const prefs = this._prefs();
    const hasOverride =
      !!prefs.utility_api_provider ||
      !!prefs.utility_api_base_url ||
      !!prefs.utility_api_key;
    if (!hasOverride) return false;

    const shared = this.getSharedModels();
    const utilityModelId = shared.utility || this._d.getAgent()?.config?.models?.utility || "";
    const utilityEntry = utilityModelId
      ? this._d.getModels().availableModels.find((m) => m.id === utilityModelId)
      : null;

    let reason = "";
    if (!prefs.utility_api_provider || !prefs.utility_api_base_url || !prefs.utility_api_key) {
      reason = "override incomplete";
    } else if (!utilityEntry?.provider) {
      reason = "utility model unavailable";
    } else if (prefs.utility_api_provider !== utilityEntry.provider) {
      reason = `provider mismatch (${prefs.utility_api_provider} != ${utilityEntry.provider})`;
    }

    if (!reason) return false;

    delete prefs.utility_api_provider;
    delete prefs.utility_api_base_url;
    delete prefs.utility_api_key;
    this._savePrefs(prefs);
    const logger = logFn || log.log.bind(log);
    logger(`[config] cleared invalid utility_api override: ${reason}`);
    return true;
  }

  // ── helpers ──

  _prefs() { return this._d.getPrefs().getPreferences(); }
  _savePrefs(prefs) { return this._d.getPrefs().savePreferences(prefs); }
}
