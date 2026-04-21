/**
 * migrate-providers.js — 一次性迁移旧数据到 added-models.yaml
 *
 * 运行时机：engine.init() 启动时，model init 之前
 * 幂等：added-models.yaml 中 _migrated: true 存在则跳过
 *
 * 迁移源：
 *   1. per-agent config.yaml 的 providers 块
 *   2. per-agent config.yaml 的 api.api_key / api.base_url
 *   3. preferences.json 的 favorites 数组
 *   4. preferences.json 的 oauth_custom_models 对象
 *   5. providers.yaml 重命名（v0.69+ 文件改名迁移）
 */

import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { safeReadYAMLSync } from "../shared/safe-fs.js";
import { fromRoot } from "../shared/hana-root.js";

const _defaultModels = JSON.parse(
  fs.readFileSync(fromRoot("lib", "default-models.json"), "utf-8"),
);

/** 反查 default-models.json：模型 ID → provider name */
function resolveProviderForModel(modelId) {
  for (const [provider, models] of Object.entries(_defaultModels)) {
    if (models.includes(modelId)) return provider;
  }
  return null;
}

// ── 原子写入工具 ──────────────────────────────────────────────────────────────

function atomicWriteYAML(filePath, data, header = "") {
  const yamlStr = header + YAML.dump(data, {
    indent: 2,
    lineWidth: -1,
    sortKeys: false,
    quotingType: "\"",
    forceQuotes: false,
  });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, yamlStr, "utf-8");
  fs.renameSync(tmp, filePath);
}

function atomicWriteJSON(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, filePath);
}

// ── 主迁移函数 ────────────────────────────────────────────────────────────────

/**
 * 将旧数据整合到 added-models.yaml（幂等，只跑一次）
 *
 * @param {string} hanakoHome - 用户数据根目录（~/.hanako-dev）
 * @param {string} agentsDir  - agents 目录
 * @param {(msg: string) => void} log - 日志回调
 */
export function migrateToProvidersYaml(hanakoHome, agentsDir, log = () => {}) {
  const providersPath = path.join(hanakoHome, "added-models.yaml");
  const prefsPath = path.join(hanakoHome, "user", "preferences.json");

  // ── 文件改名迁移：providers.yaml → added-models.yaml ──
  const oldPath = path.join(hanakoHome, "providers.yaml");
  if (fs.existsSync(oldPath) && !fs.existsSync(providersPath)) {
    fs.renameSync(oldPath, providersPath);
    log("[migrate-providers] providers.yaml → added-models.yaml 重命名完成");
  }

  // ── 快速路径：已迁移则立即返回 ──
  const existingRaw = safeReadYAMLSync(providersPath, null, YAML);
  if (existingRaw?._migrated) return;

  // ── 检测是否有任何需要迁移的数据 ──
  const agentConfigs = _collectAgentConfigs(agentsDir);
  const prefs = _readPrefs(prefsPath);

  const hasAgentProviders = agentConfigs.some(ac => ac.config.providers);
  const hasAgentApiKey = agentConfigs.some(ac => ac.config.api?.api_key);
  const hasFavorites = Array.isArray(prefs.favorites) && prefs.favorites.length > 0;
  const hasOAuthCustom = prefs.oauth_custom_models && Object.keys(prefs.oauth_custom_models).length > 0;

  if (!hasAgentProviders && !hasAgentApiKey && !hasFavorites && !hasOAuthCustom) {
    // 没有需要迁移的数据，写标记后返回
    const data = existingRaw || {};
    data._migrated = true;
    const header =
      "# Hanako 供应商配置（全局，跨 agent 共享）\n" +
      "# 由设置页面管理\n\n";
    atomicWriteYAML(providersPath, data, header);
    log("[migrate-providers] 无旧数据需要迁移，已标记完成");
    return;
  }

  log("[migrate-providers] 检测到旧配置数据，开始迁移...");

  // ── 读取 added-models.yaml 当前内容 ──
  const raw = existingRaw || {};
  const providers = raw.providers || {};

  // ── Source 1: per-agent config.yaml providers 块 ──
  for (const ac of agentConfigs) {
    const agentProviders = ac.config.providers;
    if (!agentProviders || typeof agentProviders !== "object") continue;

    for (const [name, block] of Object.entries(agentProviders)) {
      if (!block || typeof block !== "object") continue;
      if (!providers[name]) providers[name] = {};

      // 合并凭证：不覆盖已有值
      if (block.api_key && !providers[name].api_key) {
        providers[name].api_key = block.api_key;
      }
      if (block.base_url && !providers[name].base_url) {
        providers[name].base_url = block.base_url;
      }
      if (block.api && !providers[name].api) {
        providers[name].api = block.api;
      }

      log(`[migrate-providers] agent "${ac.id}": providers.${name} → added-models.yaml`);
    }
  }

  // ── Source 2: per-agent config.yaml inline api credentials ──
  for (const ac of agentConfigs) {
    const api = ac.config.api;
    if (!api?.api_key) continue;

    const providerName = api.provider;
    if (!providerName) continue;

    if (!providers[providerName]) providers[providerName] = {};

    if (!providers[providerName].api_key) {
      providers[providerName].api_key = api.api_key;
    }
    if (api.base_url && !providers[providerName].base_url) {
      providers[providerName].base_url = api.base_url;
    }

    log(`[migrate-providers] agent "${ac.id}": api.api_key (${providerName}) → added-models.yaml`);
  }

  // ── Source 3: preferences.json favorites ──
  if (hasFavorites) {
    for (const fav of prefs.favorites) {
      const modelId = typeof fav === "object" ? fav.id : fav;
      let provider = typeof fav === "object" ? fav.provider : null;

      if (!modelId) continue;

      // 尝试从 added-models.yaml 中已有的模型列表找 provider
      if (!provider) {
        for (const [pName, pConf] of Object.entries(providers)) {
          if (Array.isArray(pConf.models) && pConf.models.some(
            m => (typeof m === "object" ? m.id : m) === modelId
          )) {
            provider = pName;
            break;
          }
        }
      }

      // 从 default-models.json 反查
      if (!provider) {
        provider = resolveProviderForModel(modelId);
      }

      if (!provider) {
        log(`[migrate-providers] favorites: 无法确定 "${modelId}" 的 provider，跳过`);
        continue;
      }

      _addModelToProvider(providers, provider, modelId);
      log(`[migrate-providers] favorites: "${modelId}" → added-models.yaml (${provider})`);
    }
  }

  // ── Source 4: preferences.json oauth_custom_models ──
  if (hasOAuthCustom) {
    for (const [provider, modelIds] of Object.entries(prefs.oauth_custom_models)) {
      if (!Array.isArray(modelIds)) continue;
      for (const modelId of modelIds) {
        _addModelToProvider(providers, provider, modelId);
        log(`[migrate-providers] oauth_custom_models: "${modelId}" → added-models.yaml (${provider})`);
      }
    }
  }

  // ── 写入 added-models.yaml ──
  raw.providers = providers;
  raw._migrated = true;
  const header =
    "# Hanako 供应商配置（全局，跨 agent 共享）\n" +
    "# 由设置页面管理\n\n";
  atomicWriteYAML(providersPath, raw, header);
  log("[migrate-providers] added-models.yaml 已更新");

  // ── 清理旧数据 ──

  // 清理 agent config.yaml
  for (const ac of agentConfigs) {
    let changed = false;

    // 删除 providers 块
    if (ac.config.providers) {
      delete ac.config.providers;
      changed = true;
    }

    // 删除 api.api_key（保留 api.provider）
    if (ac.config.api?.api_key) {
      delete ac.config.api.api_key;
      // 如果同时有 base_url，也清理（已迁移到 added-models.yaml）
      if (ac.config.api.base_url) {
        delete ac.config.api.base_url;
      }
      changed = true;
    }

    if (changed) {
      atomicWriteYAML(ac.path, ac.config);
      log(`[migrate-providers] 已清理 ${ac.id}/config.yaml`);
    }
  }

  // 清理 preferences.json
  if (hasFavorites || hasOAuthCustom) {
    if (hasFavorites) delete prefs.favorites;
    if (hasOAuthCustom) delete prefs.oauth_custom_models;
    atomicWriteJSON(prefsPath, prefs);
    log("[migrate-providers] 已清理 preferences.json (favorites, oauth_custom_models)");
  }

  log("[migrate-providers] 迁移完成");
}

// ── 内部工具 ─────────────────────────────────────────────────────────────────

/**
 * 收集所有 agent 的 config.yaml
 * @returns {Array<{id: string, path: string, config: object}>}
 */
function _collectAgentConfigs(agentsDir) {
  const result = [];
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const cfgPath = path.join(agentsDir, entry.name, "config.yaml");
      if (!fs.existsSync(cfgPath)) continue;
      const config = safeReadYAMLSync(cfgPath, null, YAML);
      if (!config) continue;
      result.push({ id: entry.name, path: cfgPath, config });
    }
  } catch {
    // agentsDir 不存在是合法的（全新安装）
  }
  return result;
}

/** 安全读取 preferences.json */
function _readPrefs(prefsPath) {
  try {
    return JSON.parse(fs.readFileSync(prefsPath, "utf-8")) || {};
  } catch {
    return {};
  }
}

/** 向 provider 的 models 列表添加模型（去重） */
function _addModelToProvider(providers, providerName, modelId) {
  if (!providers[providerName]) providers[providerName] = {};
  if (!Array.isArray(providers[providerName].models)) {
    providers[providerName].models = [];
  }
  const exists = providers[providerName].models.some(
    m => (typeof m === "object" ? m.id : m) === modelId,
  );
  if (!exists) {
    providers[providerName].models.push(modelId);
  }
}
