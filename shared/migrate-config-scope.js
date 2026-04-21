// shared/migrate-config-scope.js

import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { CONFIG_SCHEMA } from './config-schema.js';

/**
 * 一次性迁移：将 agent config.yaml 中的 global scope 字段
 * 向上迁移到 preferences.json，然后从 config.yaml 中删除。
 *
 * 策略：migrate up, then clean。
 * - 如果 preferences 中已有非默认值，以 preferences 为准
 * - 如果 preferences 中无值，从 primary agent 的 config.yaml 取
 * - 迁移前对每个 agent 的 config.yaml 做 .pre-scope-migration 备份
 *
 * @param {object} opts
 * @param {string} opts.agentsDir - agents 根目录
 * @param {object} opts.prefs - PreferencesManager 实例
 * @param {string|null} opts.primaryAgentId - 主 agent ID
 * @param {(msg: string) => void} [opts.log] - 日志回调
 */
export function migrateConfigScope({ agentsDir, prefs, primaryAgentId, log = () => {} }) {
  const preferences = prefs.getPreferences();

  // 已迁移过则跳过
  if (preferences._configScopeMigrated) return;

  log("[migrate] config scope 迁移开始...");

  // 收集所有 agent 的 config.yaml
  let agentConfigs = [];
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const cfgPath = path.join(agentsDir, entry.name, "config.yaml");
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const content = fs.readFileSync(cfgPath, "utf-8");
        const config = YAML.load(content) || {};
        agentConfigs.push({ id: entry.name, path: cfgPath, config, content });
      } catch {}
    }
  } catch {
    return;
  }

  if (agentConfigs.length === 0) {
    preferences._configScopeMigrated = true;
    prefs.savePreferences(preferences);
    return;
  }

  // 按优先级排序：primary agent 在前
  agentConfigs.sort((a, b) => {
    if (a.id === primaryAgentId) return -1;
    if (b.id === primaryAgentId) return 1;
    return 0;
  });

  // 默认值表（用于判断 preferences 中是否有有效值）
  const DEFAULTS = {
    locale: "",
    timezone: "",
    sandbox: true,
    update_channel: "stable",
    thinking_level: "auto",
  };

  // Phase 1: migrate up — 将 agent config 中的全局值提升到 preferences
  let prefsChanged = false;
  for (const [schemaPath, def] of Object.entries(CONFIG_SCHEMA)) {
    if (def.scope !== 'global') continue;

    const parts = schemaPath.split('.');
    // 读 preferences 中的当前值
    let prefsValue;
    if (parts.length === 1) {
      prefsValue = preferences[parts[0]];
    } else if (parts.length === 2) {
      prefsValue = preferences[parts[0]]?.[parts[1]];
    }

    // 判断 preferences 是否已有非默认值
    const defaultVal = DEFAULTS[parts[0]];
    const prefsHasValue = prefsValue !== undefined && prefsValue !== defaultVal;
    if (prefsHasValue) continue; // preferences 已有值，不覆盖

    // 从 agent configs 中找第一个有值的（已按 primary 优先排序）
    for (const ac of agentConfigs) {
      let agentValue;
      if (parts.length === 1) {
        agentValue = ac.config[parts[0]];
      } else if (parts.length === 2) {
        agentValue = ac.config[parts[0]]?.[parts[1]];
      }

      if (agentValue !== undefined && agentValue !== defaultVal) {
        // 写入 preferences
        if (parts.length === 1) {
          preferences[parts[0]] = agentValue;
        } else if (parts.length === 2) {
          if (!preferences[parts[0]]) preferences[parts[0]] = {};
          preferences[parts[0]][parts[1]] = agentValue;
        }
        prefsChanged = true;
        log(`[migrate] ${schemaPath}: "${JSON.stringify(agentValue)}" migrated from agent "${ac.id}" to preferences`);
        break;
      }
    }
  }

  // Phase 2: clean — 从所有 agent config.yaml 中删除 global scope 字段
  for (const ac of agentConfigs) {
    let changed = false;
    for (const schemaPath of Object.keys(CONFIG_SCHEMA)) {
      const parts = schemaPath.split('.');
      if (parts.length === 1 && parts[0] in ac.config) {
        delete ac.config[parts[0]];
        changed = true;
      } else if (parts.length === 2) {
        if (ac.config[parts[0]]?.[parts[1]] !== undefined) {
          delete ac.config[parts[0]][parts[1]];
          if (Object.keys(ac.config[parts[0]]).length === 0) {
            delete ac.config[parts[0]];
          }
          changed = true;
        }
      }
    }

    if (changed) {
      // 备份
      const backupPath = ac.path + ".pre-scope-migration";
      if (!fs.existsSync(backupPath)) {
        fs.writeFileSync(backupPath, ac.content, "utf-8");
      }
      // 写回清理后的 config
      fs.writeFileSync(ac.path, YAML.dump(ac.config, { lineWidth: -1 }), "utf-8");
      log(`[migrate] cleaned global fields from ${ac.id}/config.yaml`);
    }
  }

  // 标记迁移完成并写入（无论是否有值变更，都需要持久化 _configScopeMigrated）
  preferences._configScopeMigrated = true;
  prefs.savePreferences(preferences);

  log("[migrate] config scope 迁移完成");
}
