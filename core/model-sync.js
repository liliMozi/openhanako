/**
 * model-sync.js — added-models.yaml → models.json 单向投影
 *
 * 系统中唯一写 models.json 的地方。从 providers 配置（snake_case）
 * 投影为 Pi SDK 格式（camelCase），附加 known-models.json 元数据。
 */

import fs from "fs";
import { getPiModel } from "../lib/pi-sdk/index.js";
import { lookupKnown } from "../shared/known-models.js";
import { normalizeVisionCapabilities, withThinkingFormatCompat } from "../shared/model-capabilities.js";
import { providerCredentialAllowsMissingApiKey } from "../shared/provider-auth.js";
import { validateProviderModels } from "../shared/provider-model-validation.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const PI_BUILTIN_PROVIDER_REUSE = new Set(["kimi-coding"]);

/**
 * 模型 ID → 人类可读名
 * "doubao-seed-2-0-pro-260215" → "Doubao Seed 2.0 Pro"
 */
function humanizeName(id) {
  let name = id.replace(/-(\d{6})$/, "");
  name = name.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  name = name.replace(/(\d) (\d)/g, "$1.$2");
  return name;
}

/** 从 auth.json entry 提取 API key（兼容多种格式） */
function extractApiKey(entry) {
  if (!entry) return "";
  if (typeof entry === "string") return entry;
  if (typeof entry?.apiKey === "string") return entry.apiKey;
  if (typeof entry?.access === "string") return entry.access;
  if (typeof entry?.token === "string") return entry.token;
  return "";
}

function getModelId(modelEntry) {
  return typeof modelEntry === "object" && modelEntry !== null ? modelEntry.id : modelEntry;
}

function getPiBuiltinModel(provider, modelId) {
  if (!PI_BUILTIN_PROVIDER_REUSE.has(provider) || !modelId) return null;
  try {
    return getPiModel(provider, modelId) || null;
  } catch {
    return null;
  }
}

function shouldReusePiBuiltinModel(provider, modelId, api) {
  return api === "anthropic-messages" && !!getPiBuiltinModel(provider, modelId);
}

function hasImageCapabilityHint(...values) {
  const haystack = values
    .filter(value => typeof value === "string" && value.trim())
    .join(" ")
    .toLowerCase();
  if (!haystack) return false;

  return [
    /(?:^|[\s._-])(vision|vl|omni|multimodal|multi-modal|image|img)(?:$|[\s._-])/,
    /(?:^|[\s._-])[a-z0-9]+v(?:$|[\s._-])/,
    /(?:^|[\s._-])glm[\s._-]?\d+v(?:$|[\s._-])/,
  ].some(pattern => pattern.test(haystack));
}

function buildModelOverride(modelEntry) {
  if (typeof modelEntry !== "object" || modelEntry === null) return null;

  const override = {};
  if (modelEntry.name !== undefined) override.name = modelEntry.name;
  if (modelEntry.context !== undefined) override.contextWindow = modelEntry.context;
  if (modelEntry.contextWindow !== undefined) override.contextWindow = modelEntry.contextWindow;
  if (modelEntry.maxOutput !== undefined) override.maxTokens = modelEntry.maxOutput;
  if (modelEntry.maxTokens !== undefined) override.maxTokens = modelEntry.maxTokens;
  const image = modelEntry.image ?? modelEntry.vision;
  if (image !== undefined) override.input = image ? ["text", "image"] : ["text"];
  if (modelEntry.reasoning !== undefined) override.reasoning = modelEntry.reasoning;

  return Object.keys(override).length > 0 ? override : null;
}

/**
 * 构建单个模型的 Pi SDK 格式条目
 * @param {string|{id:string, name?:string, context?:number, maxOutput?:number}} modelEntry
 * @param {string} provider - provider 名称（查词典用）
 */
function buildModelEntry(modelEntry, provider, baseUrl = "", api = "openai-completions") {
  const isObj = typeof modelEntry === "object" && modelEntry !== null;
  const id = getModelId(modelEntry);
  const known = lookupKnown(provider, id);
  const piBuiltin = getPiBuiltinModel(provider, id);

  // image modality 能力：用户设置 > known-models 词典 > 默认 false
  // 兼容读：migration #7 之前的旧数据用 vision 字段；两个版本后移除 vision fallback
  const userImage = isObj ? (modelEntry.image ?? modelEntry.vision) : undefined;
  const knownImage = known?.image ?? known?.vision;
  const inferredImage = hasImageCapabilityHint(id, isObj ? modelEntry.name : null);
  const image = userImage !== undefined ? userImage : (knownImage === true || (knownImage !== false && inferredImage));
  const entry = {
    id,
    name: (isObj && modelEntry.name) || known?.name || humanizeName(id),
    input: image ? ["text", "image"] : ["text"],
    contextWindow: (isObj && modelEntry.context) || known?.context || DEFAULT_CONTEXT_WINDOW,
    reasoning: (isObj && modelEntry.reasoning !== undefined) ? modelEntry.reasoning : (known?.reasoning === true),
  };

  const maxOutput = (isObj && modelEntry.maxOutput) || known?.maxOutput;
  if (maxOutput) entry.maxTokens = maxOutput;

  if (known?.quirks?.length) entry.quirks = known.quirks;
  if (piBuiltin?.headers) entry.headers = { ...piBuiltin.headers };

  const rawVisionCapabilities = isObj && modelEntry.visionCapabilities !== undefined
    ? modelEntry.visionCapabilities
    : known?.visionCapabilities;
  const visionCapabilities = image ? normalizeVisionCapabilities(rawVisionCapabilities) : null;
  if (visionCapabilities) entry.visionCapabilities = visionCapabilities;

  // Pi SDK compat 覆盖：
  // 1. 非 OpenAI provider 不发 developer role（dashscope 等不支持）— 与 reasoning 无关
  // 2. thinkingFormat 由 shared/model-capabilities.js 统一派生，避免请求层按 provider 猜
  // 3. Gemini OpenAI 兼容层（/v1beta/openai）严格校验，不识别 store 字段会 400
  if (provider !== "openai") {
    const compat = { supportsDeveloperRole: false };
    if (provider === "gemini" || baseUrl.includes("generativelanguage.googleapis.com")) {
      compat.supportsStore = false;
    }
    entry.compat = compat;
  }

  return withThinkingFormatCompat(entry, { provider, api });
}

function filterChatModelEntries(provider, models) {
  return models.filter(m => {
    const isObj = typeof m === "object" && m !== null;
    const id = getModelId(m);
    const known = lookupKnown(provider, id);
    const type = (isObj && m.type) || known?.type || "chat";
    return type === "chat";
  });
}

/**
 * 单向投影：providers 配置 → models.json（Pi SDK 格式）
 *
 * @param {Record<string, object>} providers - added-models.yaml 中的 providers 块（snake_case）
 * @param {object} [opts]
 * @param {string} opts.modelsJsonPath - models.json 输出路径
 * @param {string} [opts.authJsonPath] - auth.json 路径（OAuth 凭证查找用）
 * @param {Record<string, string>} [opts.oauthKeyMap] - providerId → auth.json key 映射
 * @returns {boolean} 内容是否有变化
 */
export function syncModels(providers, opts = {}) {
  const modelsJsonPath = opts.modelsJsonPath;
  const authJsonPath = opts.authJsonPath;
  const oauthKeyMap = opts.oauthKeyMap || {};

  // 懒加载 auth.json（只在需要时读一次）
  let _authJson;
  function getAuthJson() {
    if (_authJson !== undefined) return _authJson;
    if (!authJsonPath) { _authJson = {}; return _authJson; }
    try {
      _authJson = JSON.parse(fs.readFileSync(authJsonPath, "utf-8")) || {};
    } catch {
      _authJson = {};
    }
    return _authJson;
  }

  // 构建新的 providers 块
  const newProviders = {};

  for (const [name, p] of Object.entries(providers || {})) {
    if (!p.base_url) continue;
    if (!p.models || p.models.length === 0) continue;
    validateProviderModels(name, p.models, { baseUrl: p.base_url });

    let apiKey = p.api_key || "";

    // 无 api_key 时尝试 OAuth 查找
    if (!apiKey) {
      const authKey = oauthKeyMap[name] || name;
      apiKey = extractApiKey(getAuthJson()[authKey]);
    }

    // 无凭证时只允许 provider 契约声明无需 key，或旧本地 loopback 配置。
    if (!apiKey && !providerCredentialAllowsMissingApiKey({
      authType: p.auth_type,
      baseUrl: p.base_url,
    })) continue;

    const effectiveApiKey = apiKey || "local";
    const effectiveApi = p.api || "openai-completions";
    const chatModels = filterChatModelEntries(name, p.models);
    const customModels = [];
    const modelOverrides = {};

    for (const modelEntry of chatModels) {
      const id = getModelId(modelEntry);
      if (shouldReusePiBuiltinModel(name, id, effectiveApi)) {
        const override = buildModelOverride(modelEntry);
        if (override) modelOverrides[id] = override;
        continue;
      }
      customModels.push(buildModelEntry(modelEntry, name, p.base_url, effectiveApi));
    }

    const providerConfig = {
      baseUrl: p.base_url,
      api: effectiveApi,
      apiKey: effectiveApiKey,
    };
    if (customModels.length > 0) providerConfig.models = customModels;
    if (Object.keys(modelOverrides).length > 0) providerConfig.modelOverrides = modelOverrides;

    newProviders[name] = providerConfig;
  }

  const newJson = { providers: newProviders };
  const newStr = JSON.stringify(newJson, null, 4) + "\n";

  // 比较是否有变化
  let oldStr = "";
  try {
    oldStr = fs.readFileSync(modelsJsonPath, "utf-8");
  } catch {
    // 文件不存在，视为有变化
  }
  if (oldStr === newStr) return false;

  // 原子写入：先写 tmp 文件，再 rename
  const tmpPath = modelsJsonPath + ".tmp";
  fs.writeFileSync(tmpPath, newStr, "utf-8");
  fs.renameSync(tmpPath, modelsJsonPath);

  return true;
}
