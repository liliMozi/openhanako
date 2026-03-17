/**
 * ModelManager — 模型发现、切换、凭证解析
 *
 * 管理 Pi SDK AuthStorage / ModelRegistry 基础设施，
 * 以及模型选择、provider 凭证查找、utility 配置解析。
 * 从 Engine 提取，Engine 通过 manager 访问模型状态。
 */
import path from "path";
import {
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { registerOAuthProvider } from "@mariozechner/pi-ai/oauth";
import { minimaxOAuthProvider } from "../lib/oauth/minimax-portal.js";
import { openaiCodexOAuthProvider } from "../lib/oauth/openai-codex.js";
import { clearConfigCache, loadGlobalProviders, resolveApiKeyFromAuth } from "../lib/memory/config-loader.js";

function isLocalBaseUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(String(url || ""));
}

export class ModelManager {
  /**
   * @param {object} opts
   * @param {string} opts.hanakoHome - 用户数据根目录
   */
  constructor({ hanakoHome }) {
    this._hanakoHome = hanakoHome;
    this._authStorage = null;
    this._modelRegistry = null;
    this._defaultModel = null;   // 设置页面选的，持久化，bridge 用这个
    this._sessionModel = null;   // 聊天页面临时切的，只影响桌面端
    this._availableModels = [];
  }

  /** 初始化 AuthStorage + ModelRegistry */
  init() {
    this._authStorage = AuthStorage.create(path.join(this._hanakoHome, "auth.json"));
    registerOAuthProvider(minimaxOAuthProvider);
    registerOAuthProvider(openaiCodexOAuthProvider);
    this._modelRegistry = new ModelRegistry(
      this._authStorage,
      path.join(this._hanakoHome, "models.json"),
    );
  }

  // ── Getters ──

  get authStorage() { return this._authStorage; }
  get modelRegistry() { return this._modelRegistry; }
  get defaultModel() { return this._defaultModel; }
  set defaultModel(m) { this._defaultModel = m; }
  get currentModel() { return this._sessionModel || this._defaultModel; }
  set currentModel(m) { this._sessionModel = m; }
  get availableModels() { return this._availableModels; }
  get modelsJsonPath() { return path.join(this._hanakoHome, "models.json"); }
  get authJsonPath() { return path.join(this._hanakoHome, "auth.json"); }

  /** 刷新可用模型列表 */
  async refreshAvailable() {
    this._availableModels = await this._modelRegistry.getAvailable();
    return this._availableModels;
  }

  /**
   * 同步 favorites → models.json，然后刷新 ModelRegistry
   * @param {string} configPath - agent config.yaml 路径
   * @param {object} opts
   * @returns {boolean}
   */
  async syncModelsAndRefresh(configPath, { favorites, sharedModels, authJsonPath }) {
    const { syncFavoritesToModelsJson } = await import("./sync-favorites.js");
    const synced = syncFavoritesToModelsJson(configPath, {
      modelsJsonPath: this.modelsJsonPath,
      favorites,
      sharedModels,
      authJsonPath: authJsonPath || this.authJsonPath,
    });
    if (synced) {
      clearConfigCache();
      this._modelRegistry.refresh();
      // refresh() 内部会 reset OAuth providers，所以本地覆写需要补回去。
      registerOAuthProvider(minimaxOAuthProvider);
      registerOAuthProvider(openaiCodexOAuthProvider);
      this._availableModels = await this._modelRegistry.getAvailable();
    }
    return synced;
  }

  /**
   * 切换当前模型（只改状态，不推到 session）
   * @returns {object} 新模型对象
   */
  setModel(modelId) {
    const model = this._availableModels.find(m => m.id === modelId);
    if (!model) throw new Error(`找不到模型: ${modelId}`);
    this._sessionModel = model;
    return model;
  }

  /** auto → medium，其余原样 */
  resolveThinkingLevel(level) {
    return level === "auto" ? "medium" : level;
  }

  /**
   * 将模型引用（id/name/object）解析成 SDK 可用的模型对象
   */
  resolveExecutionModel(modelRef) {
    if (!modelRef) return this.currentModel;
    if (typeof modelRef !== "string") return modelRef;
    const ref = modelRef.trim();
    if (!ref) return this.currentModel;
    const model = this._availableModels.find(m => m.id === ref || m.name === ref);
    if (!model) throw new Error(`找不到模型: ${ref}`);
    return model;
  }

  /** 根据模型 ID 推断其所属 provider */
  inferModelProvider(modelId) {
    return modelId ? this._availableModels.find(m => m.id === modelId)?.provider : null;
  }

  /**
   * 根据 provider 名称查找凭证
   * 查找顺序：全局 providers.yaml → config.yaml providers 块
   * @param {string} provider
   * @param {object} [agentConfig] - agent 的 config 对象
   */
  resolveProviderCredentials(provider, agentConfig) {
    if (!provider) return { api_key: "", base_url: "", api: "" };
    let api_key = "", base_url = "", api = "";

    const globalProviders = loadGlobalProviders();
    const gp = globalProviders.providers?.[provider];
    if (gp?.api_key) api_key = gp.api_key;
    if (gp?.base_url) base_url = gp.base_url;
    if (gp?.api) api = gp.api;

    if ((!api_key || !base_url || !api) && agentConfig) {
      const provBlock = agentConfig.providers?.[provider];
      if (!api_key && provBlock?.api_key) api_key = provBlock.api_key;
      if (!base_url && provBlock?.base_url) base_url = provBlock.base_url;
      if (!api && provBlock?.api) api = provBlock.api;
    }

    if (!api_key) {
      api_key = resolveApiKeyFromAuth(provider);
    }

    return { api_key, base_url, api };
  }

  /**
   * 解析 utility 模型 + API 凭证完整配置
   * @param {object} agentConfig - agent config
   * @param {object} sharedModels - getSharedModels() 结果
   * @param {object} utilApi - getUtilityApi() 结果
   */
  resolveUtilityConfig(agentConfig, sharedModels, utilApi) {
    const cfg = agentConfig || {};

    const utilityModel = sharedModels?.utility || cfg.models?.utility;
    if (!utilityModel) {
      throw new Error("未配置 utility 模型，请在设置中添加");
    }
    const largeModel = sharedModels?.utility_large || cfg.models?.utility_large;
    if (!largeModel) {
      throw new Error("未配置 utility_large 模型，请在设置中添加");
    }

    const utilityEntry = this.resolveExecutionModel(utilityModel);
    const largeEntry = this.resolveExecutionModel(largeModel);
    const utilProvider = utilityEntry?.provider || "";
    const largeProvider = largeEntry?.provider || "";

    if (!utilProvider) {
      throw new Error(`utility 模型 "${utilityModel}" 没有 provider 归属`);
    }
    if (!largeProvider) {
      throw new Error(`utility_large 模型 "${largeModel}" 没有 provider 归属`);
    }

    let api_key = "";
    let base_url = "";
    let api = "";
    if (utilApi?.provider || utilApi?.api_key || utilApi?.base_url) {
      if (utilApi.provider !== utilProvider) {
        throw new Error(`utility_api.provider 必须与模型 "${utilityModel}" 的 provider 一致`);
      }
      const providerConfig = this.resolveProviderCredentials(utilProvider, cfg);
      api = providerConfig.api || "";
      api_key = utilApi.api_key || "";
      base_url = utilApi.base_url || "";
      if (!api) {
        throw new Error(`provider "${utilProvider}" 缺少 API 协议配置`);
      }
      if (!base_url || (!api_key && !isLocalBaseUrl(base_url))) {
        throw new Error(`utility_api 缺少完整凭证（provider: ${utilProvider}）`);
      }
    } else {
      const creds = this.resolveProviderCredentials(utilProvider, cfg);
      api_key = creds.api_key;
      base_url = creds.base_url;
      api = creds.api;
      if (!api) {
        throw new Error(`provider "${utilProvider}" 缺少 API 协议配置`);
      }
      if (!base_url || (!api_key && !isLocalBaseUrl(base_url))) {
        throw new Error(`provider "${utilProvider}" 缺少完整凭证`);
      }
    }

    // utility_large 凭证：provider 相同则复用，不同则独立解析
    let large_api_key = api_key, large_base_url = base_url, large_api = api;
    if (largeProvider && largeProvider !== utilProvider) {
      const creds = this.resolveProviderCredentials(largeProvider, cfg);
      large_api_key = creds.api_key;
      large_base_url = creds.base_url;
      large_api = creds.api;
      if (!large_api) {
        throw new Error(`provider "${largeProvider}" 缺少 API 协议配置`);
      }
      if (!large_base_url || (!large_api_key && !isLocalBaseUrl(large_base_url))) {
        throw new Error(`provider "${largeProvider}" 缺少完整凭证`);
      }
    }

    return {
      utility: utilityModel,
      utility_large: largeModel,
      api_key,
      base_url,
      api,
      large_api_key,
      large_base_url,
      large_api,
    };
  }
}
