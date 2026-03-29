/**
 * model-sync.js — added-models.yaml → models.json 单向投影
 *
 * 系统中唯一写 models.json 的地方。从 providers 配置（snake_case）
 * 投影为 Pi SDK 格式（camelCase），附加 known-models.json 元数据。
 */

import fs from "fs";
import { isLocalBaseUrl } from "../shared/net-utils.js";
import { lookupKnown } from "../shared/known-models.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;

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

/**
 * 构建单个模型的 Pi SDK 格式条目
 * @param {string|{id:string, name?:string, context?:number, maxOutput?:number}} modelEntry
 * @param {string} provider - provider 名称（查词典用）
 */
function buildModelEntry(modelEntry, provider) {
  const isObj = typeof modelEntry === "object" && modelEntry !== null;
  const id = isObj ? modelEntry.id : modelEntry;
  const known = lookupKnown(provider, id);

  // 优先级：用户设置（added-models.yaml 对象字段）> known-models 词典 > 默认值
  const vision = (isObj && modelEntry.vision !== undefined) ? modelEntry.vision : (known?.vision === true);
  const entry = {
    id,
    name: (isObj && modelEntry.name) || known?.name || humanizeName(id),
    input: vision ? ["text", "image"] : ["text"],
    contextWindow: (isObj && modelEntry.context) || known?.context || DEFAULT_CONTEXT_WINDOW,
    vision,
    reasoning: (isObj && modelEntry.reasoning !== undefined) ? modelEntry.reasoning : (known?.reasoning === true),
  };

  const maxOutput = (isObj && modelEntry.maxOutput) || known?.maxOutput;
  if (maxOutput) entry.maxTokens = maxOutput;

  if (known?.quirks?.length) entry.quirks = known.quirks;

  // Pi SDK compat 覆盖：
  // 1. 非 OpenAI provider 不发 developer role（dashscope 等不支持）— 与 reasoning 无关
  // 2. 推理模型 + enable_thinking quirk → qwen thinkingFormat
  if (provider !== "openai") {
    const compat = { supportsDeveloperRole: false };
    if (entry.reasoning && entry.quirks?.includes("enable_thinking")) {
      compat.thinkingFormat = "qwen";
    }
    entry.compat = compat;
  }

  return entry;
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

    let apiKey = p.api_key || "";

    // 无 api_key 时尝试 OAuth 查找
    if (!apiKey) {
      const authKey = oauthKeyMap[name] || name;
      apiKey = extractApiKey(getAuthJson()[authKey]);
    }

    // 无凭证且非 localhost，跳过
    const isLocal = isLocalBaseUrl(p.base_url);
    if (!apiKey && !isLocal) continue;

    const effectiveApiKey = apiKey || "local";

    newProviders[name] = {
      baseUrl: p.base_url,
      api: p.api || "openai-completions",
      apiKey: effectiveApiKey,
      models: p.models.map(m => buildModelEntry(m, name)),
    };
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
