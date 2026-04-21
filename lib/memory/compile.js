/**
 * compile.js — 记忆编译器（v3 四块独立编译 + assemble）
 *
 * 四个独立函数各自有指纹缓存，互不依赖：
 *   compileToday()    → today.md（当天 sessions）
 *   compileWeek()     → week.md（过去7天滑动窗口）
 *   compileLongterm() → longterm.md（fold 周报到长期）
 *   compileFacts()    → facts.md（重要事实，继承上一版）
 *
 * assemble() 同步读取四个文件，拼成 memory.md（≤2000 token）。
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getLogicalDay } from "../time-utils.js";
import { callText } from "../../core/llm-client.js";
import { getLocale } from "../../server/i18n.js";
import { safeReadFile } from "../../shared/safe-fs.js";

function _isZh() { return getLocale().startsWith("zh"); }

const EMPTY_MEMORY_ZH = "（暂无记忆）\n";
const EMPTY_MEMORY_EN = "(No memory yet)\n";
export function getEmptyMemory() { return _isZh() ? EMPTY_MEMORY_ZH : EMPTY_MEMORY_EN; }

// ════════════════════════════
//  v3 四块独立编译 + assemble
// ════════════════════════════

/**
 * 编译今天的 session 摘要 → today.md
 * @param {import('./session-summary.js').SessionSummaryManager} summaryManager
 * @param {string} outputPath
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @returns {Promise<"compiled"|"skipped">}
 */
export async function compileToday(summaryManager, outputPath, resolvedModel) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const { rangeStart } = getLogicalDay();
  const sessions = summaryManager.getSummariesInRange(rangeStart, new Date());
  const fpPath = outputPath + ".fingerprint";

  // 空 sessions 不写 fingerprint：rollingSummary 失败期会让 sessions 持续为空，
  // 若落下 "empty" 指纹，之后 summary 恢复前该指纹仍会命中（因为下一次也是 empty），
  // 导致 today.md 永远卡在 0 bytes。只在有真实 session 摘要时用 fingerprint 去重。
  if (sessions.length === 0) {
    try { fs.unlinkSync(fpPath); } catch {}
    const cur = safeReadFile(outputPath, "");
    if (cur.length > 0) atomicWrite(outputPath, "");
    return "compiled";
  }

  const fpKeys = sessions.map((s) => `${s.session_id}:${s.updated_at}`);
  const fp = computeFingerprint(fpKeys);
  try {
    if (fs.readFileSync(fpPath, "utf-8").trim() === fp && fs.existsSync(outputPath)) return "skipped";
  } catch {}

  const input = sessions.map((s) => s.summary).join("\n\n---\n\n");
  const isZh = _isZh();
  const result = await _compactLLM(
    input,
    isZh
      ? "将以下今天的对话摘要整合成一段概要（500字以内）。重点突出，抓关键事件和决策，保留时间标注（HH:MM）。直接输出概要文本。"
      : "Consolidate the following conversation summaries from today into a single overview (under 300 words). Highlight key events and decisions, preserve time stamps (HH:MM). Output the overview text directly.",
    resolvedModel,
    750,
  );

  atomicWrite(outputPath, result);
  fs.writeFileSync(fpPath, fp);
  return "compiled";
}

/**
 * 编译过去 7 天滑动窗口的摘要 → week.md
 * @param {object} resolvedModel
 */
export async function compileWeek(summaryManager, outputPath, resolvedModel) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);

  const sessions = summaryManager.getSummariesInRange(sevenDaysAgo, now);
  const fpPath = outputPath + ".fingerprint";

  // 空 sessions 不写 fingerprint：同 compileToday 的理由，避免失败态被指纹锁死。
  if (sessions.length === 0) {
    try { fs.unlinkSync(fpPath); } catch {}
    const cur = safeReadFile(outputPath, "");
    if (cur.length > 0) atomicWrite(outputPath, "");
    return "compiled";
  }

  const fpKeys = sessions.map((s) => `${s.session_id}:${s.updated_at}`);
  const fp = computeFingerprint(fpKeys);
  try {
    if (fs.readFileSync(fpPath, "utf-8").trim() === fp && fs.existsSync(outputPath)) return "skipped";
  } catch {}

  const input = sessions.map((s) => s.summary).join("\n\n---\n\n");
  const isZh = _isZh();
  const result = await _compactLLM(
    input,
    isZh
      ? "将以下过去7天的对话摘要整合成一段概要（500字以内）。提炼主要主题和重要事件，不要保留精确时间戳（避免和当天混淆），可以用「前几天」「周初」等模糊时间表述。直接输出概要文本。"
      : "Consolidate the following conversation summaries from the past 7 days into a single overview (under 300 words). Extract major themes and important events. Do NOT preserve exact timestamps (to avoid confusion with today); use vague references like 'a few days ago' or 'earlier this week' instead. Output the overview text directly.",
    resolvedModel,
    750,
  );

  atomicWrite(outputPath, result);
  fs.writeFileSync(fpPath, fp);
  return "compiled";
}

/**
 * 将 week.md fold 进 longterm.md（每日一次）
 * @param {object} resolvedModel
 */
export async function compileLongterm(weekMdPath, longtermPath, resolvedModel) {
  fs.mkdirSync(path.dirname(longtermPath), { recursive: true });

  const weekContent = safeReadFile(weekMdPath, "").trim();

  if (!weekContent) return "skipped";

  // fingerprint：week.md 内容没变就跳过，避免每天把同一批内容反复折叠
  const fp = computeFingerprint([weekContent]);
  const fpPath = longtermPath + ".fingerprint";
  try {
    if (fs.readFileSync(fpPath, "utf-8").trim() === fp && fs.existsSync(longtermPath)) return "skipped";
  } catch {}

  const prevLongterm = safeReadFile(longtermPath, "").trim();

  const isZh = _isZh();
  const input = prevLongterm
    ? (isZh
        ? `## 上一份长期情况\n\n${prevLongterm}\n\n## 本周新增\n\n${weekContent}`
        : `## Previous long-term context\n\n${prevLongterm}\n\n## This week's additions\n\n${weekContent}`)
    : weekContent;

  const result = await _compactLLM(
    input,
    isZh
      ? "将以下内容整合成长期背景记录（300字以内）。只保留持续性的、跨时间有意义的背景信息，去掉单次性事件细节。直接输出记录文本。"
      : "Consolidate the following into a long-term background record (under 200 words). Keep only persistent, cross-temporal background information; remove one-off event details. Output the record text directly.",
    resolvedModel,
    450,
  );

  atomicWrite(longtermPath, result);
  fs.writeFileSync(fpPath, fp);
  return "compiled";
}

/**
 * 从近期 session 摘要的 ## 重要事实 段编译 facts.md
 * @param {object} resolvedModel
 */
export async function compileFacts(summaryManager, outputPath, resolvedModel) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // 读取上一版 facts.md 作为继承基础（避免 30 天外的稳定属性丢失）
  const prevFacts = safeReadFile(outputPath, "").trim();

  // 取最近 30 天的新摘要，提取 ## 重要事实 段
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const sessions = summaryManager.getSummariesInRange(thirtyDaysAgo, now);

  const factParts = [];
  for (const s of sessions) {
    if (!s.summary) continue;
    const m = s.summary.match(/##\s*重要事实\s*\n([\s\S]*?)(?=\n##|$)/);
    if (m) {
      const text = m[1].trim();
      if (text && text !== "无") factParts.push(text);
    }
  }

  // 没有新摘要时：保留旧 facts 原样
  if (factParts.length === 0) {
    if (!prevFacts) atomicWrite(outputPath, "");
    return "compiled";
  }

  // 把旧 facts 和新摘要里的事实合并后去重
  const newFacts = factParts.join("\n");
  const combined = prevFacts
    ? `${prevFacts}\n${newFacts}`
    : newFacts;

  // 字数少直接写入，不调 LLM
  if (combined.length < 500) {
    atomicWrite(outputPath, combined);
    return "compiled";
  }

  const isZh = _isZh();
  const result = await _compactLLM(
    combined,
    isZh
      ? "将以下重要事实去重合并（200字以内）。只保留稳定的、跨时间有效的用户属性：身份、偏好、关系、习惯。矛盾时以最新为准。直接输出事实列表。"
      : "Deduplicate and merge the following key facts (under 120 words). Keep only stable, time-persistent user attributes: identity, preferences, relationships, habits. When facts conflict, prefer the latest. Output the fact list directly.",
    resolvedModel,
    300,
  );

  atomicWrite(outputPath, result);
  return "compiled";
}

/**
 * 将四个中间文件组装成 memory.md（同步，不调 LLM）
 * @param {string} factsPath
 * @param {string} todayPath
 * @param {string} weekPath
 * @param {string} longtermPath
 * @param {string} memoryMdPath
 */
export function assemble(factsPath, todayPath, weekPath, longtermPath, memoryMdPath) {
  const read = (p) => { try { return fs.readFileSync(p, "utf-8").trim(); } catch { return ""; } };

  const facts    = read(factsPath);
  const today    = read(todayPath);
  const week     = read(weekPath);
  const longterm = read(longtermPath);

  // 四个标题始终保留，空栏写占位符，避免格式漂移
  const isZh = _isZh();
  const empty = isZh ? "（暂无）" : "(none)";
  const section = (title, content) =>
    `## ${title}\n\n${content || empty}`;

  const md = [
    section(isZh ? "重要事实" : "Key facts", facts),
    section(isZh ? "今天" : "Today", today),
    section(isZh ? "本周早些时候" : "Earlier this week", week),
    section(isZh ? "长期情况" : "Long-term context", longterm),
  ].join("\n\n") + "\n";

  atomicWrite(memoryMdPath, md);
}

/**
 * 通用 LLM 压缩调用（内部）
 * @param {string} input
 * @param {string} systemPrompt
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @param {number} maxTokens
 */
async function _compactLLM(input, systemPrompt, resolvedModel, maxTokens) {
  const { model, api, api_key, base_url } = resolvedModel;
  return callText({
    api, model,
    apiKey: api_key,
    baseUrl: base_url,
    messages: [{ role: "user", content: input }],
    systemPrompt,
    temperature: 0.3,
    maxTokens: maxTokens,
    timeoutMs: 60_000,
  });
}

// ════════════════════════════
//  辅助
// ════════════════════════════

function computeFingerprint(keys) {
  return crypto.createHash("md5").update(keys.join("\n")).digest("hex");
}

function atomicWrite(filePath, content) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}
