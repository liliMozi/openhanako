/**
 * ConfigCoordinator — 运行时配置管理
 *
 * 负责 per-agent 模型选择、共享模型角色、搜索/utility 配置、
 * session meta 持久化、updateConfig 联动。
 * 不持有 engine 引用，通过构造器注入依赖。
 */
import fs from "fs";
import path from "path";
import os from "os";
import { createModuleLogger } from "../lib/debug-log.js";
import { saveConfig } from "../lib/memory/config-loader.js";
import { findModel, parseModelRef } from "../shared/model-ref.js";
import { t } from "../server/i18n.js";

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
   * @param {(id: string) => object|null} deps.getAgentById - 按 ID 查找 agent
   * @param {() => string} deps.getActiveAgentId - 当前焦点 agent ID
   * @param {() => Map} deps.getAgents - 所有 agent Map
   * @param {() => import('./model-manager.js').ModelManager} deps.getModels
   * @param {() => import('./preferences-manager.js').PreferencesManager} deps.getPrefs
   * @param {() => import('./skill-manager.js').SkillManager} deps.getSkills
   * @param {() => object|null} deps.getSession - 当前 session
   * @param {() => import('./session-coordinator.js').SessionCoordinator|null} deps.getSessionCoordinator
   * @param {() => object|null} deps.getHub
   * @param {(event, sp) => void} deps.emitEvent
   * @param {(text, level?) => void} deps.emitDevLog
   * @param {() => string|null} deps.getCurrentModel - currentModel name
   */
  constructor(deps) {
    this._d = deps;
  }

  // ── Home Folder ──

  /**
   * @param {string} [agentId] - 指定 agent；省略时查主 agent
   * @returns {string} 工作目录（保证返回有效路径）
   */
  getHomeFolder(agentId) {
    // 1. 指定 agent 自己的 config
    if (agentId) {
      const agent = this._d.getAgentById(agentId);
      const folder = agent?.config?.desk?.home_folder;
      if (folder && fs.existsSync(folder)) return folder;
    }

    // 2. 主 agent 的 config
    const primaryId = this._getPrimaryAgentId();
    if (primaryId && primaryId !== agentId) {
      const primary = this._d.getAgentById(primaryId);
      const folder = primary?.config?.desk?.home_folder;
      if (folder && fs.existsSync(folder)) return folder;
    }

    // 3. 硬编码 fallback
    return path.join(os.homedir(), "Desktop");
  }

  /**
   * @param {string} agentId
   * @param {string|null} folder
   */
  setHomeFolder(agentId, folder) {
    const agent = this._d.getAgentById(agentId);
    if (!agent) {
      log.warn(`setHomeFolder: agent ${agentId} not found`);
      return;
    }
    if (folder) {
      agent.updateConfig({ desk: { home_folder: folder } });
    } else {
      // null 值触发 deepMerge 的 key 删除逻辑
      agent.updateConfig({ desk: { home_folder: null } });
    }
    log.log(`setHomeFolder(${agentId}): ${folder || "(cleared)"}`);
  }

  // ── Shared Models ──

  getSharedModels() {
    const prefs = this._prefs();
    const result = {};
    for (const [field, prefKey] of SHARED_MODEL_KEYS) {
      const raw = prefs[prefKey];
      if (typeof raw === "object" && raw?.id) {
        result[field] = raw;  // new format {id, provider}
      } else if (raw) {
        result[field] = raw;  // old format string — kept as-is for backward compat
      } else {
        result[field] = null;
      }
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
        const v = partial[field];
        const repr = !v ? "(cleared)"
          : typeof v === "object" ? `${v.provider || "?"}/${v.id || "?"}`
          : String(v);
        changed.push(`${field}=${repr}`);
      }
    }
    this._savePrefs(prefs);
    if (changed.length) {
      const fresh = this.getSharedModels();
      const agent = this._d.getAgent();
      agent.setUtilityModel(fresh.utility || null);
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

  async syncAndRefresh() {
    const models = this._d.getModels();
    const synced = await models.syncAndRefresh();
    this.normalizeUtilityApiPreferences();
    return synced;
  }

  /**
   * 暂存用户选择的模型，用于下次 createSession。
   * 不修改当前活跃 session 的模型，不持久化到 config.yaml。
   */
  setPendingModel(modelId, provider) {
    if (!modelId || !provider) {
      throw new Error(`setPendingModel: modelId and provider both required (got ${modelId}, ${provider})`);
    }
    const models = this._d.getModels();
    const model = findModel(models.availableModels, modelId, provider);
    if (!model) throw new Error(t("error.modelNotFound", { id: `${provider}/${modelId}` }));
    const sessionCoord = this._d.getSessionCoordinator();
    sessionCoord?.setPendingModel(model);
    return model;
  }

  /**
   * 设置 agent 默认模型（设置页面操作）。
   * 更新 ModelManager._defaultModel + 持久化到 config.yaml。
   * 不修改任何已有 session 的模型。
   *
   * provider 必填——setDefaultModel 不做按 id 猜 provider 的兜底。
   */
  setDefaultModel(modelId, provider) {
    if (!modelId || !provider) {
      throw new Error(`setDefaultModel: modelId and provider both required (got ${modelId}, ${provider})`);
    }
    const models = this._d.getModels();
    const model = models.setDefaultModel(modelId, provider);
    const agent = this._d.getAgent();
    if (agent?.configPath) {
      saveConfig(agent.configPath, {
        models: { chat: { id: modelId, provider } },
      });
    }
    log.log(`default model set to: ${model.provider}/${model.id}`);
    return model;
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
    this.persistSessionMeta();
  }

  setMemoryMasterEnabled(agentId, val) {
    const ag = this._d.getAgents().get(agentId);
    if (ag) ag.setMemoryMasterEnabled(val);
  }

  persistSessionMeta() {
    const session = this._d.getSession();
    const sessPath = session?.sessionManager?.getSessionFile?.();
    if (!sessPath) return;
    const agent = this._d.getAgent();
    const sessionCoord = this._d.getSessionCoordinator();
    return sessionCoord.writeSessionMeta(sessPath, {
      memoryEnabled: agent.memoryEnabled,
    });
  }

  // ── updateConfig ──

  async updateConfig(partial, { agentId } = {}) {
    const keys = Object.keys(partial);
    if (keys.length) log.log(`updateConfig: keys=[${keys.join(",")}]${agentId ? ` agentId=${agentId}` : ""}`);

    // 如果指定了 agentId，刷新该 agent；否则刷新焦点 agent
    const agent = (agentId && this._d.getAgentById?.(agentId)) || this._d.getAgent();
    const models = this._d.getModels();
    const isFocusAgent = !agentId || agentId === this._d.getActiveAgentId?.();

    // agent 负责：写磁盘、刷新身份、刷新模块、重建 prompt
    agent.updateConfig(partial);

    // 模型切换只在焦点 agent 时生效。migration #5 之后 models.chat 必为
    // {id, provider} 对象；缺 provider 直接忽略并告警（调用方应传完整复合键）。
    if (isFocusAgent && partial.models?.chat) {
      const parsed = parseModelRef(partial.models.chat);
      if (!parsed?.id || !parsed?.provider) {
        log.warn(`updateConfig: models.chat 缺少 provider，已忽略 (got ${JSON.stringify(partial.models.chat)})`);
      } else {
        const newModel = findModel(models.availableModels, parsed.id, parsed.provider);
        if (newModel) {
          // 只更新 agent 默认模型，不改活跃 session
          models.defaultModel = newModel;
          log.log(`default model updated to: ${newModel.provider}/${newModel.id}`);
        }
      }
    }

    if (partial.skills) {
      this._d.getSkills().syncAgentSkills(agent);
    }

    // desk（heartbeat 等）联动对应 agent 的 heartbeat
    if (partial.desk) {
      const scheduler = this._d.getHub()?.scheduler;
      const resolvedAgentId = agentId || this._d.getActiveAgentId?.();
      if ("heartbeat_interval" in partial.desk && scheduler) {
        this._d.emitDevLog(`[heartbeat] 巡检间隔已更新: ${partial.desk.heartbeat_interval} 分钟`);
        await scheduler.reloadHeartbeat(resolvedAgentId);
      } else if ("heartbeat_enabled" in partial.desk) {
        const hb = scheduler?.getHeartbeat(resolvedAgentId);
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
      }
    }
  }

  normalizeUtilityApiPreferences(logFn = null) {
    const prefs = this._prefs();
    const hasOverride =
      !!prefs.utility_api_provider ||
      !!prefs.utility_api_base_url ||
      !!prefs.utility_api_key;
    if (!hasOverride) return false;

    const shared = this.getSharedModels();
    const utilityRef = shared.utility || this._d.getAgent()?.config?.models?.utility || null;
    const parsed = parseModelRef(utilityRef);
    const utilityEntry = (parsed?.id && parsed?.provider)
      ? findModel(this._d.getModels().availableModels, parsed.id, parsed.provider)
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

  // ── Heartbeat Master ──

  getHeartbeatMaster() {
    return this._prefs().heartbeat_master !== false;
  }

  setHeartbeatMaster(enabled) {
    const prefs = this._prefs();
    prefs.heartbeat_master = !!enabled;
    this._savePrefs(prefs);
    log.log(`setHeartbeatMaster: ${enabled}`);

    // 联动 scheduler：启停所有 agent 的 heartbeat
    const scheduler = this._d.getHub()?.scheduler;
    if (!scheduler) return;
    const agents = this._d.getAgents();
    for (const [, agent] of agents) {
      const hb = scheduler.getHeartbeat(agent.id);
      if (!hb) continue;
      if (!enabled) {
        hb.stop();
      } else if (agent.config?.desk?.heartbeat_enabled !== false) {
        hb.start();
      }
    }
  }

  // ── helpers ──

  _getPrimaryAgentId() {
    const prefsManager = this._d.getPrefs();
    if (typeof prefsManager.getPrimaryAgent === 'function') {
      return prefsManager.getPrimaryAgent();
    }
    const prefs = this._prefs();
    return prefs.primaryAgent || null;
  }

  _prefs() { return this._d.getPrefs().getPreferences(); }
  _savePrefs(prefs) { return this._d.getPrefs().savePreferences(prefs); }
}
