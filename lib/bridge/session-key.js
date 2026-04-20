/**
 * session-key.js — bridge sessionKey 解析工具
 *
 * 从 sessionKey 中提取平台、聊天类型、chatId。
 * 数据驱动：新增平台只需在 SESSION_PREFIX_MAP 注册前缀。
 */

// sessionKey 前缀 → [platform, chatType]
export const SESSION_PREFIX_MAP = [
  ["tg_dm_",       "telegram",     "dm"],
  ["tg_group_",    "telegram",     "group"],
  ["fs_dm_",       "feishu",       "dm"],
  ["fs_group_",    "feishu",       "group"],
  ["qq_dm_",       "qq",           "dm"],
  ["qq_group_",    "qq",           "group"],
  ["wx_dm_",       "wechat",       "dm"],
  ["wc_dm_",       "workwechat",   "dm"],
  ["wc_group_",    "workwechat",   "group"],
];

/** 已知基础平台列表（从前缀表去重） */
export const KNOWN_PLATFORMS = [...new Set(SESSION_PREFIX_MAP.map(([, p]) => p))];

/**
 * 判断是否为有效的实例 ID（基础平台名在已知列表中）。
 * 支持 "feishu", "feishu:2", "telegram" 等格式。
 */
export function isValidInstanceId(instanceId) {
  const base = getBasePlatform(instanceId);
  return KNOWN_PLATFORMS.includes(base);
}

/**
 * 从实例 ID 中提取基础平台名。
 * "feishu" → "feishu", "feishu:2" → "feishu"
 */
export function getBasePlatform(instanceId) {
  const idx = instanceId.indexOf(":");
  return idx === -1 ? instanceId : instanceId.slice(0, idx);
}

/** 从 sessionKey 解析平台 + 类型 + chatId */
export function parseSessionKey(sessionKey) {
  for (const [prefix, platform, chatType] of SESSION_PREFIX_MAP) {
    if (sessionKey.startsWith(prefix)) {
      return { platform, chatType, chatId: sessionKey.slice(prefix.length) };
    }
  }
  return { platform: "unknown", chatType: "dm", chatId: sessionKey };
}

/**
 * 从 bridge index 中按 userId 去重收集已知用户
 * @param {object} index - bridge-index.json 的内容
 * @returns {Record<string, Array<{userId: string, name: string|null}>>}
 */
export function collectKnownUsers(index) {
  const byPlatform = {};

  for (const [sessionKey, raw] of Object.entries(index)) {
    const entry = typeof raw === "string" ? { file: raw } : raw;
    if (!entry.userId) continue;

    const { platform } = parseSessionKey(sessionKey);
    if (platform === "unknown") continue;

    if (!byPlatform[platform]) byPlatform[platform] = new Map();
    const map = byPlatform[platform];
    if (!map.has(entry.userId) || entry.name) {
      map.set(entry.userId, { userId: entry.userId, name: entry.name || null });
    }
  }

  const result = {};
  for (const [platform, map] of Object.entries(byPlatform)) {
    result[platform] = [...map.values()];
  }
  return result;
}
