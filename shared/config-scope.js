// shared/config-scope.js

import { CONFIG_SCHEMA } from './config-schema.js';

/**
 * 根据 schema 将 partial config 拆分为 global 和 agent 两部分。
 *
 * @param {Record<string, unknown>} partial - 前端发来的 config patch
 * @returns {{ global: Array<{ key: string, value: unknown, setter: string }>, agent: Record<string, unknown> }}
 */
export function splitByScope(partial) {
  const global = [];
  const agent = {};

  // 浅拷贝顶层，对含有嵌套 global 字段的 parent 做额外一层拷贝
  for (const key of Object.keys(partial)) {
    agent[key] = partial[key];
  }
  for (const path of Object.keys(CONFIG_SCHEMA)) {
    const parts = path.split('.');
    if (parts.length === 2 && agent[parts[0]] && typeof agent[parts[0]] === 'object') {
      agent[parts[0]] = { ...agent[parts[0]] };
    }
  }

  for (const [path, def] of Object.entries(CONFIG_SCHEMA)) {
    if (def.scope !== 'global' || !def.setter) continue;

    const parts = path.split('.');
    if (parts.length === 1) {
      if (parts[0] in agent && agent[parts[0]] !== undefined) {
        global.push({ key: path, value: agent[parts[0]], setter: def.setter });
        delete agent[parts[0]];
      }
    } else if (parts.length === 2) {
      const [parent, child] = parts;
      if (agent[parent]?.[child] !== undefined) {
        global.push({ key: path, value: agent[parent][child], setter: def.setter });
        delete agent[parent][child];
        if (Object.keys(agent[parent]).length === 0) delete agent[parent];
      }
    }
    // depth > 2: 不处理，视为 agent scope
  }

  return { global, agent };
}

/**
 * 将 global scope 字段从 engine 注入到 config 对象中。
 *
 * @param {Record<string, unknown>} config - 将被修改的 config 对象
 * @param {Record<string, Function>} engine - 需要有 schema 中声明的 getter 方法
 */
export function injectGlobalFields(config, engine) {
  for (const [path, def] of Object.entries(CONFIG_SCHEMA)) {
    if (def.scope !== 'global' || !def.getter) continue;
    if (typeof engine[def.getter] !== 'function') continue;

    const value = engine[def.getter]();
    const parts = path.split('.');

    if (parts.length === 1) {
      config[parts[0]] = value;
    } else if (parts.length === 2) {
      const [parent, child] = parts;
      if (!config[parent] || typeof config[parent] !== 'object') config[parent] = {};
      config[parent][child] = value;
    }
  }
}
