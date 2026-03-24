/**
 * ModelManager -- 模型发现、切换、凭证解析
 *
 * 管理 Pi SDK AuthStorage / ModelRegistry 基础设施，
 * 以及模型选择、provider 凭证查找、utility 配置解析。
 * 从 Engine 提取，Engine 通过 manager 访问模型状态。
 *
 * _availableModels 是唯一的模型真理源。所有模型解析、enrichment、
 * default-models 回灌都在这个数组上完成，不再经过中间层。
 */
import path from "path";
import { readFileSync } from "fs";
import {
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { registerOAuthProvider } from "@mariozechner/pi-ai/oauth";
import { minimaxOAuthProvider } from "../lib/oauth/minimax-portal.js";
import { clearConfigCache, loadGlobalProviders } from "../lib/memory/config-loader.js";
import { t } from "../server/i18n.js";
import { ProviderRegistry } from "./provider-registry.js";
import { AuthStore } from "./auth-store.js";
import { ExecutionRouter } from "./execution-router.js";
import { fromRoot } from "../shared/hana-root.js";
import { syncFavoritesToModelsJson } from "./sync-favorites.js";

const _knownModels = JSON.parse(readFileSync(fromRoot("lib", "known-models.json"), "utf-8"));

function isLocalBaseUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(String(url || ""));
}

function humanizeName(id) {
  let name = id.replace(/-(\d{6})$/, "");
  name = name.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  name = name.replace(/(\d) (\d)/g, "$1.$2");
  return name;
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

    // 新架构模块（init() 后可用）
    this.providerRegistry = new ProviderRegistry(hanakoHome);
    this._overridesGetter = null;
    this.authStore = null;
    this.executionRouter = null;
  }

  /** 初始化 AuthStorage + ModelRegistry + 新架构模块 */
  init() {
    this._authStorage = AuthStorage.create(path.join(this._hanakoHome, "auth.json"));
    registerOAuthProvider(minimaxOAuthProvider);
    this._modelRegistry = new ModelRegistry(
      this._authStorage,
      path.join(this._hanakoHome, "models.json"),
    );

    this.providerRegistry.reload();
    this.authStore = new AuthStore(this._hanakoHome, this.providerRegistry);
    this.authStore.load();
    this.executionRouter = new ExecutionRouter(
      (ref) => this._resolveFromAvailable(ref),
      this.authStore,
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

  /** 注入 PreferencesManager 引用（engine init 时调用） */
  setPreferences(prefs) { this._prefs = prefs; }

  /** 注入用户模型覆盖源（从 agent config.models.overrides 动态读取） */
  setOverridesGetter(fn) { this._overridesGetter = fn; }

  // ── 模型解析：_availableModels 唯一真理源 ──

  /**
   * 从 _availableModels 解析模型引用
   * 支持两种输入：
   *   1. "provider/model" 格式（精确匹配 provider + id）
   *   2. 裸 model ID（匹配 id 或 name）
   * 不做模糊 fallback，避免静默绑到错误 provider。
   * @param {string} ref - 模型引用字符串
   * @returns {object|null} SDK 模型对象
   */
  _resolveFromAvailable(ref) {
    if (!ref || typeof ref !== "string") return null;
    const str = ref.trim();
    if (!str) return null;

    // 层级 1：尝试 "provider/model" 分割匹配（首个 / 做切分）
    if (str.includes("/")) {
      const slashIdx = str.indexOf("/");
      const providerPart = str.slice(0, slashIdx);
      const modelPart = str.slice(slashIdx + 1);
      const match = this._availableModels.find(
        m => m.provider === providerPart && m.id === modelPart,
      );
      if (match) return match;
    }

    // 层级 2：完整字符串作为裸 model ID 匹配
    // 覆盖两种情况：
    //   a) 纯裸 ID（如 "qwen3.5-flash"）
    //   b) OpenRouter 风格 ID（如 "anthropic/claude-opus-4-6" 是 id 本身）
    return this._availableModels.find(m => m.id === str || m.name === str) || null;
  }

  // ── 增强管线 ──

  /**
   * 用 known-models.json 修正 _availableModels 中的 contextWindow / maxTokens / name
   * 供应商 /v1/models 返回的 context_length 经常不准确（如 MiMo 返回 131072 但实际 1M）
   * known-models.json 作为权威来源覆盖
   * @private
   */
  _enrichFromKnownModels() {
    for (const m of this._availableModels) {
      const known = _knownModels[m.id];
      if (!known) continue;
      if (known.context && known.context > (m.contextWindow || 0)) {
        m.contextWindow = known.context;
      }
      if (known.maxOutput && known.maxOutput > (m.maxTokens || 0)) {
        m.maxTokens = known.maxOutput;
      }
      // 补充 name（如果还是裸 ID）
      if (known.name && (!m.name || m.name === m.id)) {
        m.name = known.name;
      }
    }
  }

  /**
   * 应用用户手动设置的模型覆盖（config.models.overrides）
   * 优先级：用户覆盖 > known-models > API 返回值
   * @private
   */
  _applyUserOverrides() {
    const overrides = this._overridesGetter?.();
    if (!overrides || typeof overrides !== "object") return;
    for (const m of this._availableModels) {
      const ov = overrides[m.id];
      if (!ov) continue;
      if (ov.context) m.contextWindow = ov.context;
      if (ov.maxOutput) m.maxTokens = ov.maxOutput;
      if (ov.displayName) m.name = ov.displayName;
    }
  }

  /**
   * 对有凭证但 _availableModels 中无模型的 provider，从 default-models.json 注入默认模型
   * 构造最小 SDK 模型对象（从 known-models.json 补元数据）
   * @private
   */
  _mergeDefaultModels() {
    // 收集 _availableModels 中已有的 provider
    const existingProviders = new Set(this._availableModels.map(m => m.provider).filter(Boolean));
    // 用 provider+id 双重去重
    const existingKeys = new Set(
      this._availableModels.map(m => m.provider ? `${m.provider}/${m.id}` : m.id),
    );

    const allProviders = this.providerRegistry.getAll();
    for (const [providerId, provEntry] of allProviders) {
      // 只给有凭证但无模型的 provider 注入（或补全缺失的默认模型）
      const defaults = this.providerRegistry.getDefaultModels(providerId);
      if (!defaults || defaults.length === 0) continue;

      for (const modelId of defaults) {
        const key = `${providerId}/${modelId}`;
        if (existingKeys.has(key)) continue;
        // 也检查裸 id（向后兼容）
        if (existingKeys.has(modelId)) continue;

        const known = _knownModels[modelId];
        this._availableModels.push({
          id: modelId,
          name: known?.name || humanizeName(modelId),
          provider: providerId,
          baseUrl: provEntry.baseUrl || "",
          api: provEntry.api || "openai-completions",
          input: ["text", "image"],
          contextWindow: known?.context || 128_000,
          maxTokens: known?.maxOutput || undefined,
          reasoning: false,
        });
        existingKeys.add(key);
      }
    }
  }

  // ── 刷新 ──

  /** 刷新可用模型列表 */
  async refreshAvailable() {
    this._availableModels = await this._modelRegistry.getAvailable();
    this._injectOAuthCustomModels();
    this._mergeDefaultModels();
    this._enrichFromKnownModels();
    this._applyUserOverrides();
    this.authStore?.load();
    return this._availableModels;
  }

  /**
   * 将用户为 OAuth provider 添加的自定义模型注入到 availableModels
   * 从同 provider 的已有模型克隆 baseUrl / api / cost 等属性
   */
  _injectOAuthCustomModels() {
    const custom = this._prefs?.getOAuthCustomModels?.() || {};
    for (const [provider, modelIds] of Object.entries(custom)) {
      if (!Array.isArray(modelIds) || modelIds.length === 0) continue;
      // 找同 provider 的模板模型（继承 baseUrl、api、cost 等）
      let template = this._availableModels.find(m => m.provider === provider);
      if (!template) {
        // 无已有模型时从 providers.yaml 构建最小模板
        const gp = loadGlobalProviders().providers?.[provider];
        if (!gp?.base_url || !gp?.api) continue;
        template = {
          provider,
          baseUrl: gp.base_url,
          api: gp.api,
          input: ["text", "image"],
          contextWindow: 128_000,
        };
      }
      const existing = new Set(this._availableModels.filter(m => m.provider === provider).map(m => m.id));
      for (const id of modelIds) {
        if (existing.has(id)) continue;
        this._availableModels.push({
          ...template,
          id,
          name: id,
        });
      }
    }
  }

  /**
   * 同步 favorites -> models.json，然后刷新 ModelRegistry
   * @param {string} configPath - agent config.yaml 路径
   * @param {object} opts
   * @returns {boolean}
   */
  async syncModelsAndRefresh(configPath, { favorites, sharedModels, authJsonPath }) {
    const synced = syncFavoritesToModelsJson(configPath, {
      modelsJsonPath: this.modelsJsonPath,
      favorites,
      sharedModels,
      authJsonPath: authJsonPath || this.authJsonPath,
    });
    if (synced) {
      clearConfigCache();
      this._modelRegistry.refresh();
      // refresh() 内部调 resetOAuthProviders()，需要重新注册
      registerOAuthProvider(minimaxOAuthProvider);
      this._availableModels = await this._modelRegistry.getAvailable();
      this._injectOAuthCustomModels();
      this._mergeDefaultModels();
      this._enrichFromKnownModels();
      this._applyUserOverrides();
      this.authStore?.invalidate();
      this.authStore?.load();
    }
    return synced;
  }

  /**
   * 切换当前模型（只改状态，不推到 session）
   * @returns {object} 新模型对象
   */
  setModel(modelId) {
    const model = this._availableModels.find(m => m.id === modelId);
    if (!model) throw new Error(t("error.modelNotFound", { id: modelId }));
    this._sessionModel = model;
    return model;
  }

  /** auto -> medium，其余原样 */
  resolveThinkingLevel(level) {
    return level === "auto" ? "medium" : level;
  }

  /**
   * 将模型引用（id/name/object）解析成 SDK 可用的模型对象
   * 只查 _availableModels（唯一真理源）
   */
  resolveExecutionModel(modelRef) {
    if (!modelRef) return this.currentModel;
    if (typeof modelRef !== "string") return modelRef; // 对象直通（session-coordinator 路径）
    const ref = modelRef.trim();
    if (!ref) return this.currentModel;

    const model = this._resolveFromAvailable(ref);
    if (model) return model;

    throw new Error(t("error.modelNotFound", { id: ref }));
  }

  /** 根据模型 ID 推断其所属 provider */
  inferModelProvider(modelId) {
    if (!modelId) return null;
    const model = this._resolveFromAvailable(modelId);
    return model?.provider || null;
  }

  /**
   * 根据 provider 名称查找凭证
   * 委托 AuthStore，返回 snake_case 格式（兼容 callProviderText 消费方）
   * @param {string} provider
   * @param {object} [agentConfig]
   * @returns {{ api_key: string, base_url: string, api: string }}
   */
  resolveProviderCredentials(provider, agentConfig) {
    if (!provider) return { api_key: "", base_url: "", api: "" };
    if (this.authStore) {
      const cred = this.authStore.get(provider, agentConfig);
      if (cred) {
        return { api_key: cred.apiKey || "", base_url: cred.baseUrl || "", api: cred.api || "" };
      }
    }
    return { api_key: "", base_url: "", api: "" };
  }

  /**
   * 统一解析：模型引用 -> { model, provider, api, api_key, base_url }
   * 返回 snake_case 格式（兼容 callProviderText / diary-writer / compile 等消费方）
   * @param {string|object} modelRef
   * @param {object} [agentConfig]
   * @returns {{ model: string, provider: string, api: string, api_key: string, base_url: string }}
   */
  resolveModelWithCredentials(modelRef, agentConfig) {
    const entry = this.resolveExecutionModel(modelRef);
    const provider = entry?.provider;
    if (!provider) {
      throw new Error(t("error.modelNoProvider", { role: "resolve", model: String(modelRef) }));
    }
    const creds = this.resolveProviderCredentials(provider, agentConfig);
    if (!creds.api) {
      throw new Error(t("error.providerMissingApi", { provider }));
    }
    if (!creds.base_url || (!creds.api_key && !isLocalBaseUrl(creds.base_url))) {
      throw new Error(t("error.providerMissingCreds", { provider }));
    }
    return {
      model: entry.id,
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
}
