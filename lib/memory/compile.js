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
import { resolveModelApi } from "./config-loader.js";
import { getLogicalDay } from "../time-utils.js";
import { callProviderText } from "../llm/provider-client.js";

const EMPTY_MEMORY = "（暂无记忆）\n";

// ════════════════════════════
//  v3 四块独立编译 + assemble
// ════════════════════════════

/**
 * 编译今天的 session 摘要 → today.md
 * @param {import('./session-summary.js').SessionSummaryManager} summaryManager
 * @param {string} outputPath
 * @param {string} configPath
 * @param {string} model
 * @returns {Promise<"compiled"|"skipped">}
 */
export async function compileToday(summaryManager, outputPath, configPath, model) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const { rangeStart } = getLogicalDay();
  const sessions = summaryManager.getSummariesInRange(rangeStart, new Date());

  const fpKeys = sessions.length === 0 ? ["empty"] : sessions.map((s) => `${s.session_id}:${s.updated_at}`);
  const fp = computeFingerprint(fpKeys);
  const fpPath = outputPath + ".fingerprint";
  try {
    if (fs.readFileSync(fpPath, "utf-8").trim() === fp && fs.existsSync(outputPath)) return "skipped";
  } catch {}

  if (sessions.length === 0) {
    atomicWrite(outputPath, "");
    fs.writeFileSync(fpPath, fp);
    return "compiled";
  }

  const input = sessions.map((s) => s.summary).join("\n\n---\n\n");
  const result = await _compactLLM(
    input,
    "将以下今天的对话摘要整合成一段概要（600字以内）。重点突出，抓关键事件和决策，保留时间标注（HH:MM）。直接输出概要文本。",
    configPath,
    model,
    900,
  );

  atomicWrite(outputPath, result);
  fs.writeFileSync(fpPath, fp);
  return "compiled";
}

/**
 * 编译过去 7 天滑动窗口的摘要 → week.md
 */
export async function compileWeek(summaryManager, outputPath, configPath, model) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);

  const sessions = summaryManager.getSummariesInRange(sevenDaysAgo, now);

  const fpKeys = sessions.length === 0 ? ["empty"] : sessions.map((s) => `${s.session_id}:${s.updated_at}`);
  const fp = computeFingerprint(fpKeys);
  const fpPath = outputPath + ".fingerprint";
  try {
    if (fs.readFileSync(fpPath, "utf-8").trim() === fp && fs.existsSync(outputPath)) return "skipped";
  } catch {}

  if (sessions.length === 0) {
    atomicWrite(outputPath, "");
    fs.writeFileSync(fpPath, fp);
    return "compiled";
  }

  const input = sessions.map((s) => s.summary).join("\n\n---\n\n");
  const result = await _compactLLM(
    input,
    "将以下过去7天的对话摘要整合成一段概要（600字以内）。提炼主要主题和重要事件，保留时间标注。直接输出概要文本。",
    configPath,
    model,
    900,
  );

  atomicWrite(outputPath, result);
  fs.writeFileSync(fpPath, fp);
  return "compiled";
}

/**
 * 将 week.md fold 进 longterm.md（每日一次）
 */
export async function compileLongterm(weekMdPath, longtermPath, configPath, model) {
  fs.mkdirSync(path.dirname(longtermPath), { recursive: true });

  let weekContent = "";
  try { weekContent = fs.readFileSync(weekMdPath, "utf-8").trim(); } catch {}

  if (!weekContent) return "skipped";

  // fingerprint：week.md 内容没变就跳过，避免每天把同一批内容反复折叠
  const fp = computeFingerprint([weekContent]);
  const fpPath = longtermPath + ".fingerprint";
  try {
    if (fs.readFileSync(fpPath, "utf-8").trim() === fp && fs.existsSync(longtermPath)) return "skipped";
  } catch {}

  let prevLongterm = "";
  try { prevLongterm = fs.readFileSync(longtermPath, "utf-8").trim(); } catch {}

  const input = prevLongterm
    ? `## 上一份长期情况\n\n${prevLongterm}\n\n## 本周新增\n\n${weekContent}`
    : weekContent;

  const result = await _compactLLM(
    input,
    "将以下内容整合成长期背景记录（400字以内）。只保留持续性的、跨时间有意义的背景信息，去掉单次性事件细节。直接输出记录文本。",
    configPath,
    model,
    600,
  );

  atomicWrite(longtermPath, result);
  fs.writeFileSync(fpPath, fp);
  return "compiled";
}

/**
 * 从近期 session 摘要的 ## 重要事实 段编译 facts.md
 */
export async function compileFacts(summaryManager, outputPath, configPath, model) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // 读取上一版 facts.md 作为继承基础（避免 30 天外的稳定属性丢失）
  let prevFacts = "";
  try { prevFacts = fs.readFileSync(outputPath, "utf-8").trim(); } catch {}

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

  const result = await _compactLLM(
    combined,
    "将以下重要事实去重合并（300字以内）。只保留稳定的、跨时间有效的用户属性：身份、偏好、关系、习惯。矛盾时以最新为准。直接输出事实列表。",
    configPath,
    model,
    450,
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

  // 四个标题始终保留，空栏写"（暂无）"，避免格式漂移
  const section = (title, content) =>
    `## ${title}\n\n${content || "（暂无）"}`;

  const md = [
    section("重要事实", facts),
    section("今天", today),
    section("最近一周", week),
    section("长期情况", longterm),
  ].join("\n\n") + "\n";

  atomicWrite(memoryMdPath, md);
}

/**
 * 通用 LLM 压缩调用（内部）
 */
async function _compactLLM(input, systemPrompt, configPath, model, maxTokens) {
  const { api_key, base_url, api } = resolveModelApi(model, configPath);
  return callProviderText({
    api,
    model,
    api_key,
    base_url,
    messages: [{ role: "user", content: input }],
    systemPrompt,
    temperature: 0.3,
    max_tokens: maxTokens,
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
