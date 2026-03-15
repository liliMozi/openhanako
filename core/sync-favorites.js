/**
 * sync-favorites.js — 收藏模型同步到 Pi SDK
 *
 * 当用户在设置页收藏/取消收藏模型时，自动同步到 HANA_HOME/models.json（默认 ~/.hanako/models.json），
 * 让 Pi SDK 的 ModelRegistry 能发现这些模型。
 */

import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { loadGlobalProviders, resolveApiKeyFromAuth } from "../lib/memory/config-loader.js";

/** @deprecated 仅作为 fallback，调用方应通过 opts.modelsJsonPath 传入 */
function getDefaultModelsJsonPath() {
  const hanakoHome = process.env.HANA_HOME
    ? path.resolve(process.env.HANA_HOME.replace(/^~/, os.homedir()))
    : path.join(os.homedir(), ".hanako");
  return path.join(hanakoHome, "models.json");
}

/**
 * 把模型 ID 转成可读名称
 * "doubao-seed-2-0-pro-260215" → "Doubao Seed 2.0 Pro"
 * "qwen3.5-plus" → "Qwen3.5 Plus"
 */
function humanizeName(id) {
  let name = id.replace(/-(\d{6})$/, "");
  name = name
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
  name = name.replace(/(\d) (\d)/g, "$1.$2");
  return name;
}

function generateModelDefaults(modelId) {
  return {
    id: modelId,
    name: humanizeName(modelId),
  };
}

/**
 * 解析某个 provider 的凭证（baseUrl + apiKey + api）
 * 优先级：全局 providers.yaml → config.yaml providers 块 → API 通道 → auth.json
 */
function resolveProviderCredentials(providerName, rawConfig, opts = {}) {
  let baseUrl = "";
  let apiKey = "";
  let api = "";

  // 1. 全局 providers.yaml
  const global = loadGlobalProviders();
  const gp = global.providers?.[providerName];
  if (gp?.base_url) baseUrl = gp.base_url;
  if (gp?.api_key) apiKey = gp.api_key;
  if (gp?.api) api = gp.api;

  // 2. config.yaml providers 块（向后兼容）
  if (!baseUrl || !apiKey || !api) {
    const provBlock = rawConfig.providers?.[providerName];
    if (!baseUrl && provBlock?.base_url) baseUrl = provBlock.base_url;
    if (!apiKey && provBlock?.api_key) apiKey = provBlock.api_key;
    if (!api && provBlock?.api) api = provBlock.api;
  }

  // 3. config.yaml 中指向该 provider 的 API 通道
  if (!baseUrl || !apiKey) {
    for (const channel of [rawConfig.api, rawConfig.embedding_api, rawConfig.utility_api]) {
      if (channel?.provider === providerName) {
        if (!baseUrl && channel.base_url) baseUrl = channel.base_url;
        if (!apiKey && channel.api_key) apiKey = channel.api_key;
      }
    }
  }

  // 4. auth.json OAuth token（用于 Anthropic 等 OAuth 认证的 provider）
  if (!apiKey && opts.authJsonPath) {
    apiKey = resolveApiKeyFromAuth(providerName);
  }

  return { baseUrl, apiKey, api };
}

/**
 * 同步 favorites + 角色模型到 HANA_HOME/models.json（默认 ~/.hanako/models.json）
 *
 * @param {string} configPath - config.yaml 路径（读 providers 凭证 + chat 模型）
 * @param {object} [opts]
 * @param {string} [opts.modelsJsonPath] - models.json 路径（不传则 fallback HANA_HOME/models.json）
 * @param {string[]} [opts.favorites] - 全局 favorites（不传则从 config.yaml 读）
 * @param {Record<string, string>} [opts.sharedModels] - 全局角色模型（utility, summarizer, compiler 等）
 * @returns {boolean} 是否有变化（调用方据此决定是否 refresh ModelRegistry）
 */
export function syncFavoritesToModelsJson(configPath, opts = {}) {
  const MODELS_JSON_PATH = opts.modelsJsonPath || getDefaultModelsJsonPath();
  // ── 1. 读取 config.yaml ──
  const rawConfig = YAML.load(fs.readFileSync(configPath, "utf-8")) || {};
  const favorites = opts.favorites ?? rawConfig.models?.favorites ?? [];
  const models = rawConfig.models || {};

  // 「必须保留」的模型集合 = favorites ∪ 角色模型（不含 embedding）
  const mustKeep = new Set(favorites);
  // per-agent: chat
  if (models.chat) mustKeep.add(models.chat);
  // 全局共享角色模型
  const shared = opts.sharedModels ?? {};
  for (const role of ["utility", "utility_large", "summarizer", "compiler"]) {
    if (shared[role]) mustKeep.add(shared[role]);
  }

  // ── 2. 读取 models.json ──
  let modelsJson;
  try {
    modelsJson = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, "utf-8"));
  } catch {
    modelsJson = { providers: {} };
  }

  if (mustKeep.size === 0) {
    const newJson = { providers: {} };
    const oldStr = JSON.stringify(modelsJson, null, 4);
    const newStr = JSON.stringify(newJson, null, 4);
    if (oldStr === newStr) return false;
    fs.writeFileSync(MODELS_JSON_PATH, newStr + "\n", "utf-8");
    console.log(`\x1b[90m  [sync] models.json 已清空\x1b[0m`);
    return true;
  }

  // ── 3. 建立 modelId → providerName 反查表 ──
  const modelToProvider = new Map();
  // 现有 models.json 作为当前运行时模型视图
  for (const [provName, provData] of Object.entries(modelsJson.providers || {})) {
    for (const m of (provData.models || [])) {
      const id = typeof m === "string" ? m : m?.id;
      if (id) modelToProvider.set(id, provName);
    }
  }
  // 全局 providers.yaml 作为声明源补充
  const globalProviders = loadGlobalProviders().providers || {};
  for (const [provName, provData] of Object.entries(globalProviders)) {
    for (const mid of (provData.models || [])) {
      if (!modelToProvider.has(mid)) modelToProvider.set(mid, provName);
    }
  }
  // per-agent providers（向后兼容）
  const configProviders = rawConfig.providers || {};
  for (const [provName, provData] of Object.entries(configProviders)) {
    for (const mid of (provData.models || [])) {
      if (!modelToProvider.has(mid)) modelToProvider.set(mid, provName);
    }
  }
  // ── 4. 按 provider 分组必须保留的模型 ──
  const providerModels = new Map(); // providerName → Set<modelId>
  for (const mid of mustKeep) {
    const prov = modelToProvider.get(mid);
    if (!prov) {
      throw new Error(`模型 "${mid}" 未绑定任何 provider，请先在供应商设置中显式关联`);
    }
    if (!providerModels.has(prov)) providerModels.set(prov, new Set());
    providerModels.get(prov).add(mid);
  }

  // ── 5. 构建新的 models.json ──
  const newProviders = {};
  for (const [provName, targetModelIds] of providerModels) {
    const { baseUrl, apiKey, api } = resolveProviderCredentials(provName, rawConfig, opts);

    if (!baseUrl) {
      throw new Error(`provider "${provName}" 缺少 Base URL`);
    }
    if (!api) {
      throw new Error(`provider "${provName}" 缺少 API 协议配置`);
    }

    // 本地服务（localhost）不需要 apiKey，给个占位符让 Pi SDK 通过 hasAuth
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(baseUrl);
    if (!apiKey && !isLocal) {
      throw new Error(`provider "${provName}" 缺少 API Key`);
    }
    const effectiveApiKey = apiKey || "local";

    // 已有的模型 metadata（按 id 索引）
    const existingModels = new Map();
    for (const m of (modelsJson.providers?.[provName]?.models || [])) {
      existingModels.set(m.id, m);
    }

    // 组装模型列表
    const modelList = [];
    for (const mid of targetModelIds) {
      if (existingModels.has(mid)) {
        const existing = { ...existingModels.get(mid) };
        // name 保留用户编辑过的值，只在缺失时用 humanizeName 兜底
        if (!existing.name) existing.name = humanizeName(mid);
        modelList.push(existing);
      } else {
        modelList.push(generateModelDefaults(mid)); // 生成默认值
      }
    }

    newProviders[provName] = {
      baseUrl,
      api,
      apiKey: effectiveApiKey,
      models: modelList,
    };
  }

  // ── 6. 比较是否有变化 ──
  const newJson = { providers: newProviders };
  const oldStr = JSON.stringify(modelsJson, null, 4);
  const newStr = JSON.stringify(newJson, null, 4);

  if (oldStr === newStr) return false;

  // ── 7. 写入 ──
  fs.writeFileSync(MODELS_JSON_PATH, newStr + "\n", "utf-8");
  console.log(`\x1b[90m  [sync] models.json 已更新\x1b[0m`);
  return true;
}
