// shared/config-schema.js

/**
 * 配置字段 scope 声明 — 单一事实来源。
 *
 * - global: 存 preferences.json，跨 agent 共享
 * - agent（默认）: 存 agent config.yaml，per-agent 独立
 *
 * 未在此处声明的字段默认为 agent scope。
 * 嵌套路径最多支持 2 级（如 'capabilities.learn_skills'）。
 *
 * @typedef {'global' | 'agent'} ConfigScope
 * @typedef {object} FieldDef
 * @property {ConfigScope} scope
 * @property {string} [setter] - engine 上的 setter 方法名（仅 global scope）
 * @property {string} [getter] - engine 上的 getter 方法名（仅 global scope）
 */

/** @type {Record<string, FieldDef>} */
export const CONFIG_SCHEMA = {
  locale:                       { scope: 'global', setter: 'setLocale',         getter: 'getLocale' },
  timezone:                     { scope: 'global', setter: 'setTimezone',       getter: 'getTimezone' },
  sandbox:                      { scope: 'global', setter: 'setSandbox',        getter: 'getSandbox' },
  file_backup:                  { scope: 'global', setter: 'setFileBackup',    getter: 'getFileBackup' },
  update_channel:               { scope: 'global', setter: 'setUpdateChannel',  getter: 'getUpdateChannel' },
  thinking_level:               { scope: 'global', setter: 'setThinkingLevel',  getter: 'getThinkingLevel' },
  'capabilities.learn_skills':  { scope: 'global', setter: 'setLearnSkills',    getter: 'getLearnSkills' },
  'desk.heartbeat_master':      { scope: 'global', setter: 'setHeartbeatMaster', getter: 'getHeartbeatMaster' },
};

// 未声明的字段默认为 agent scope，不需要额外导出。
// 迁移逻辑直接遍历 CONFIG_SCHEMA。
