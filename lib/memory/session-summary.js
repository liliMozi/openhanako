/**
 * session-summary.js — Session 摘要管理器
 *
 * 每个 session 一个 JSON 文件（存在 memory/summaries/ 下），
 * 包含摘要文本 + 深度记忆处理的 snapshot。
 *
 * 摘要采用 append 模式：每次生成 ~300 字增量追加，
 * 超过 2000 字时触发一次压缩（→ ~600 字）。
 *
 * v2 记忆系统的核心数据层，同时服务：
 * - 普通记忆（compile.js 读摘要 → 递归压缩 → memory.md）
 * - 深度记忆（deep-memory.js 读 snapshot diff → 拆元事实）
 */

import fs from "fs";
import path from "path";
import { resolveModelApi } from "./config-loader.js";
import { scrubPII } from "../pii-guard.js";
import { callProviderText } from "../llm/provider-client.js";

const SUMMARY_CAP = 2000;        // 摘要上限（字符）
const COMPRESS_TARGET = 600;     // 压缩目标（字符）

export class SessionSummaryManager {
  /**
   * @param {string} summariesDir - summaries/ 目录的绝对路径
   */
  constructor(summariesDir) {
    this.summariesDir = summariesDir;
    fs.mkdirSync(summariesDir, { recursive: true });
    this._cache = new Map();          // sessionId → summary data
    this._cachePopulated = false;     // 是否已做过全量扫描
  }

  // ════════════════════════════
  //  读写
  // ════════════════════════════

  /**
   * 读取指定 session 的摘要
   * @param {string} sessionId
   * @returns {object|null}
   */
  getSummary(sessionId) {
    if (this._cache.has(sessionId)) return this._cache.get(sessionId);
    const fp = this._filePath(sessionId);
    try {
      const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
      this._cache.set(sessionId, data);
      return data;
    } catch {
      return null;
    }
  }

  /**
   * 写入摘要（原子写入）
   * @param {string} sessionId
   * @param {object} data
   */
  saveSummary(sessionId, data) {
    const fp = this._filePath(sessionId);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const tmp = fp + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    fs.renameSync(tmp, fp);
    this._cache.set(sessionId, data);
  }

  // ════════════════════════════
  //  摘要更新（LLM）
  // ════════════════════════════

  /**
   * 更新 session 摘要：读消息 → LLM 生成增量 → 追加到 summary
   *
   * @param {string} sessionId
   * @param {Array<{role: string, content: any, timestamp?: string}>} messages - 带时间戳的消息
   * @param {string} configPath - config.yaml 路径
   * @param {string} utilityModel - utility 模型名
   * @returns {Promise<string>} 更新后的摘要文本
   */
  async updateSummary(sessionId, messages, configPath, utilityModel) {
    const existing = this.getSummary(sessionId);
    const existingSummary = existing?.summary || "";

    // 构建对话文本（带时间戳）
    const conversationText = this._buildConversationText(messages);
    if (!conversationText) return existingSummary;

    // 调 LLM 生成增量
    const increment = await this._callSummarizer(
      conversationText,
      existingSummary,
      configPath,
      utilityModel,
    );

    if (!increment || !increment.trim()) return existingSummary;

    // 追加到 summary
    let newSummary = existingSummary
      ? existingSummary + "\n" + increment.trim()
      : increment.trim();

    // 超过上限 → 压缩
    if (newSummary.length > SUMMARY_CAP) {
      newSummary = await this.compressSummary(newSummary, configPath, utilityModel);
    }

    // PII 脱敏
    const { cleaned: scrubbedSummary, detected } = scrubPII(newSummary);
    if (detected.length > 0) {
      console.warn(`[session-summary] PII detected (${detected.join(", ")}), redacted before storage`);
      newSummary = scrubbedSummary;
    }

    // 保存
    const now = new Date().toISOString();
    this.saveSummary(sessionId, {
      session_id: sessionId,
      created_at: existing?.created_at || now,
      updated_at: now,
      summary: newSummary,
      snapshot: existing?.snapshot || "",
      snapshot_at: existing?.snapshot_at || null,
    });

    return newSummary;
  }

  /**
   * 压缩摘要（2000+ 字 → ~600 字）
   *
   * @param {string} summaryText
   * @param {string} configPath
   * @param {string} utilityModel
   * @returns {Promise<string>}
   */
  async compressSummary(summaryText, configPath, utilityModel) {
    const { api_key, base_url, api } = resolveModelApi(utilityModel, configPath);

    return callProviderText({
      api,
      model: utilityModel,
      api_key,
      base_url,
      messages: [{ role: "user", content: summaryText }],
      systemPrompt: `你是一个摘要压缩器。将以下对话摘要压缩到约 ${COMPRESS_TARGET} 字。

规则：
1. 保留关键事件、决策和结论
2. 保留所有时间标注（HH:MM 格式和日期标题）
3. 删除细枝末节但不丢失重要事实
4. 保持时间顺序
5. 直接输出压缩后的摘要文本`,
      temperature: 0.3,
      max_tokens: 2048,
      timeoutMs: 30_000,
    });
  }

  // ════════════════════════════
  //  脏 session 追踪（供深度记忆用）
  // ════════════════════════════

  /**
   * 获取所有"脏" session（summary !== snapshot）
   * @returns {Array<{ session_id, summary, snapshot, snapshot_at, updated_at }>}
   */
  getDirtySessions() {
    this._ensureCachePopulated();
    const dirty = [];
    for (const data of this._cache.values()) {
      if (!data?.summary) continue;
      if (data.summary !== (data.snapshot || "")) {
        dirty.push(data);
      }
    }
    return dirty;
  }

  /**
   * 标记 session 已被深度记忆处理（snapshot = summary）
   * @param {string} sessionId
   */
  markProcessed(sessionId) {
    const data = this.getSummary(sessionId);
    if (!data) return;

    data.snapshot = data.summary;
    data.snapshot_at = new Date().toISOString();
    this.saveSummary(sessionId, data);
  }

  // ════════════════════════════
  //  查询
  // ════════════════════════════

  /**
   * 获取所有摘要（按 updated_at 降序）
   * @returns {Array<object>}
   */
  getAllSummaries() {
    this._ensureCachePopulated();
    const summaries = [];
    for (const data of this._cache.values()) {
      if (data?.summary) summaries.push(data);
    }
    summaries.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
    return summaries;
  }

  /** 首次调用时做一次全量扫描填充缓存 */
  _ensureCachePopulated() {
    if (this._cachePopulated) return;
    const files = this._listFiles();
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf-8"));
        if (data?.session_id) this._cache.set(data.session_id, data);
      } catch {}
    }
    this._cachePopulated = true;
  }

  /**
   * 获取指定日期范围内的摘要
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {Array<object>}
   */
  getSummariesInRange(startDate, endDate) {
    const startISO = startDate.toISOString();
    const endISO = endDate.toISOString();

    return this.getAllSummaries().filter((s) => {
      const updated = s.updated_at || s.created_at || "";
      return updated >= startISO && updated <= endISO;
    });
  }

  // ════════════════════════════
  //  内部
  // ════════════════════════════

  _filePath(sessionId) {
    // session 文件名可能包含时间戳前缀（如 1234567890_uuid），
    // 直接取 uuid 部分（去掉 .jsonl 后缀和时间戳前缀）
    const cleanId = sessionId.replace(/\.jsonl$/, "");
    return path.join(this.summariesDir, `${cleanId}.json`);
  }

  _listFiles() {
    try {
      return fs.readdirSync(this.summariesDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => path.join(this.summariesDir, f));
    } catch {
      return [];
    }
  }

  /**
   * 从消息列表构建带时间戳的对话文本
   * @param {Array<{role: string, content: any, timestamp?: string}>} messages
   * @returns {string}
   */
  _buildConversationText(messages) {
    const parts = [];

    for (const msg of messages) {
      const text = this._extractText(msg);
      if (!text) continue;

      // 时间标注
      let timePrefix = "";
      if (msg.timestamp) {
        const d = new Date(msg.timestamp);
        if (!isNaN(d.getTime())) {
          const h = String(d.getHours()).padStart(2, "0");
          const m = String(d.getMinutes()).padStart(2, "0");
          timePrefix = `[${h}:${m}] `;
        }
      }

      const speaker = msg.role === "user" ? "用户" : "助手";
      parts.push(`${timePrefix}【${speaker}】${text}`);
    }

    return parts.join("\n\n");
  }

  /**
   * 调用 LLM 生成摘要增量
   */
  async _callSummarizer(conversationText, existingSummary, configPath, utilityModel) {
    const { api_key, base_url, api } = resolveModelApi(utilityModel, configPath);

    const hasPrevious = !!existingSummary;
    const systemPrompt = this._buildSummarizerPrompt(hasPrevious);

    let userContent = "";
    if (hasPrevious) {
      userContent += "## 已有摘要\n\n" + existingSummary + "\n\n## 新增对话\n\n";
    }
    userContent += conversationText;

    return callProviderText({
      api,
      model: utilityModel,
      api_key,
      base_url,
      systemPrompt,
      messages: [{ role: "user", content: userContent }],
      temperature: 0.3,
      max_tokens: 1024,
      timeoutMs: 60_000,
    });
  }

  _buildSummarizerPrompt(hasPrevious) {
    const mode = hasPrevious
      ? `你会收到两部分输入：
1. **已有摘要**：之前积累的摘要内容
2. **新增对话**：新发生的对话

请根据新增对话，生成简短的摘要增量（约 300 字以内），追加到已有摘要后面。
不要重复已有摘要中已经记录的内容。`
      : `从对话中生成简短的摘要（约 300 字以内）。`;

    return `你是一个对话摘要器。${mode}

## 规则

1. 每个事件/话题必须标注发生时间（从消息的时间戳提取，格式 HH:MM），例如"14:30 讨论了记忆架构"
2. 如果对话跨越了日期变更，在新的一天的开头加日期标题（## M月D日），例如"## 3月15日"。同一天内不需要重复标注日期
3. 只记录客观发生的事实和事件，不记录助手的内心活动或 MOOD
4. 简洁直接，抓关键信息
5. 直接输出摘要文本，不要 JSON 格式，不要代码块
6. 不要加前缀、后缀或解释性文字`;
  }

  // ════════════════════════════
  //  滚动摘要（v3，替代 append 模式）
  // ════════════════════════════

  /**
   * 滚动更新 session 摘要：每 10 轮或 session 结束时触发。
   * 若有旧摘要则将旧摘要 + 新对话合并产出新摘要（覆盖，非追加）；
   * 若无旧摘要则直接从对话生成。
   * 输出格式固定为两节：## 重要事实 + ## 事情经过。
   *
   * @param {string} sessionId
   * @param {Array<{role: string, content: any, timestamp?: string}>} messages
   * @param {string} configPath
   * @param {string} utilityModel - 建议用 utility_large
   * @returns {Promise<string>} 更新后的摘要文本
   */
  async rollingSummary(sessionId, messages, configPath, utilityModel) {
    const existing = this.getSummary(sessionId);
    const prevSummary = existing?.summary || "";

    const convText = this._buildConversationText(messages);
    if (!convText) return prevSummary;

    let newSummary = await this._callRollingLLM(convText, prevSummary, configPath, utilityModel);
    if (!newSummary?.trim()) return prevSummary;

    // PII 脱敏
    const { cleaned: scrubbedRolling, detected: rollingDetected } = scrubPII(newSummary);
    if (rollingDetected.length > 0) {
      console.warn(`[session-summary] PII detected in rolling summary (${rollingDetected.join(", ")}), redacted`);
      newSummary = scrubbedRolling;
    }

    const now = new Date().toISOString();
    this.saveSummary(sessionId, {
      session_id: sessionId,
      created_at: existing?.created_at || now,
      updated_at: now,
      summary: newSummary.trim(),
      snapshot: existing?.snapshot || "",
      snapshot_at: existing?.snapshot_at || null,
    });

    return newSummary.trim();
  }

  /**
   * 调用 LLM 生成滚动摘要（两节格式）
   * @param {string} convText - 本次对话文本
   * @param {string} prevSummary - 上一次摘要（可为空）
   * @param {string} configPath
   * @param {string} utilityModel
   * @returns {Promise<string>}
   */
  async _callRollingLLM(convText, prevSummary, configPath, utilityModel) {
    const { api_key, base_url, api } = resolveModelApi(utilityModel, configPath);

    const hasPrev = !!prevSummary;
    const systemPrompt = `你是一个对话记忆系统。请根据${hasPrev ? "已有摘要和新增对话" : "以下对话"}，生成一份结构化摘要。

## 输出格式（严格遵守，直接以 ## 开头）

## 重要事实
（150字以内）本次对话中出现的稳定信息：用户的偏好、决定、习惯、身份特征。没有则写"无"。

## 事情经过
（350字以内）按时间顺序记录发生了什么，带 HH:MM 时间标注，抓重点脉络，不记录细枝末节和助手的内心活动。

## 规则
1. 有已有摘要时：新旧内容合并，同一件事以新信息为准，不要重复
2. 时间标注从消息时间戳提取（HH:MM 格式）
3. 只记录客观事实，不记录 MOOD 或助手内心想法
4. 直接以 ## 重要事实 开头输出，不要前言后记`;

    let userContent = "";
    if (hasPrev) {
      userContent = `## 已有摘要\n\n${prevSummary}\n\n## 新增对话\n\n${convText}`;
    } else {
      userContent = convText;
    }

    return callProviderText({
      api,
      model: utilityModel,
      api_key,
      base_url,
      systemPrompt,
      messages: [{ role: "user", content: userContent }],
      temperature: 0.3,
      max_tokens: 750,
      timeoutMs: 60_000,
    });
  }

  /** 从 message 的 content 提取纯文本 */
  _extractText(msg) {
    if (!msg.content) return "";
    if (typeof msg.content === "string") return msg.content;
    return msg.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
}
