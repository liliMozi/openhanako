/**
 * pii-guard.js — PII / 凭证检测与脱敏
 *
 * 在持久化写入前（fact-store、pinned-memory、session-summary）
 * 检测并脱敏敏感信息，防止凭证和关键 PII 被写入存储。
 */

/** 硬脱敏：检测到直接替换为 [REDACTED] */
const HARD_PATTERNS = [
  // API keys（sk-*, AKIA*、gsk_* 等常见前缀）
  { name: "api_key", regex: /\b(sk-[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16}|gsk_[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|glpat-[a-zA-Z0-9_-]{20,}|xoxb-[a-zA-Z0-9-]+)\b/g },

  // 通用 secret/token/password 赋值（key=xxx, token: xxx）
  { name: "inline_secret", regex: /\b(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password)\s*[:=]\s*["']?([a-zA-Z0-9_/+=.-]{16,})["']?/gi },

  // PEM 私钥
  { name: "private_key", regex: /-----BEGIN\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },

  // 信用卡号（Luhn 不做，但 4 组 4 位数字检测）
  { name: "credit_card", regex: /\b(?:\d{4}[- ]?){3}\d{4}\b/g },

  // 中国身份证号（18位）
  { name: "id_card", regex: /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g },

  // SSN（美国社保号）
  { name: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
];

/**
 * 检测文本中的敏感信息并脱敏
 * @param {string} text - 待检查文本
 * @returns {{ cleaned: string, detected: string[] }} 脱敏后的文本 + 检测到的类型列表
 */
export function scrubPII(text) {
  if (!text) return { cleaned: text, detected: [] };

  const detected = [];
  let cleaned = text;

  for (const { name, regex } of HARD_PATTERNS) {
    // 重置 lastIndex（全局正则在复用时需要）
    regex.lastIndex = 0;
    if (regex.test(cleaned)) {
      detected.push(name);
      regex.lastIndex = 0;
      cleaned = cleaned.replace(regex, "[REDACTED]");
    }
  }

  return { cleaned, detected };
}

/**
 * 检测是否包含敏感信息（不修改文本）
 * @param {string} text
 * @returns {boolean}
 */
export function hasPII(text) {
  if (!text) return false;
  for (const { regex } of HARD_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(text)) return true;
  }
  return false;
}
