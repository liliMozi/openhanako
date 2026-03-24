/**
 * ProviderRegistry — 声明式 provider 插件注册表
 *
 * 职责：
 *   - 管理所有已知 provider 的静态声明（能力、协议、认证类型）
 *   - 将插件声明与 providers.yaml 用户配置合并为 ProviderEntry
 *   - 不管凭证（凭证由 AuthStore 负责）
 *   - 不管模型列表（模型列表由 ModelManager._availableModels 负责）
 *
 * 设计来源：OpenClaw 的插件注册表模式
 */

import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { safeReadYAMLSync } from "../shared/safe-fs.js";
import { fromRoot } from "../shared/hana-root.js";

const _defaultModels = JSON.parse(
  fs.readFileSync(fromRoot("lib", "default-models.json"), "utf-8"),
);

// ── 内置插件 ────────────────────────────────────────────────────────────────

import { dashscopePlugin } from "../lib/providers/dashscope.js";
import { openaiPlugin } from "../lib/providers/openai.js";
import { anthropicPlugin } from "../lib/providers/anthropic.js";
import { deepseekPlugin } from "../lib/providers/deepseek.js";
import { geminiPlugin } from "../lib/providers/gemini.js";
import { openrouterPlugin } from "../lib/providers/openrouter.js";
import { ollamaPlugin } from "../lib/providers/ollama.js";
import { minimaxPlugin } from "../lib/providers/minimax.js";
import { minimaxOAuthPlugin } from "../lib/providers/minimax-oauth.js";
import { openaiCodexOAuthPlugin } from "../lib/providers/openai-codex-oauth.js";
// 中国
import { siliconflowPlugin } from "../lib/providers/siliconflow.js";
import { zhipuPlugin } from "../lib/providers/zhipu.js";
import { moonshotPlugin } from "../lib/providers/moonshot.js";
import { baichuanPlugin } from "../lib/providers/baichuan.js";
import { stepfunPlugin } from "../lib/providers/stepfun.js";
import { volcenginePlugin } from "../lib/providers/volcengine.js";
import { hunyuanPlugin } from "../lib/providers/hunyuan.js";
import { baiduCloudPlugin } from "../lib/providers/baidu-cloud.js";
import { modelscopePlugin } from "../lib/providers/modelscope.js";
import { infiniPlugin } from "../lib/providers/infini.js";
import { mimoPlugin } from "../lib/providers/mimo.js";
// 国际
import { groqPlugin } from "../lib/providers/groq.js";
import { togetherPlugin } from "../lib/providers/together.js";
import { fireworksPlugin } from "../lib/providers/fireworks.js";
import { mistralPlugin } from "../lib/providers/mistral.js";
import { perplexityPlugin } from "../lib/providers/perplexity.js";
import { xaiPlugin } from "../lib/providers/xai.js";
// Coding Plan
import { dashscopeCodingPlugin } from "../lib/providers/dashscope-coding.js";
import { kimiCodingPlugin } from "../lib/providers/kimi-coding.js";
import { volcegineCodingPlugin } from "../lib/providers/volcengine-coding.js";

const BUILTIN_PLUGINS = [
  dashscopePlugin,
  openaiPlugin,
  anthropicPlugin,
  deepseekPlugin,
  geminiPlugin,
  openrouterPlugin,
  ollamaPlugin,
  minimaxPlugin,
  minimaxOAuthPlugin,
  openaiCodexOAuthPlugin,
  // 中国
  siliconflowPlugin,
  zhipuPlugin,
  moonshotPlugin,
  baichuanPlugin,
  stepfunPlugin,
  volcenginePlugin,
  hunyuanPlugin,
  baiduCloudPlugin,
  modelscopePlugin,
  infiniPlugin,
  mimoPlugin,
  // 国际
  groqPlugin,
  togetherPlugin,
  fireworksPlugin,
  mistralPlugin,
  perplexityPlugin,
  xaiPlugin,
  // Coding Plan
  dashscopeCodingPlugin,
  kimiCodingPlugin,
  volcegineCodingPlugin,
];

// ── Types (JSDoc) ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} ProviderPlugin
 * @property {string} id
 * @property {string} displayName
 * @property {"api-key"|"oauth"|"none"} authType
 * @property {string} defaultBaseUrl
 * @property {string} defaultApi
 * @property {{ vision: boolean, functionCall: boolean, streaming: boolean, reasoning: boolean, quirks?: string[] }} capabilities
 * @property {string} [authJsonKey] - OAuth provider 在 auth.json 中的 key（不同于 id 时）
 */

/**
 * @typedef {object} ProviderEntry
 * @property {string} id
 * @property {string} displayName
 * @property {"api-key"|"oauth"|"none"} authType
 * @property {string} baseUrl        - 生效的 base URL（用户覆盖 > 插件默认）
 * @property {string} api            - 生效的 API 协议
 * @property {{ vision: boolean, functionCall: boolean, streaming: boolean, reasoning: boolean, quirks?: string[] }} capabilities
 * @property {string} [authJsonKey]
 * @property {boolean} isBuiltin     - 是否为内置插件
 */

// ── ProviderRegistry ─────────────────────────────────────────────────────────

export class ProviderRegistry {
  /**
   * @param {string} hanakoHome - 用户数据根目录（如 ~/.hanako-dev）
   */
  constructor(hanakoHome) {
    this._hanakoHome = hanakoHome;
    /** @type {Map<string, ProviderPlugin>} id → plugin */
    this._plugins = new Map();
    /** @type {Map<string, ProviderEntry>} id → entry（合并后） */
    this._entries = new Map();

    // 注册内置插件
    for (const plugin of BUILTIN_PLUGINS) {
      this._plugins.set(plugin.id, plugin);
    }
  }

  /**
   * 注册 provider 插件
   * 同一 id 注册两次会覆盖（方便测试/扩展）
   * @param {ProviderPlugin} plugin
   */
  register(plugin) {
    if (!plugin?.id) throw new Error("ProviderPlugin must have an id");
    this._plugins.set(plugin.id, plugin);
    // 让 reload() 在下次调用时重新合并
    this._entries.delete(plugin.id);
  }

  /** 从 _hanakoHome 直接读 providers.yaml（不走全局 config-loader） */
  _loadProvidersYaml() {
    const ymlPath = path.join(this._hanakoHome, "providers.yaml");
    const raw = safeReadYAMLSync(ymlPath, {}, YAML) || {};
    return raw.providers || {};
  }

  /** 将 providers 对象写入 _hanakoHome/providers.yaml */
  _saveProvidersYaml(providers) {
    const ymlPath = path.join(this._hanakoHome, "providers.yaml");
    const header =
      "# Hanako 供应商配置（全局，跨 agent 共享）\n" +
      "# 由设置页面管理\n\n";
    const yamlStr = header + YAML.dump({ providers }, {
      indent: 2,
      lineWidth: -1,
      sortKeys: false,
      quotingType: "\"",
      forceQuotes: false,
    });
    const tmpPath = ymlPath + ".tmp";
    fs.writeFileSync(tmpPath, yamlStr, "utf-8");
    fs.renameSync(tmpPath, ymlPath);
  }

  /**
   * 从 providers.yaml 加载用户配置，与所有插件声明合并
   * 每次 providers.yaml 变更后调用
   */
  reload() {
    this._entries.clear();
    const userConfig = this._loadProvidersYaml();

    // 1. 先处理所有已注册插件（内置 + 外部注册的）
    for (const [id, plugin] of this._plugins) {
      const uc = userConfig[id] || {};
      this._entries.set(id, this._merge(plugin, uc, true));
    }

    // 2. 处理 providers.yaml 中有但没有对应插件的条目（用户自定义 provider）
    for (const [id, uc] of Object.entries(userConfig)) {
      if (this._entries.has(id)) continue;
      // 没有插件声明，从配置推断
      const syntheticPlugin = {
        id,
        displayName: uc.display_name || id,
        authType: uc.auth_type || "api-key",
        defaultBaseUrl: uc.base_url || "",
        defaultApi: uc.api || "openai-completions",
        capabilities: {
          vision: uc.capabilities?.vision ?? true,
          functionCall: uc.capabilities?.function_call ?? true,
          streaming: true,
          reasoning: false,
          quirks: [],
        },
      };
      this._entries.set(id, this._merge(syntheticPlugin, uc, false));
    }
  }

  /**
   * 合并插件声明和用户配置
   * @private
   */
  _merge(plugin, userConfig, isBuiltin) {
    return {
      id: plugin.id,
      displayName: userConfig.display_name || plugin.displayName,
      authType: userConfig.auth_type || plugin.authType,
      baseUrl: userConfig.base_url || plugin.defaultBaseUrl,
      api: userConfig.api || plugin.defaultApi,
      capabilities: plugin.capabilities || {
        vision: false,
        functionCall: false,
        streaming: true,
        reasoning: false,
        quirks: [],
      },
      authJsonKey: plugin.authJsonKey || plugin.id,
      isBuiltin,
    };
  }

  /**
   * 获取所有 provider entry（已合并）
   * @returns {Map<string, ProviderEntry>}
   */
  getAll() {
    if (this._entries.size === 0) this.reload();
    return this._entries;
  }

  /**
   * 获取单个 provider entry
   * @param {string} providerId
   * @returns {ProviderEntry|null}
   */
  get(providerId) {
    if (this._entries.size === 0) this.reload();
    const direct = this._entries.get(providerId);
    if (direct) return direct;
    // 反向查找：providerId 可能是某个 OAuth provider 的 authJsonKey
    // 如 "openai-codex" → "openai-codex-oauth"
    for (const entry of this._entries.values()) {
      if (entry.authJsonKey === providerId && entry.id !== providerId) return entry;
    }
    return null;
  }

  /**
   * 批量获取 provider entry
   * @param {string[]} providerIds
   * @returns {Map<string, ProviderEntry>}
   */
  getBatch(providerIds) {
    const result = new Map();
    for (const id of providerIds) {
      const entry = this.get(id);
      if (entry) result.set(id, entry);
    }
    return result;
  }

  /**
   * 列出所有 authType 为 "oauth" 的 provider id
   * @returns {string[]}
   */
  getOAuthProviderIds() {
    const all = this.getAll();
    return [...all.values()]
      .filter(e => e.authType === "oauth")
      .map(e => e.id);
  }

  /**
   * 获取 OAuth provider 在 auth.json 中的实际 key
   * （部分 provider 的 authJsonKey 与 id 不同，如 minimax-oauth → minimax）
   * @param {string} providerId
   * @returns {string}
   */
  getAuthJsonKey(providerId) {
    return this.get(providerId)?.authJsonKey || providerId;
  }

  /**
   * 获取某 provider 的默认模型列表（来自 lib/default-models.json）
   * @param {string} providerId
   * @returns {string[]}
   */
  getDefaultModels(providerId) {
    return _defaultModels[providerId] || [];
  }

  /**
   * 更新 provider 的用户配置（写 providers.yaml）
   * 只更新非凭证字段（base_url / api / display_name / auth_type）
   * @param {string} providerId
   * @param {{ base_url?: string, api?: string, display_name?: string, auth_type?: string }} overrides
   */
  setUserConfig(providerId, overrides) {
    const userConfig = this._loadProvidersYaml();
    userConfig[providerId] = { ...(userConfig[providerId] || {}), ...overrides };
    this._saveProvidersYaml(userConfig);
    // 更新内存中的 entry
    this._entries.delete(providerId);
    if (this._plugins.has(providerId)) {
      const plugin = this._plugins.get(providerId);
      this._entries.set(providerId, this._merge(plugin, userConfig[providerId], true));
    } else {
      this.reload(); // 自定义 provider 走完整 reload
    }
  }

  /**
   * 删除一个 provider（仅从 providers.yaml，内置插件的插件声明保留）
   * @param {string} providerId
   */
  remove(providerId) {
    const userConfig = this._loadProvidersYaml();
    if (!Object.prototype.hasOwnProperty.call(userConfig, providerId)) return;
    delete userConfig[providerId];
    this._saveProvidersYaml(userConfig);
    this._entries.delete(providerId);
    // 如果有内置插件声明，以默认值重建 entry
    if (this._plugins.has(providerId)) {
      const plugin = this._plugins.get(providerId);
      this._entries.set(providerId, this._merge(plugin, {}, true));
    }
  }

  /**
   * 检查某个 id 是否是已知的 OAuth provider
   * @param {string} providerId
   */
  isOAuth(providerId) {
    return this.get(providerId)?.authType === "oauth";
  }
}
