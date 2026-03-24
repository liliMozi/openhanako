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
import { t } from "../../server/i18n.js";

// 按路径缓存，防止跨 agent 污染
const _cache = new Map(); // configPath → { cached, cachedRaw }

// 全局 providers.yaml 缓存
const _PROVIDERS_CACHE_KEY = "__global_providers__";
const _MODELS_CACHE_KEY = "__models_registry__";
const _AUTH_CACHE_KEY = "__auth_registry__";

function getHanakoHome() {
  return process.env.HANA_HOME
    ? path.resolve(process.env.HANA_HOME.replace(/^~/, os.homedir()))
    : path.join(os.homedir(), ".hanako");
}

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

function getModelsForProvider(providerName) {
  const registry = loadModelsRegistry();
  const models = registry.providers?.[providerName]?.models;
  if (!Array.isArray(models)) return [];
  return models.map(extractModelId).filter(Boolean);
}

/**
 * 保存全局 providers.yaml（deepMerge + atomic write + 清缓存）
 * @param {object} partial - { providers: { [name]: { api_key, base_url, models } | null } }
 */
export function saveGlobalProviders(partial) {
  const providersPath = getProvidersYamlPath();
  let current = { providers: {} };
  try {
    current = YAML.load(fs.readFileSync(providersPath, "utf-8")) || { providers: {} };
    if (!current.providers) current.providers = {};
  } catch {}

  const merged = deepMerge(current, partial);

  const header =
    "# Hanako 供应商配置（全局，跨 agent 共享）\n" +
    "# 由设置页面管理\n\n";
  const yamlStr = header + YAML.dump(merged, {
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

  // 主 API 通道（仅用于 UI 展示，运行时凭证解析走 AuthStore）
  const api = resolveApi(raw.api, raw) || { provider: "", api_key: "", base_url: "" };

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
