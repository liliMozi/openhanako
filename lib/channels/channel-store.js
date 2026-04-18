/**
 * channel-store.js — 频道 MD 文件的读写层
 *
 * 频道 = 一个 MD 文件，frontmatter 记元数据，正文是消息流。
 * 每个 agent 的 channels.md 记录她加入了哪些频道、读到哪了（bookmark = 时间戳）。
 *
 * 设计原则：文件就是一切，不引入数据库。
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { t } from "../../server/i18n.js";

// ═══════════════════════════════════════
//  文件锁（进程内互斥，防止并发读写同一文件）
// ═══════════════════════════════════════

const _fileLocks = new Map(); // filePath → Promise

/**
 * 对指定文件加锁执行 fn（串行化同文件的并发操作）
 * 不同文件之间不互相阻塞
 */
function withFileLock(filePath, fn) {
  const prev = _fileLocks.get(filePath) || Promise.resolve();
  const next = prev.then(fn, fn); // 无论前一个成功失败都继续
  _fileLocks.set(filePath, next);
  // 清理已完成的锁（防止 Map 无限增长）
  next.then(() => {
    if (_fileLocks.get(filePath) === next) _fileLocks.delete(filePath);
  });
  return next;
}

// ═══════════════════════════════════════
//  消息解析
// ═══════════════════════════════════════

/** 消息 header 正则：### sender | YYYY-MM-DD HH:MM[:SS]（兼容旧格式） */
const MSG_HEADER_RE = /^### (.+?) \| (\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)$/;

/**
 * 解析频道 MD 文件，提取 frontmatter 和消息列表
 * @param {string} content - 频道 MD 文件的全文
 * @returns {{ meta: object, messages: Array<{sender: string, timestamp: string, body: string}> }}
 */
export function parseChannel(content) {
  const lines = content.split("\n");
  let meta = {};
  let bodyStart = 0;

  // 解析 frontmatter（--- ... ---）
  if (lines[0]?.trim() === "---") {
    let fmEnd = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        fmEnd = i;
        break;
      }
    }
    if (fmEnd > 0) {
      const fmLines = lines.slice(1, fmEnd);
      meta = parseFrontmatter(fmLines);
      bodyStart = fmEnd + 1;
    }
  }

  // 解析消息流
  const messages = [];
  let current = null;
  const bodyLines = [];

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(MSG_HEADER_RE);

    if (match) {
      // 保存上一条消息
      if (current) {
        current.body = bodyLines.join("\n").trim();
        messages.push(current);
        bodyLines.length = 0;
      }
      current = { sender: match[1], timestamp: match[2], body: "" };
    } else if (current) {
      // 跳过分隔线 ---
      if (line.trim() === "---") continue;
      bodyLines.push(line);
    }
  }

  // 最后一条消息
  if (current) {
    current.body = bodyLines.join("\n").trim();
    messages.push(current);
  }

  return { meta, messages };
}

/**
 * 简易 frontmatter 解析（不依赖 YAML 库）
 * 支持：key: value、key: [a, b, c]
 */
function parseFrontmatter(lines) {
  const result = {};
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    let val = line.slice(colonIdx + 1).trim();

    // 数组：[a, b, c]
    if (val.startsWith("[") && val.endsWith("]")) {
      val = val.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
    }
    result[key] = val;
  }
  return result;
}

/**
 * 将 meta 对象序列化为 frontmatter 字符串
 */
function serializeFrontmatter(meta) {
  const lines = ["---"];
  for (const [key, val] of Object.entries(meta)) {
    if (Array.isArray(val)) {
      lines.push(`${key}: [${val.join(", ")}]`);
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

// ═══════════════════════════════════════
//  频道文件操作
// ═══════════════════════════════════════

/**
 * 生成 channel ID
 * @param {string} [customId] - 用户自定义 ID（如 "crew"），省略则自动生成
 * @returns {string} 带 ch_ 前缀的 ID
 */
export function generateChannelId(customId) {
  const base = customId || crypto.randomUUID().slice(0, 6);
  return base.startsWith("ch_") ? base : `ch_${base}`;
}

/**
 * 创建频道 MD 文件
 * @param {string} channelsDir - 频道目录路径
 * @param {object} opts
 * @param {string} [opts.id] - channel ID（不传则自动生成）
 * @param {string} [opts.name] - 频道显示名
 * @param {string} [opts.description] - 频道描述
 * @param {string[]} opts.members - 成员列表
 * @param {string} [opts.intro] - 频道介绍（作为第一条系统消息）
 * @returns {{ filePath: string, id: string }}
 */
export function createChannel(channelsDir, { id, name, description, members, intro }) {
  fs.mkdirSync(channelsDir, { recursive: true });
  const channelId = id ? (id.startsWith("ch_") ? id : `ch_${id}`) : generateChannelId();
  const filePath = path.join(channelsDir, `${channelId}.md`);

  if (fs.existsSync(filePath)) {
    throw new Error(t("error.channelAlreadyExists", { id: channelId }));
  }

  const meta = { id: channelId, members };
  if (name) meta.name = name;
  if (description) meta.description = description;
  const parts = [serializeFrontmatter(meta), ""];

  if (intro) {
    const ts = formatTimestamp(new Date());
    parts.push(`### system | ${ts}`, "", intro, "", "---", "");
  }

  fs.writeFileSync(filePath, parts.join("\n"), "utf-8");
  return { filePath, id: channelId };
}

/**
 * 向频道追加一条消息
 * @param {string} filePath - 频道 MD 文件路径
 * @param {string} sender - 发送者名称
 * @param {string} body - 消息正文
 * @returns {{ timestamp: string }} 写入的时间戳
 */
export function appendMessage(filePath, sender, body) {
  const ts = formatTimestamp(new Date());
  const block = `\n### ${sender} | ${ts}\n\n${body.trim()}\n\n---\n`;
  fs.appendFileSync(filePath, block, "utf-8");
  return { timestamp: ts };
}

/**
 * 读取频道中 bookmark 之后的新消息
 * @param {string} filePath - 频道 MD 文件路径
 * @param {string} [bookmark] - 上次读到的时间戳（null = 读全部）
 * @param {string} [selfName] - 自己的名字（跳过自己发的消息）
 * @returns {Array<{sender: string, timestamp: string, body: string}>}
 */
export function getNewMessages(filePath, bookmark, selfName) {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, "utf-8");
  const { messages } = parseChannel(content);

  let filtered = messages;

  // 只取 bookmark 之后的消息
  if (bookmark) {
    filtered = filtered.filter(m => m.timestamp > bookmark);
  }

  // 跳过自己发的
  if (selfName) {
    filtered = filtered.filter(m => m.sender !== selfName);
  }

  return filtered;
}

/**
 * 获取频道最近 N 条消息（滑动窗口，跳过自己发的）
 * @param {string} filePath - 频道 MD 文件路径
 * @param {number} [count=10] - 最多取几条
 * @param {string} [selfName] - 自己的名字（跳过自己发的）
 * @returns {Array<{sender: string, timestamp: string, body: string}>}
 */
export function getRecentMessages(filePath, count = 10, selfName) {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, "utf-8");
  const { messages } = parseChannel(content);

  let filtered = selfName
    ? messages.filter(m => m.sender !== selfName)
    : messages;

  return filtered.slice(-count);
}

/**
 * 获取频道的成员列表
 * @param {string} filePath - 频道 MD 文件路径
 * @returns {string[]}
 */
export function getChannelMembers(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  const { meta } = parseChannel(content);
  return Array.isArray(meta.members) ? meta.members : [];
}

/**
 * 获取频道的元数据（id, name, description, members 等）
 * @param {string} filePath - 频道 MD 文件路径
 * @returns {object}
 */
export function getChannelMeta(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, "utf-8");
  const { meta } = parseChannel(content);
  return meta;
}

/**
 * 向频道的 members 列表中追加新成员
 * @param {string} filePath - 频道 MD 文件路径
 * @param {string} memberId - 新成员 ID
 */
export function addChannelMember(filePath, memberId) {
  rewriteFrontmatter(filePath, (meta) => {
    const members = Array.isArray(meta.members) ? meta.members : [];
    if (members.includes(memberId)) return false; // 已存在，不写
    members.push(memberId);
    meta.members = members;
    return true;
  });
}

/**
 * 从频道的 members 列表中移除某个成员
 * @param {string} filePath - 频道 MD 文件路径
 * @param {string} memberId - 要移除的成员 ID
 */
export function removeChannelMember(filePath, memberId) {
  if (!fs.existsSync(filePath)) return;
  rewriteFrontmatter(filePath, (meta) => {
    const members = Array.isArray(meta.members) ? meta.members : [];
    const idx = members.indexOf(memberId);
    if (idx < 0) return false; // 不在成员列表中，不写
    members.splice(idx, 1);
    meta.members = members;
    return true;
  });
}

/**
 * 读取频道文件，修改 frontmatter 后重写，保留消息部分不变
 *
 * 安全性：写入时重新读取文件获取最新 body，避免 TOCTOU 丢消息。
 * 使用 atomic write（tmp + rename）防止写到一半崩溃。
 *
 * @param {string} filePath - 频道 MD 文件路径
 * @param {(meta: object) => boolean} mutator - 修改 meta 对象，返回 true 表示需要写入
 */
function rewriteFrontmatter(filePath, mutator) {
  const content = fs.readFileSync(filePath, "utf-8");
  const { meta } = parseChannel(content);

  if (!mutator(meta)) return; // mutator 返回 false 表示无需修改

  // 写入时重新读取文件，获取最新的 body（防止 appendMessage 的内容被覆盖）
  const freshContent = fs.readFileSync(filePath, "utf-8");
  const freshLines = freshContent.split("\n");
  let fmEnd = 0;
  if (freshLines[0]?.trim() === "---") {
    for (let i = 1; i < freshLines.length; i++) {
      if (freshLines[i].trim() === "---") { fmEnd = i; break; }
    }
  }

  const body = freshLines.slice(fmEnd + 1).join("\n");
  const newContent = serializeFrontmatter(meta) + "\n" + body;

  // atomic write
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, newContent, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * 删除频道文件
 * @param {string} filePath - 频道 MD 文件路径
 */
export function deleteChannel(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// ═══════════════════════════════════════
//  Bookmark 管理（agent 的 channels.md）
// ═══════════════════════════════════════

/**
 * channels.md 格式：
 *
 * # 频道
 *
 * - crew (last: 2026-02-27 14:30)
 * - hana-butter (last: 2026-02-27 13:00)
 */

const BOOKMARK_RE = /^- (.+?) \(last: (.+?)\)$/;

/**
 * 读取 agent 的频道 bookmark 列表
 * @param {string} channelsMdPath - agent 的 channels.md 路径
 * @returns {Map<string, string>} channelName → lastReadTimestamp
 */
export function readBookmarks(channelsMdPath) {
  const bookmarks = new Map();
  if (!fs.existsSync(channelsMdPath)) return bookmarks;

  const content = fs.readFileSync(channelsMdPath, "utf-8");
  for (const line of content.split("\n")) {
    const match = line.match(BOOKMARK_RE);
    if (match) {
      bookmarks.set(match[1], match[2]);
    }
  }
  return bookmarks;
}

/**
 * 更新 agent 的某个频道 bookmark
 * @param {string} channelsMdPath - agent 的 channels.md 路径
 * @param {string} channelName - 频道名
 * @param {string} timestamp - 新的已读时间戳
 */
export function updateBookmark(channelsMdPath, channelName, timestamp) {
  const bookmarks = readBookmarks(channelsMdPath);
  bookmarks.set(channelName, timestamp);
  writeBookmarks(channelsMdPath, bookmarks);
}

/**
 * 向 agent 的 channels.md 添加一个新频道条目
 * @param {string} channelsMdPath - agent 的 channels.md 路径
 * @param {string} channelName - 频道名
 */
export function addBookmarkEntry(channelsMdPath, channelName) {
  const bookmarks = readBookmarks(channelsMdPath);
  if (!bookmarks.has(channelName)) {
    bookmarks.set(channelName, "never");
    writeBookmarks(channelsMdPath, bookmarks);
  }
}

/**
 * 从 agent 的 channels.md 移除某个频道条目
 * @param {string} channelsMdPath - agent 的 channels.md 路径
 * @param {string} channelName - 要移除的频道名
 */
export function removeBookmarkEntry(channelsMdPath, channelName) {
  const bookmarks = readBookmarks(channelsMdPath);
  if (bookmarks.has(channelName)) {
    bookmarks.delete(channelName);
    writeBookmarks(channelsMdPath, bookmarks);
  }
}

/**
 * 将 bookmark map 写回 channels.md
 */
function writeBookmarks(channelsMdPath, bookmarks) {
  const lines = ["# 频道", ""];
  for (const [name, ts] of bookmarks) {
    lines.push(`- ${name} (last: ${ts})`);
  }
  lines.push(""); // trailing newline
  fs.mkdirSync(path.dirname(channelsMdPath), { recursive: true });
  // atomic write
  const tmpPath = channelsMdPath + ".tmp";
  fs.writeFileSync(tmpPath, lines.join("\n"), "utf-8");
  fs.renameSync(tmpPath, channelsMdPath);
}

// ═══════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════

/**
 * 格式化时间戳为 YYYY-MM-DD HH:MM
 * @param {Date} date
 * @returns {string}
 */
function formatTimestamp(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

/**
 * 将消息数组格式化为人类可读文本（用于传给 LLM）
 * @param {Array<{sender: string, timestamp: string, body: string}>} messages
 * @returns {string}
 */
export function formatMessagesForLLM(messages) {
  if (messages.length === 0) return getLocale().startsWith("zh") ? "(没有新消息)" : "(no new messages)";
  return messages
    .map(m => `[${m.timestamp}] ${m.sender}: ${m.body}`)
    .join("\n\n");
}
