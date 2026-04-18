/**
 * ExecutionRouter -- per-agent 角色路由
 *
 * 职责：
 *   - 将 agent 的角色配置（chat/utility/embed 等）解析为执行所需的完整参数
 *   - 输入：role 名称 + agentConfig
 *   - 输出：{ modelId, providerId, api, apiKey, baseUrl }
 *   - 完全不参与模型注册逻辑（这是路由层，不是管理层）
 *
 * 角色路由配置存储格式（preferences.json / config.yaml）：
 *   models.chat           -> "provider/model" 或裸 modelId（向后兼容）
 *   models.utility        -> 同上
 *   models.utility_large  -> 同上
 *   models.embed          -> 同上
 *   models.summarizer     -> 同上
 *   models.compiler       -> 同上
 *
 * 设计来源：Hana 自己的三通道 API 概念（两个参考项目都没有）
 */

import { t } from "../server/i18n.js";
import { isLocalBaseUrl } from "../shared/net-utils.js";

// 角色名称 -> preferences 字段名（SHARED_MODEL_KEYS 兼容）
const ROLE_TO_PREF_KEY = {
  utility: "utility_model",
  utility_large: "utility_large_model",
  summarizer: "summarizer_model",
  compiler: "compiler_model",
};

export class ExecutionRouter {
  /**
   * @param {(ref: string) => object|null} resolveModel - 从 _availableModels 解析模型的函数
   * @param {import('./provider-registry.js').ProviderRegistry} providerRegistry
   */
  constructor(resolveModel, providerRegistry) {
    this._resolveModel = resolveModel;
    this._providerRegistry = providerRegistry;
  }

  /**
   * 解析角色 -> 完整执行参数
   *
   * @param {string} roleOrRef
   *   角色名（"chat"/"utility"/"utility_large"/"embed"/"summarizer"/"compiler"）
   *   或直接是模型引用（"provider/model" 或裸 modelId）
   * @param {object} agentConfig - agent config 对象（来自 config.yaml）
   * @param {object} [sharedModels] - 全局共享角色模型（来自 preferences）
   * @param {object} [utilApiOverride] - utility API 覆盖（来自 preferences）
   * @returns {{ modelId: string, providerId: string, api: string, apiKey: string, baseUrl: string }}
   * @throws 找不到模型或凭证时抛出
   */
  resolve(roleOrRef, agentConfig, sharedModels, utilApiOverride) {
    const modelRef = this._resolveRef(roleOrRef, agentConfig, sharedModels);
    if (!modelRef) {
      throw new Error(t("error.noUtilityModel") + ` (role: ${roleOrRef})`);
    }

    const model = this._resolveModel(modelRef);
    if (!model) {
      throw new Error(t("error.modelNotFound", { id: modelRef }));
    }

    // utility API 覆盖：只在 utility/utility_large 角色时生效
    const isUtilityRole = roleOrRef === "utility" || roleOrRef === "utility_large";
    if (isUtilityRole && utilApiOverride?.api_key) {
      // 校验 provider 一致性（与原 ModelManager.resolveUtilityConfig 行为一致）
      if (utilApiOverride.provider && utilApiOverride.provider !== model.provider) {
        throw new Error(t("error.utilityApiProviderMismatch", { model: modelRef }));
      }
      return {
        modelId: model.id,
        providerId: model.provider,
        api: model.api,
        apiKey: utilApiOverride.api_key,
        baseUrl: utilApiOverride.base_url || model.baseUrl,
      };
    }

    const cred = this._providerRegistry.getCredentials(model.provider);
    if (!cred) {
      throw new Error(t("error.providerMissingCreds", { provider: model.provider }));
    }
    if (!cred.api) {
      throw new Error(t("error.providerMissingApi", { provider: model.provider }));
    }
    if (!cred.baseUrl || (!cred.apiKey && !isLocalBaseUrl(cred.baseUrl))) {
      throw new Error(t("error.providerMissingCreds", { provider: model.provider }));
    }

    return {
      modelId: model.id,
      providerId: model.provider,
      api: cred.api,
      apiKey: cred.apiKey,
      baseUrl: cred.baseUrl,
    };
  }

  /**
   * 向后兼容的 resolveUtilityConfig 接口
   * 现有 6 处消费方（hub/channel-router, install-skill, llm-utils 等）都调这个
   * 返回结构与原 ModelManager.resolveUtilityConfig() 完全一致
   *
   * @param {object} agentConfig
   * @param {{ utility?: string, utility_large?: string, summarizer?: string, compiler?: string }} sharedModels
   * @param {{ provider?: string, api_key?: string, base_url?: string }} utilApiOverride
   */
  resolveUtilityConfig(agentConfig, sharedModels, utilApiOverride) {
    const cfg = agentConfig || {};
    const chatModelRef = cfg.models?.chat || null;

    // 用户明确配置的 utility 模型
    const userSetUtility = sharedModels?.utility || cfg.models?.utility || null;
    const userSetUtilityLarge = sharedModels?.utility_large || cfg.models?.utility_large || null;

    // 未配置时 fallback 到聊天模型
    const utilityModelRef = userSetUtility || chatModelRef;
    const largeModelRef = userSetUtilityLarge || chatModelRef;

    if (!utilityModelRef) throw new Error(t("error.noUtilityModel"));
    if (!largeModelRef) throw new Error(t("error.noUtilityLargeModel"));

    const utilModel = this._resolveModel(utilityModelRef);
    if (!utilModel) throw new Error(t("error.modelNotFound", { id: utilityModelRef }));

    const largeModel = this._resolveModel(largeModelRef);
    if (!largeModel) throw new Error(t("error.modelNotFound", { id: largeModelRef }));

    // utility 凭证
    let apiKey, baseUrl, api;
    if (utilApiOverride?.provider || utilApiOverride?.api_key || utilApiOverride?.base_url) {
      // 校验 provider 一致性（与原 ModelManager.resolveUtilityConfig 行为一致）
      if (utilApiOverride.provider && utilApiOverride.provider !== utilModel.provider) {
        throw new Error(t("error.utilityApiProviderMismatch", { model: utilityModelRef }));
      }
      // utility API 覆盖（用户指定了独立的 utility api endpoint）
      const provCred = this._providerRegistry.getCredentials(utilModel.provider);
      api = provCred?.api || utilModel.api;
      apiKey = utilApiOverride.api_key || "";
      baseUrl = utilApiOverride.base_url || "";
      if (!api) throw new Error(t("error.providerMissingApi", { provider: utilModel.provider }));
      if (!baseUrl || (!apiKey && !isLocalBaseUrl(baseUrl))) {
        throw new Error(t("error.utilityApiMissingCreds", { provider: utilModel.provider }));
      }
    } else {
      const cred = this._providerRegistry.getCredentials(utilModel.provider);
      if (!cred?.api) throw new Error(t("error.providerMissingApi", { provider: utilModel.provider }));
      if (!cred.baseUrl || (!cred.apiKey && !isLocalBaseUrl(cred.baseUrl))) {
        throw new Error(t("error.providerMissingCreds", { provider: utilModel.provider }));
      }
      apiKey = cred.apiKey;
      baseUrl = cred.baseUrl;
      api = cred.api;
    }

    // utility_large 凭证（provider 相同则复用）
    let large_api_key = apiKey, large_base_url = baseUrl, large_api = api;
    if (largeModel.provider !== utilModel.provider) {
      const largeCred = this._providerRegistry.getCredentials(largeModel.provider);
      if (!largeCred?.api) throw new Error(t("error.providerMissingApi", { provider: largeModel.provider }));
      if (!largeCred.baseUrl || (!largeCred.apiKey && !isLocalBaseUrl(largeCred.baseUrl))) {
        throw new Error(t("error.providerMissingCreds", { provider: largeModel.provider }));
      }
      large_api_key = largeCred.apiKey;
      large_base_url = largeCred.baseUrl;
      large_api = largeCred.api;
    }

    return {
      utility: utilModel.id,
      utility_large: largeModel.id,
      api_key: apiKey,
      base_url: baseUrl,
      api,
      large_api_key,
      large_base_url,
      large_api,
    };
  }

  /**
   * 将角色名或模型引用解析为实际模型 ref 字符串
   * @private
   */
  _resolveRef(roleOrRef, agentConfig, sharedModels) {
    const cfg = agentConfig || {};

    // 内置角色名的查找顺序：sharedModels -> agentConfig.models
    switch (roleOrRef) {
      case "chat":
        return cfg.models?.chat || null;
      case "utility":
        return sharedModels?.utility || cfg.models?.utility || null;
      case "utility_large":
        return sharedModels?.utility_large || cfg.models?.utility_large || null;
      case "summarizer":
        return sharedModels?.summarizer || cfg.models?.summarizer || null;
      case "compiler":
        return sharedModels?.compiler || cfg.models?.compiler || null;
      case "embed":
        return cfg.embedding_api?.model || null;
      default:
        // 不是内置角色名，当作模型引用直接用
        return roleOrRef;
    }
  }
}
