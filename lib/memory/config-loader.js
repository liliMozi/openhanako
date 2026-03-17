/**
 * config-loader.js — 统一配置加载
 *
 * API key 来源优先级（从高到低）：
 *   1. config.yaml 内联值（api.api_key）—— 迁移后为空
 *   2. 全局 providers.yaml（~/.hanako/providers.yaml）
 *   3. per-agent config.yaml providers 块（向后兼容）
 *
 * 支持三通道 API：
 *   api          → 主通道（chat / summarizer / compiler）
 *   embedding_api → Embedding 专用通道（可选）
 *   utility_api   → 工具模型通道（可选）
 *
 * 所有模块（embedding、summarizer、memory-search、web-search）都从这里读配置，
 * 不再各自实现读取逻辑。
 */

import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import dotenv from "dotenv";

function getHanakoHome() {
  return process.env.HANA_HOME
    ? path.resolve(process.env.HANA_HOME.replace(/^~/, os.homedir()))
    : path.join(os.homedir(), ".hanako");
}

// 动态加载 .env 文件（每次需要时重新加载）
function loadEnvFile() {
  const envPath = path.join(getHanakoHome(), ".env");
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

// 初始化时先加载一次
loadEnvFile();

// Provider 名称到环境变量名的映射
const PROVIDER_ENV_MAP = {
  "deepseek": "DEEPSEEK_API_KEY",
  "openai": "OPENAI_API_KEY",
  "anthropic": "ANTHROPIC_API_KEY",
  "anthropic-claude": "ANTHROPIC_API_KEY",
  "qwen": "QWEN_API_KEY",
  "aliyun": "DASHSCOPE_API_KEY",
  "dashscope": "DASHSCOPE_API_KEY",
  "azure": "AZURE_API_KEY",
  "gemini": "GEMINI_API_KEY",
  "google": "GEMINI_API_KEY",
  "ollama": "OLLAMA_API_KEY",
  "lmstudio": "LMSTUDIO_API_KEY",
  "local": "LOCAL_API_KEY",
  "minimax": "MINIMAX_API_KEY",
};

function getEnvApiKey(providerName) {
  const envVar = PROVIDER_ENV_MAP[providerName?.toLowerCase()];
  if (envVar && process.env[envVar]) {
    return process.env[envVar];
  }
  // 通用回退：{PROVIDER}_API_KEY
  const fallback = `${providerName?.toUpperCase()}_API_KEY`;
  return process.env[fallback] || "";
}

// 按路径缓存，防止跨 agent 污染
const _cache = new Map(); // configPath → { cached, cachedRaw }

// 全局 providers.yaml 缓存
const _PROVIDERS_CACHE_KEY = "__global_providers__";
const _MODELS_CACHE_KEY = "__models_registry__";
const _AUTH_CACHE_KEY = "__auth_registry__";

/** 全局 providers.yaml 路径 */
function getProvidersYamlPath() {
  return path.join(getHanakoHome(), "providers.yaml");
}

export function getModelsJsonPath() {
  return path.join(getHanakoHome(), "models.json");
}

function getAuthJsonPath() {
  return path.join(getHanakoHome(), "auth.json");
}

/**
 * 读取全局 providers.yaml（带缓存）
 * @returns {{ providers: object }}
 */
export function loadGlobalProviders() {
  const entry = _cache.get(_PROVIDERS_CACHE_KEY);
  if (entry) return entry.cached;

  const providersPath = getProvidersYamlPath();
  let raw = { providers: {} };
  try {
    raw = YAML.load(fs.readFileSync(providersPath, "utf-8")) || { providers: {} };
    if (!raw.providers) raw.providers = {};
  } catch {}

  _cache.set(_PROVIDERS_CACHE_KEY, { cached: raw });
  return raw;
}

export function loadModelsRegistry() {
  const entry = _cache.get(_MODELS_CACHE_KEY);
  if (entry) return entry.cached;

  let raw = { providers: {} };
  try {
    raw = JSON.parse(fs.readFileSync(getModelsJsonPath(), "utf-8")) || { providers: {} };
    if (!raw.providers) raw.providers = {};
  } catch {}

  _cache.set(_MODELS_CACHE_KEY, { cached: raw });
  return raw;
}

function loadAuthRegistry() {
  const entry = _cache.get(_AUTH_CACHE_KEY);
  if (entry) return entry.cached;

  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(getAuthJsonPath(), "utf-8")) || {};
  } catch {}

  _cache.set(_AUTH_CACHE_KEY, { cached: raw });
  return raw;
}

export function resolveApiKeyFromAuth(providerName) {
  // 每次调用时重新加载 .env 文件
  loadEnvFile();

  // 优先从环境变量读取
  const envKey = getEnvApiKey(providerName);
  if (envKey) return envKey;

  // 其次从 auth.json 读取
  const raw = loadAuthRegistry();
  const entry = raw?.[providerName];
  if (!entry) return "";
  if (typeof entry === "string") return entry;
  if (typeof entry?.apiKey === "string") return entry.apiKey;
  if (typeof entry?.access === "string") return entry.access;
  if (typeof entry?.token === "string") return entry.token;
  return "";
}

function extractModelId(modelEntry) {
  if (!modelEntry) return "";
  if (typeof modelEntry === "string") return modelEntry;
  return typeof modelEntry.id === "string" ? modelEntry.id : "";
}

export function findProviderForModel(modelName) {
  if (!modelName) return "";
  const registry = loadModelsRegistry();
  for (const [providerName, providerData] of Object.entries(registry.providers || {})) {
    const models = Array.isArray(providerData?.models) ? providerData.models : [];
    for (const modelEntry of models) {
      if (extractModelId(modelEntry) === modelName) return providerName;
    }
  }
  return "";
}

function getModelsForProvider(providerName) {
  const registry = loadModelsRegistry();
  const models = registry.providers?.[providerName]?.models;
  if (!Array.isArray(models)) return [];
  return models.map(extractModelId).filter(Boolean);
}

function isLocalBaseUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(String(url || ""));
}

/**
 * 保存全局 providers.yaml（deepMerge + atomic write + 清缓存）
 * 同时将 api_key 写入 .env 文件
 * @param {object} partial - { providers: { [name]: { api_key, base_url, models } | null } }
 */
export function saveGlobalProviders(partial) {
  const providersPath = getProvidersYamlPath();
  let current = { providers: {} };
  try {
    current = YAML.load(fs.readFileSync(providersPath, "utf-8")) || { providers: {} };
    if (!current.providers) current.providers = {};
  } catch {}

  // 读取现有的 .env 文件
  const envPath = path.join(getHanakoHome(), ".env");
  let envData = {};
  try {
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, "utf-8");
      envContent.split("\n").forEach(line => {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match) envData[match[1].trim()] = match[2].trim();
      });
    }
  } catch {}

  // 处理每个 provider：如果有 api_key，准备写入 .env
  const processedProviders = JSON.parse(JSON.stringify(partial.providers || {}));
  const apiKeysToMove = {}; // 保存需要移动到 .env 的 key

  for (const [provName, provConfig] of Object.entries(processedProviders)) {
    if (provConfig && provConfig.api_key) {
      const envVar = PROVIDER_ENV_MAP[provName?.toLowerCase()] || `${provName.toUpperCase()}_API_KEY`;
      apiKeysToMove[envVar] = provConfig.api_key;
    }
  }

  // 合并到现有的 envData
  envData = { ...envData, ...apiKeysToMove };

  // 保存 .env 文件
  const envLines = Object.entries(envData).map(([k, v]) => `${k}=${v}`).join("\n");
  fs.writeFileSync(envPath, envLines, "utf-8");

  // 验证 .env 写入成功（读取并比对）
  let envWriteSuccess = false;
  try {
    const verifyContent = fs.readFileSync(envPath, "utf-8");
    for (const [key, value] of Object.entries(apiKeysToMove)) {
      if (verifyContent.includes(`${key}=${value}`)) {
        envWriteSuccess = true;
      }
    }
  } catch {}

  // 只有 .env 写入成功才从 providers 中删除 api_key
  if (envWriteSuccess) {
    for (const [provName, provConfig] of Object.entries(processedProviders)) {
      if (provConfig && provConfig.api_key) {
        delete provConfig.api_key;
      }
    }
  } else {
    // .env 写入失败，保留 api_key 在 providers.yaml 中
    // 输出到 stderr 以便调试
    console.error("[config-loader] .env write failed, keeping api_key in providers.yaml");
  }

  // 确保 current.providers 存在
  if (!current.providers) current.providers = {};

  // 合并 providers
  for (const [provName, provConfig] of Object.entries(processedProviders)) {
    if (!current.providers[provName]) current.providers[provName] = {};
    current.providers[provName] = deepMerge(current.providers[provName], provConfig);
  }

  const header =
    "# Hanako 供应商配置（全局，跨 agent 共享）\n" +
    "# 由设置页面管理\n\n";
  const yamlStr = header + YAML.dump(current, {
    indent: 2,
    lineWidth: -1,
    sortKeys: false,
    quotingType: "\"",
    forceQuotes: false,
  });

  const tmpPath = providersPath + ".tmp";
  fs.writeFileSync(tmpPath, yamlStr, "utf-8");
  fs.renameSync(tmpPath, providersPath);

  // 清缓存：全局 providers + 所有 config 缓存（因为 resolveApi 结果可能变了）
  clearConfigCache();
}

/**
 * 从 providers 块查找指定 provider 的凭证
 */
function resolveFromProviders(providers, providerName) {
  const p = providers?.[providerName];
  return {
    apiKey: p?.api_key || "",
    baseUrl: p?.base_url || "",
    api: p?.api || "",
  };
}

/**
 * 解析一个 API 区块
 * 优先级：block 内联值 > 全局 providers.yaml > per-agent providers 块
 */
function resolveApi(block, rawConfig) {
  if (!block) return null;

  let apiKey = block?.api_key || "";
  let baseUrl = block?.base_url || "";
  let api = block?.api || "";
  const provider = typeof block?.provider === "string" ? block.provider.trim() : "";

  if (!provider) {
    return {
      provider: "",
      api_key: apiKey,
      base_url: baseUrl,
      api,
    };
  }

  // 第二优先级：全局 providers.yaml
  if (!apiKey || !baseUrl || !api) {
    const global = loadGlobalProviders();
    const fromGlobal = resolveFromProviders(global.providers, provider);
    if (!apiKey) apiKey = fromGlobal.apiKey;
    if (!baseUrl) baseUrl = fromGlobal.baseUrl;
    if (!api) api = fromGlobal.api;
  }

  // 第三优先级：per-agent providers 注册表（向后兼容）
  if (!apiKey || !baseUrl || !api) {
    const fromProviders = resolveFromProviders(rawConfig?.providers, provider);
    if (!apiKey) apiKey = fromProviders.apiKey;
    if (!baseUrl) baseUrl = fromProviders.baseUrl;
    if (!api) api = fromProviders.api;
  }

  if (!apiKey) {
    apiKey = resolveApiKeyFromAuth(provider);
  }

  return { provider, api_key: apiKey, base_url: baseUrl, api };
}

/**
 * 加载并返回完整配置
 * @param {string} configPath - config.yaml 的路径
 * @returns {object} 解析后的配置对象，包含 api 和 embedding_api
 */
export function loadConfig(configPath) {
  const entry = _cache.get(configPath);
  if (entry) return entry.cached;

  const raw = YAML.load(fs.readFileSync(configPath, "utf-8"));
  const cachedRaw = structuredClone(raw);  // 保存原始配置（resolve 前）

  // 主 API 通道
  const api = resolveApi(raw.api, raw) || { provider: "", api_key: "", base_url: "" };

  if (!api.provider) {
    console.warn("[config] ⚠ 主 API 未配置 provider。请在设置中显式选择供应商。");
  } else if (!api.base_url || !api.api || (!api.api_key && !isLocalBaseUrl(api.base_url))) {
    console.warn(
      `[config] ⚠ API 配置不完整。请在设置中显式配置 API 协议、API key 与 Base URL。` +
      `（provider: ${api.provider}）`
    );
  }

  // Embedding 专用通道（可选）
  const embeddingApi = resolveApi(raw.embedding_api, raw);

  // Utility 通道（工具模型，可选）
  const utilityApi = resolveApi(raw.utility_api, raw);

  const cached = {
    ...raw,
    api,
    embedding_api: embeddingApi,
    utility_api: utilityApi,
  };

  _cache.set(configPath, { cached, cachedRaw });
  return cached;
}

/**
 * 根据模型名查找对应 provider 的 API 凭证
 * 模型归属统一来自 models.json，凭证来自 providers.yaml / auth.json
 *
 * @param {string} modelName - 模型名称（如 "qwen3.5-397b-a17b"）
 * @param {string} configPath - config.yaml 路径
 * @returns {{ api_key: string, base_url: string, provider: string, api: string }}
 */
export function resolveModelApi(modelName, configPath) {
  if (!modelName) {
    throw new Error("模型名不能为空");
  }

  const cfg = loadConfig(configPath);
  const entry = _cache.get(configPath);
  const rawCfg = entry?.cachedRaw || cfg;
  const provider = findProviderForModel(modelName);
  if (!provider) throw new Error(`模型 "${modelName}" 未在 models.json 中注册 provider`);

  const resolved = resolveApi({ provider }, rawCfg);
  if (!resolved?.api) {
    throw new Error(`模型 "${modelName}" 所属 provider "${provider}" 缺少 API 协议配置`);
  }
  const needsApiKey = !isLocalBaseUrl(resolved?.base_url);
  if (!resolved?.base_url || (needsApiKey && !resolved?.api_key)) {
    throw new Error(`模型 "${modelName}" 所属 provider "${provider}" 配置不完整`);
  }
  return resolved;
}

/** 清除缓存（指定路径或全部，始终清全局 providers 缓存） */
export function clearConfigCache(configPath) {
  if (configPath) {
    _cache.delete(configPath);
  } else {
    _cache.clear();
  }
  // 全局 providers 缓存始终清除（凭证可能已变）
  _cache.delete(_PROVIDERS_CACHE_KEY);
  _cache.delete(_MODELS_CACHE_KEY);
  _cache.delete(_AUTH_CACHE_KEY);
}

/** 返回原始配置（未经 resolveApi 处理）。需要传 configPath 来定位缓存 */
export function getRawConfig(configPath) {
  if (configPath) {
    return _cache.get(configPath)?.cachedRaw ?? null;
  }
  // 兼容：不传参时返回最近一个有 cachedRaw 的 entry（跳过全局 providers 缓存）
  for (const entry of _cache.values()) {
    if (entry.cachedRaw) return entry.cachedRaw;
  }
  return null;
}

/**
 * 获取所有已注册的供应商（全局 providers.yaml + per-agent providers 块）
 * @param {string} configPath - config.yaml 路径（per-agent 向后兼容）
 * @returns {object} { providerName: { base_url, api_key, api, models } }
 */
export function getAllProviders(configPath) {
  // 优先：全局 providers.yaml
  const global = loadGlobalProviders();
  const providers = structuredClone(global.providers || {});

  // 向后兼容：merge per-agent config.yaml 的 providers 块（尚未迁移的 agent）
  try {
    const raw = YAML.load(fs.readFileSync(configPath, "utf-8")) || {};
    if (raw.providers) {
      for (const [name, p] of Object.entries(raw.providers)) {
        if (!providers[name]) {
          providers[name] = structuredClone(p);
        }
      }
    }
  } catch {}

  for (const [name, p] of Object.entries(providers)) {
    const modelsFromRegistry = getModelsForProvider(name);
    if (!p.base_url) p.base_url = "";
    if (!p.api_key) p.api_key = resolveApiKeyFromAuth(name);
    if (!p.api) p.api = "";
    if (!p.models) p.models = [];
    if (modelsFromRegistry.length) {
      const merged = new Set([...(p.models || []), ...modelsFromRegistry]);
      p.models = [...merged];
    }
  }

  return providers;
}

/**
 * 深度合并：把 source 的非 undefined 值递归写入 target
 * 只合并 plain object，数组和原始值直接覆盖
 * source[key] === null 时删除 target[key]（用于供应商删除等场景）
 */
function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    // null = 删除这个 key
    if (sv === null) {
      delete out[key];
      continue;
    }
    const tv = target[key];
    if (sv && typeof sv === "object" && !Array.isArray(sv)
        && tv && typeof tv === "object" && !Array.isArray(tv)) {
      out[key] = deepMerge(tv, sv);
    } else {
      out[key] = sv;
    }
  }
  return out;
}

/**
 * 保存配置：读取当前 raw → 合并 partial → 写回 YAML → 清缓存
 * 使用 atomic write（tmp + rename），防止写到一半崩溃损坏配置文件
 * @param {string} configPath - config.yaml 路径
 * @param {object} partial - 要更新的字段（深度合并）
 */
export function saveConfig(configPath, partial) {
  // 始终从磁盘重新读取，防止并发编辑丢失
  const current = YAML.load(fs.readFileSync(configPath, "utf-8")) || {};
  const merged = deepMerge(current, partial);

  const header =
    "# Hanako 系统配置\n" +
    "# 由设置页面管理，手动编辑也可以\n\n";
  const yamlStr = header + YAML.dump(merged, {
    indent: 2,
    lineWidth: -1,
    sortKeys: false,
    quotingType: "\"",
    forceQuotes: false,
  });

  // atomic write：先写临时文件再 rename，防止写到一半崩溃损坏配置
  const tmpPath = configPath + ".tmp";
  fs.writeFileSync(tmpPath, yamlStr, "utf-8");
  fs.renameSync(tmpPath, configPath);
  clearConfigCache();
}
