/**
 * deep-memory.js — 深度记忆处理器
 *
 * 每日执行一次。遍历所有"脏" session（summary !== snapshot），
 * 通过 snapshot diff 发现新增内容，调 LLM 拆成元事实 + 打标签，
 * 写入 FactStore。
 *
 * 这条链路替代 v1 的 extractMemoryEvents → findNewEvents → 三区间 → score/decay。
 */

import { callText } from "../../core/llm-client.js";
import { getLocale } from "../../server/i18n.js";

const MAX_RETRIES = 3;
const MAX_CONCURRENT = 3;
const _failCounts = new Map(); // session → { count, lastUpdated }
const FAIL_COUNT_TTL_MS = 60 * 60 * 1000;

function cleanExpiredFailCounts() {
  const cutoff = Date.now() - FAIL_COUNT_TTL_MS;
  for (const [k, v] of _failCounts) {
    if (v.lastUpdated < cutoff) _failCounts.delete(k);
  }
}

/**
 * 处理所有脏 session，提取新增元事实写入 fact-store
 *
 * @param {import('./session-summary.js').SessionSummaryManager} summaryManager
 * @param {import('./fact-store.js').FactStore} factStore
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @returns {Promise<{ processed: number, factsAdded: number }>}
 */
export async function processDirtySessions(summaryManager, factStore, resolvedModel) {
  const dirty = summaryManager.getDirtySessions();
  if (dirty.length === 0) {
    return { processed: 0, factsAdded: 0 };
  }

  console.log(`\x1b[90m[deep-memory] ${dirty.length} 个脏 session 待处理\x1b[0m`);

  let totalFacts = 0;

  const processOne = async (session) => {
    try {
      const facts = await extractFactsFromDiff(
        session.summary,
        session.snapshot || "",
        resolvedModel,
      );

      if (facts.length > 0) {
        factStore.addBatch(
          facts.map((f) => ({
            fact: f.fact,
            tags: f.tags || [],
            time: f.time || null,
            session_id: session.session_id,
          })),
        );
        totalFacts += facts.length;
        console.log(
          `\x1b[90m[deep-memory] ${session.session_id.slice(0, 8)}...: ${facts.length} 条元事实\x1b[0m`,
        );
      }

      summaryManager.markProcessed(session.session_id);
      _failCounts.delete(session.session_id);
    } catch (err) {
      cleanExpiredFailCounts();
      const prev = _failCounts.get(session.session_id);
      const count = (prev?.count || 0) + 1;
      _failCounts.set(session.session_id, { count, lastUpdated: Date.now() });

      if (count >= MAX_RETRIES) {
        console.error(
          `\x1b[90m[deep-memory] ${session.session_id.slice(0, 8)}... 连续失败 ${count} 次，标记跳过: ${err.message}\x1b[0m`,
        );
        summaryManager.markProcessed(session.session_id);
        _failCounts.delete(session.session_id);
      } else {
        console.error(
          `\x1b[90m[deep-memory] 处理失败 (${session.session_id.slice(0, 8)}... ${count}/${MAX_RETRIES}): ${err.message}\x1b[0m`,
        );
      }
    }
  };

  // 分批并行处理，每批最多 MAX_CONCURRENT 个 LLM 调用
  for (let i = 0; i < dirty.length; i += MAX_CONCURRENT) {
    const batch = dirty.slice(i, i + MAX_CONCURRENT);
    await Promise.allSettled(batch.map(processOne));
  }

  console.log(
    `\x1b[90m[deep-memory] 完成：${dirty.length} 个 session，${totalFacts} 条新元事实\x1b[0m`,
  );
  return { processed: dirty.length, factsAdded: totalFacts };
}

/**
 * 从摘要 diff 中提取元事实
 *
 * @param {string} currentSummary - 当前摘要全文
 * @param {string} previousSnapshot - 上次处理时的摘要快照
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @returns {Promise<Array<{ fact: string, tags: string[], time: string }>>}
 */
async function extractFactsFromDiff(currentSummary, previousSnapshot, resolvedModel) {
  const { model: utilityModel, api, api_key, base_url } = resolvedModel;

  const hasPrevious = !!previousSnapshot;

  const isZh = getLocale().startsWith("zh");

  let userContent;
  if (hasPrevious) {
    const prevLabel = isZh ? "## 上次快照" : "## Previous Snapshot";
    const currLabel = isZh ? "## 当前摘要" : "## Current Summary";
    userContent = `${prevLabel}\n\n${previousSnapshot}\n\n${currLabel}\n\n${currentSummary}`;
  } else {
    const label = isZh ? "## 摘要内容" : "## Summary Content";
    userContent = `${label}\n\n${currentSummary}`;
  }

  const raw = await callText({
    api, model: utilityModel,
    apiKey: api_key,
    baseUrl: base_url,
    systemPrompt: buildFactExtractionPrompt(hasPrevious),
    messages: [{ role: "user", content: userContent }],
    temperature: 0.3,
    maxTokens: 4096,
    timeoutMs: 60_000,
  });

  // 兼容 markdown 代码块包裹（提取最外层 fence 之间的内容）
  const fenceMatch = raw.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  const jsonStr = (fenceMatch ? fenceMatch[1] : raw).trim();

  try {
    const facts = JSON.parse(jsonStr);
    if (!Array.isArray(facts)) return [];
    return facts.filter(
      (f) => f && typeof f.fact === "string" && f.fact.length > 0,
    );
  } catch {
    console.error(`[deep-memory] JSON 解析失败: ${jsonStr.slice(0, 200)}`);
    return [];
  }
}

/**
 * 构建元事实提取 prompt
 */
function buildFactExtractionPrompt(hasPrevious) {
  const isZh = getLocale().startsWith("zh");

  if (isZh) {
    const diffInstruction = hasPrevious
      ? `你会收到两部分输入：
1. **上次快照**：上次已处理的摘要内容
2. **当前摘要**：最新的完整摘要

请找出"当前摘要"相对于"上次快照"新增或变化的内容，将其拆分成独立的元事实。
已经在上次快照中存在的内容不要重复提取。`
      : `将以下摘要内容拆分成独立的元事实。`;

    return `你是一个记忆拆分器。${diffInstruction}

## 规则

1. 每条事实必须是原子的（一条只记一件事）。
   错误："用户讨论了记忆系统并决定用标签替代向量" → 应拆成两条
   正确：
   - "讨论了记忆系统 v2 架构设计"
   - "决定用标签替代向量做深度记忆检索"

2. 标签用于后续检索，选择有辨识度的关键词，2~5 个。
   标签选择原则：人名、项目名、技术名词、主题类别等

3. time 字段从摘要中的时间标注提取，格式 YYYY-MM-DDTHH:MM。
   如果摘要中有日期标题（如 "## 3月15日"），结合日期标题和时间标注推算完整时间。
   如果无法确定具体时间，填 null。

4. 不要提取助手的内心活动，只提取客观事实和事件。

5. 如果没有新增内容值得提取，返回空数组 []。

## 输出格式

严格 JSON 数组，不要 markdown 代码块：
[
  {"fact": "讨论了记忆系统 v2 架构设计", "tags": ["记忆系统", "v2", "架构"], "time": "2026-03-01T14:30"},
  {"fact": "决定用标签替代向量做深度记忆检索", "tags": ["标签", "向量", "检索", "决策"], "time": "2026-03-01T14:45"}
]`;
  }

  // English prompt
  const diffInstruction = hasPrevious
    ? `You will receive two inputs:
1. **Previous Snapshot**: the summary content from last processing
2. **Current Summary**: the latest full summary

Find content that is new or changed in "Current Summary" compared to "Previous Snapshot", and split it into independent atomic facts.
Do not re-extract content that already exists in the previous snapshot.`
    : `Split the following summary content into independent atomic facts.`;

  return `You are a memory splitter. ${diffInstruction}

## Rules

1. Each fact must be atomic (one fact per entry).
   Wrong: "User discussed the memory system and decided to use tags instead of vectors" → split into two
   Correct:
   - "Discussed memory system v2 architecture design"
   - "Decided to use tags instead of vectors for deep memory retrieval"

2. Tags are for later retrieval; choose distinctive keywords, 2-5 per fact.
   Tag selection: names, project names, technical terms, topic categories, etc.

3. The time field should be extracted from time annotations in the summary, format YYYY-MM-DDTHH:MM.
   If the summary has date headings (e.g. "## March 15"), combine with time annotations to infer the full timestamp.
   If the exact time cannot be determined, use null.

4. Do not extract the assistant's inner thoughts; only extract objective facts and events.

5. If there is no new content worth extracting, return an empty array [].

## Output Format

Strict JSON array, no markdown code blocks:
[
  {"fact": "Discussed memory system v2 architecture design", "tags": ["memory-system", "v2", "architecture"], "time": "2026-03-01T14:30"},
  {"fact": "Decided to use tags instead of vectors for deep memory retrieval", "tags": ["tags", "vectors", "retrieval", "decision"], "time": "2026-03-01T14:45"}
]`;
}
