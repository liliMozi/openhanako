/**
 * ModelManager -- 模型发现、切换、凭证解析
 *
 * 管理 Pi SDK AuthStorage / ModelRegistry 基础设施，
 * 以及模型选择、provider 凭证查找、utility 配置解析。
 * 从 Engine 提取，Engine 通过 manager 访问模型状态。
 *
 * _availableModels 是唯一的模型真理源。所有模型解析、enrichment
 * 都在这个数组上完成，不再经过中间层。
 */
import path from "path";
import { AuthStorage, createModelRegistry } from "../lib/pi-sdk/index.js";
import { t } from "../server/i18n.js";
import { ProviderRegistry } from "./provider-registry.js";
import { ExecutionRouter } from "./execution-router.js";
import { findModel, parseModelRef } from "../shared/model-ref.js";
import { isLocalBaseUrl } from "../shared/net-utils.js";
import { syncModels } from "./model-sync.js";
import { enrichModelFromKnownMetadata } from "./model-known-enrichment.js";

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
    this._availableModels = [];

    // 新架构模块（init() 后可用）
    this.providerRegistry = new ProviderRegistry(hanakoHome);
    this.executionRouter = null;
  }

  /** 初始化 AuthStorage + ModelRegistry + 新架构模块 */
  init() {
    this._authStorage = AuthStorage.create(path.join(this._hanakoHome, "auth.json"));
    this.providerRegistry.reload();
    this._removeApiKeyProviderAuthEntries();
    this._modelRegistry = createModelRegistry(
      this._authStorage,
      path.join(this._hanakoHome, "models.json"),
    );

    this.executionRouter = new ExecutionRouter(
      (ref) => this._resolveFromAvailable(ref),
      this.providerRegistry,
    );
  }

  // ── Getters ──

  get authStorage() { return this._authStorage; }
  get modelRegistry() { return this._modelRegistry; }
  get defaultModel() { return this._defaultModel; }
  set defaultModel(m) { this._defaultModel = m; }
  get currentModel() { return this._defaultModel; }
  get availableModels() { return this._availableModels; }
  get modelsJsonPath() { return path.join(this._hanakoHome, "models.json"); }
  get authJsonPath() { return path.join(this._hanakoHome, "auth.json"); }

  // ── 模型解析：_availableModels 唯一真理源 ──

  /**
   * 从 _availableModels 解析模型引用。
   *
   * 合法输入（通过 parseModelRef 规整后必须带 provider）：
   *   - {id, provider} 对象
   *   - "provider/id" 字符串
   *
   * 裸 id 字符串**不合法**——历史数据走 migrations #5，运行期调用方必须显式带 provider。
   * ref 无法解析出 provider 时返 null（不按 id 降级猜）。
   *
   * @param {string|object} ref - 模型引用
   * @returns {object|null} SDK 模型对象
   */
  _resolveFromAvailable(ref) {
    const parsed = parseModelRef(ref);
    if (!parsed?.id || !parsed.provider) return null;
    return findModel(this._availableModels, parsed.id, parsed.provider) || null;
  }

  // ── 刷新 ──

  /** 刷新可用模型列表，用 added-models.yaml 过滤 */
  async refreshAvailable() {
    const allModels = await this._modelRegistry.getAvailable();
    // Pi SDK 返回所有有 auth 的模型（包括 OAuth 内置模型），
    // 但用户只想看自己配置的模型。用 added-models.yaml 的模型列表过滤。
    const rawProviders = this.providerRegistry.getAllProvidersRaw();
    const userModelSets = new Map();
    for (const [name, raw] of Object.entries(rawProviders)) {
      if (!raw.models?.length) continue;
      const ids = new Set(raw.models.map(m => typeof m === "object" ? m.id : m));
      userModelSets.set(name, ids);
      // OAuth provider 的 authJsonKey 可能不同于 provider ID
      const authKey = this.providerRegistry.getAuthJsonKey(name);
      if (authKey !== name) userModelSets.set(authKey, ids);
    }
    this._availableModels = allModels.filter(m => {
      const allowed = userModelSets.get(m.provider);
      // 没有在 added-models.yaml 里的 provider → 全部放行（兼容未知来源）
      if (!allowed) return true;
      return allowed.has(m.id);
    }).map(enrichModelFromKnownMetadata);
    return this._availableModels;
  }

  /**
   * 同步 added-models.yaml → models.json，然后刷新 ModelRegistry。
   *
   * ⚠ 刷新后 _availableModels 是全新数组，旧的 model 对象引用（含烤在字段里的
   * 过期 baseUrl）会失效。本方法负责把 _defaultModel 指针也重新定位到新数组里
   * 的对应对象——否则新建 session 会继续用旧 baseUrl 发请求（provider 改端点后
   * 出现 429 的根因）。
   *
   * @returns {boolean} 是否有变化
   */
  async syncAndRefresh() {
    this._removeApiKeyProviderAuthEntries();
    const rawProviders = this.providerRegistry.getAllProvidersRaw();
    // 合并 plugin 默认值（base_url/api），YAML 里可能只存了 api_key + models
    const providers = {};
    for (const [name, raw] of Object.entries(rawProviders)) {
      const entry = this.providerRegistry.get(name);
      providers[name] = {
        ...raw,
        base_url: raw.base_url || entry?.baseUrl || "",
        api: raw.api || entry?.api || "openai-completions",
        auth_type: raw.auth_type || entry?.authType || "api-key",
      };
    }
    const changed = syncModels(providers, {
      modelsJsonPath: this.modelsJsonPath,
      authJsonPath: this.authJsonPath,
      oauthKeyMap: this._buildOAuthKeyMap(),
    });
    if (changed) {
      this._modelRegistry.refresh();
      await this.refreshAvailable();
      this._rebindDefaultModel();
    }
    return changed;
  }

  /**
   * _availableModels 重建后，把 _defaultModel 重新绑到新数组里的对应对象。
   * 找不到则置 null（provider 被删、模型消失等）。
   * @private
   */
  _rebindDefaultModel() {
    if (!this._defaultModel) return;
    const { id, provider } = this._defaultModel;
    if (!id || !provider) {
      this._defaultModel = null;
      return;
    }
    this._defaultModel = findModel(this._availableModels, id, provider) || null;
  }

  /**
   * 构建 OAuth providerId → auth.json key 映射
   * @private
   */
  _buildOAuthKeyMap() {
    const map = {};
    for (const id of this.providerRegistry.getOAuthProviderIds()) {
      const authKey = this.providerRegistry.getAuthJsonKey(id);
      if (authKey !== id) map[id] = authKey;
    }
    return map;
  }

  /**
   * Hana 的 API-key provider 凭证源是 added-models.yaml → models.json。
   * AuthStorage 只保留 OAuth 条目，避免 Pi SDK 优先读取 stale auth.json。
   * @private
   */
  _removeApiKeyProviderAuthEntries() {
    if (!this._authStorage || !this.providerRegistry) return;
    this._authStorage.reload?.();

    for (const entry of this.providerRegistry.getAll().values()) {
      if (entry.authType === "oauth") continue;
      const authKeys = new Set([entry.id, entry.authJsonKey]);
      for (const authKey of authKeys) {
        if (!authKey || !this._authStorage.has?.(authKey)) continue;
        this._authStorage.remove(authKey);
      }
    }
  }

  /**
   * 设置 agent 默认模型
   * @returns {object} 新模型对象
   */
  setDefaultModel(modelId, provider) {
    const model = findModel(this._availableModels, modelId, provider);
    if (!model) throw new Error(t("error.modelNotFound", { id: modelId }));
    this._defaultModel = model;
    return model;
  }

  /** auto -> medium，其余原样 */
  resolveThinkingLevel(level) {
    return level === "auto" ? "medium" : level;
  }

  /**
   * 将模型引用（provider/id 或 {id, provider}）解析成 SDK 可用的模型对象
   * 只查 _availableModels（唯一真理源）
   */
  resolveExecutionModel(modelRef) {
    if (!modelRef) return this.currentModel;
    if (typeof modelRef === "string" && !modelRef.trim()) return this.currentModel;

    const parsed = parseModelRef(modelRef);
    let model = parsed?.id && parsed.provider
      ? findModel(this._availableModels, parsed.id, parsed.provider)
      : null;
    if (model) return model;

    if (typeof modelRef === "string") {
      const rawId = modelRef.trim();
      if (rawId.includes("/")) {
        const exactIdMatches = this._availableModels.filter(m => m.id === rawId);
        if (exactIdMatches.length === 1) {
          model = exactIdMatches[0];
        }
      }
    }

    if (model) return model;

    const id = parsed?.id
      ? (parsed.provider ? `${parsed.provider}/${parsed.id}` : parsed.id)
      : String(modelRef);
    throw new Error(t("error.modelNotFound", { id }));
  }

  /**
   * 根据 provider 名称查找凭证
   * 委托 ProviderRegistry，返回 snake_case 格式（兼容 callProviderText 消费方）
   * @param {string} provider
   * @returns {{ api_key: string, base_url: string, api: string }}
   */
  resolveProviderCredentials(provider) {
    if (!provider) return { api_key: "", base_url: "", api: "" };
    const cred = this.providerRegistry.getCredentials(provider);
    if (cred) {
      return { api_key: cred.apiKey || "", base_url: cred.baseUrl || "", api: cred.api || "" };
    }
    return { api_key: "", base_url: "", api: "" };
  }

  /**
   * Provider 配置变更后 reload registry + 重新同步模型。
   * 由 engine.onProviderChanged() 调用，不要直接用。
   */
  async reloadAndSync() {
    this.providerRegistry.reload();
    await this.syncAndRefresh();
  }

  /**
   * 统一解析：模型引用 -> { model, provider, api, api_key, base_url }
   *
   * model 字段是**完整 model 对象**（不再是裸 id 字符串）。所有 callText 消费方
   * 解构出 model 后直接传给 callText，由 callText 内部走 provider-compat。
   *
   * @param {string|object} modelRef
   * @returns {{ model: object, provider: string, api: string, api_key: string, base_url: string }}
   */
  resolveModelWithCredentials(modelRef) {
    const entry = this.resolveExecutionModel(modelRef);
    const provider = entry?.provider;
    if (!provider) {
      throw new Error(t("error.modelNoProvider", { role: "resolve", model: String(modelRef) }));
    }
    const creds = this.resolveProviderCredentials(provider);
    if (!creds.api) {
      throw new Error(t("error.providerMissingApi", { provider }));
    }
    const allowsMissingApiKey = this.providerRegistry?.allowsMissingApiKey?.(provider, creds.base_url)
      ?? isLocalBaseUrl(creds.base_url);
    if (!creds.base_url || (!creds.api_key && !allowsMissingApiKey)) {
      throw new Error(t("error.providerMissingCreds", { provider }));
    }
    return {
      model: entry,
      provider,
      api: creds.api,
      api_key: creds.api_key,
      base_url: creds.base_url,
    };
  }

  /**
   * 解析 utility 模型 + API 凭证完整配置
   * 委托 ExecutionRouter
   */
  resolveUtilityConfig(agentConfig, sharedModels, utilApi) {
    if (!this.executionRouter) {
      throw new Error(t("error.noUtilityModel"));
    }
    return this.executionRouter.resolveUtilityConfig(agentConfig, sharedModels, utilApi);
  }

  /**
   * 从 Pi SDK registry 获取某 provider 的所有模型（不经过 added-models.yaml 过滤）
   * 用于模型发现（fetch-models），不影响主应用的 availableModels
   * @param {string} name - provider ID
   * @returns {object[]}
   */
  getRegistryModelsForProvider(name) {
    const authKey = this.providerRegistry.getAuthJsonKey(name);
    const all = this._modelRegistry.getAll();
    return all.filter(m => m.provider === name || m.provider === authKey);
  }
}
