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
import { t } from "../server/i18n.js";
import { safeReadYAMLSync } from "../shared/safe-fs.js";

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

import { fromRoot } from "../shared/hana-root.js";

const _knownModels = JSON.parse(fs.readFileSync(fromRoot("lib", "known-models.json"), "utf-8"));
const _defaultModels = JSON.parse(fs.readFileSync(fromRoot("lib", "default-models.json"), "utf-8"));

const DEFAULT_CONTEXT_WINDOW = 128_000;

function generateModelDefaults(modelId) {
  const known = _knownModels[modelId];
  const entry = {
    id: modelId,
    name: known?.name || humanizeName(modelId),
    input: ["text", "image"],
    contextWindow: known?.context || DEFAULT_CONTEXT_WINDOW,
  };
  if (known?.maxOutput) entry.maxTokens = known.maxOutput;
  return entry;
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
  const rawConfig = safeReadYAMLSync(configPath, {}, YAML) || {};
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
  // Layer 4: default-models.json（集中声明，作为新安装和未配置 provider 的兜底）
  for (const [provName, modelIds] of Object.entries(_defaultModels)) {
    if (provName.startsWith("_")) continue; // 跳过 _comment 等元数据 key
    for (const mid of modelIds) {
      if (!modelToProvider.has(mid)) modelToProvider.set(mid, provName);
    }
  }
  // ── 4. 按 provider 分组必须保留的模型 ──
  // 支持 "provider/model" 命名空间格式：显式指定 provider 时直接使用，
  // 裸 model ID 走反查表。避免带命名空间的配置被跳过或绑到错误 provider。
  const providerModels = new Map(); // providerName → Set<modelId>
  for (const mid of mustKeep) {
    let prov, modelId;
    if (mid.includes("/")) {
      const slashIdx = mid.indexOf("/");
      const maybeProv = mid.slice(0, slashIdx);
      const maybeModel = mid.slice(slashIdx + 1);
      // 检查前缀是否是已知 provider（避免误拆 OpenRouter 风格 ID 如 "anthropic/claude-opus-4-6"）
      if (modelToProvider.has(maybeModel) || globalProviders[maybeProv] || _defaultModels[maybeProv]) {
        prov = maybeProv;
        modelId = maybeModel;
      }
    }
    if (!prov) {
      // 裸 ID 走反查表
      prov = modelToProvider.get(mid);
      modelId = mid;
    }
    if (!prov) {
      console.warn(`\x1b[33m  [sync] 模型 "${mid}" 未绑定 provider，跳过\x1b[0m`);
      continue;
    }
    if (!providerModels.has(prov)) providerModels.set(prov, new Set());
    providerModels.get(prov).add(modelId);
  }

  // ── 5. 构建新的 models.json ──
  const newProviders = {};
  for (const [provName, targetModelIds] of providerModels) {
    const { baseUrl, apiKey, api } = resolveProviderCredentials(provName, rawConfig, opts);

    if (!baseUrl) {
      throw new Error(t("error.providerMissingBaseUrl", { provider: provName }));
    }
    if (!api) {
      throw new Error(t("error.providerMissingApi", { provider: provName }));
    }

    // 本地服务（localhost）不需要 apiKey，给个占位符让 Pi SDK 通过 hasAuth
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(baseUrl);
    if (!apiKey && !isLocal) {
      throw new Error(t("error.providerMissingApiKey", { provider: provName }));
    }
    const effectiveApiKey = apiKey || "local";

    // 已有的模型 metadata（按 id 索引，normalize 掉 models/ 前缀）
    const existingModels = new Map();
    for (const m of (modelsJson.providers?.[provName]?.models || [])) {
      const normalizedId = m.id?.startsWith("models/") ? m.id.slice(7) : m.id;
      existingModels.set(normalizedId, { ...m, id: normalizedId });
    }

    // 组装模型列表
    const modelList = [];
    for (let mid of targetModelIds) {
      // Gemini OpenAI 兼容 API 返回 "models/gemini-xxx" 格式，strip 前缀
      if (mid.startsWith("models/")) mid = mid.slice(7);
      if (existingModels.has(mid)) {
        const existing = { ...existingModels.get(mid) };
        const known = _knownModels[mid];
        if (!existing.name) existing.name = known?.name || humanizeName(mid);
        // 补全 input 字段（旧版本创建的条目可能缺 "image"，Pi SDK 会静默过滤图片）
        if (!existing.input || !existing.input.includes("image")) {
          existing.input = ["text", "image"];
        }
        // 补全 contextWindow / maxTokens（从 known-models.json）
        if (!existing.contextWindow && known?.context) existing.contextWindow = known.context;
        if (!existing.maxTokens && known?.maxOutput) existing.maxTokens = known.maxOutput;
        modelList.push(existing);
      } else {
        modelList.push(generateModelDefaults(mid));
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
  // 对旧 modelsJson 做同样的正规化（补 input/name），避免 backfill 造成虚假 diff
  const normalizedOld = { providers: {} };
  for (const [pn, pv] of Object.entries(modelsJson.providers || {})) {
    normalizedOld.providers[pn] = {
      ...pv,
      models: (pv.models || []).map(m => {
        const copy = { ...m };
        const km = _knownModels[copy.id];
        if (!copy.name) copy.name = km?.name || humanizeName(copy.id);
        if (!copy.input || !copy.input.includes("image")) copy.input = ["text", "image"];
        if (!copy.contextWindow && km?.context) copy.contextWindow = km.context;
        if (!copy.maxTokens && km?.maxOutput) copy.maxTokens = km.maxOutput;
        return copy;
      }),
    };
  }
  const newJson = { providers: newProviders };
  const oldStr = JSON.stringify(normalizedOld, null, 4);
  const newStr = JSON.stringify(newJson, null, 4);

  if (oldStr === newStr) return false;

  // ── 7. 写入 ──
  fs.writeFileSync(MODELS_JSON_PATH, newStr + "\n", "utf-8");
  console.log(`\x1b[90m  [sync] models.json 已更新\x1b[0m`);
  return true;
}
