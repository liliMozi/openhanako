/**
 * DeepSeek provider 兼容层
 *
 * 处理 provider:
 *   - provider === "deepseek"
 *   - baseUrl 包含 "api.deepseek.com"
 *
 * 解决的协议问题：
 *   1. 思考模式开启字段：thinking: {type: "enabled" | "disabled"}
 *   2. reasoning_effort 归一化：low/medium → high；xhigh → max
 *   3. max_tokens 抬升：思考模式下需 ≥ 32768
 *   4. utility mode 主动关思考（短输出场景思考链既无意义又耗光预算）
 *   5. 工具调用轮次必须回传真实 reasoning_content（issue #468 根因；缺失时 fail closed，不伪造空占位）
 *      官方文档：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 *
 * 删除条件：
 *   - DeepSeek 不再要求回传 reasoning_content（协议变更）
 *   - 或 pi-ai 直接以 reasoning_content 字段处理 DeepSeek 思考链
 *     （不再借用 thinkingSignature 字段当协议字段名路标）
 *   - 或 hana 不再支持 DeepSeek
 *
 * 接口契约：见 ./README.md
 */

const DEEPSEEK_HIGH_THINKING_BUDGET = 32768;
const DEEPSEEK_HIGH_SAFE_MAX_TOKENS = 65536;
const DEEPSEEK_MAX_SAFE_MAX_TOKENS = 131072;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const MISSING_TOOL_REASONING_ERROR =
  "DeepSeek thinking mode reasoning_content is missing for tool_calls history. "
  + "Compact this session or start a new session before continuing with DeepSeek thinking mode.";

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function positiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function hasToolCalls(message) {
  return Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  const provider = lower(model.provider);
  // base_url: 兼容上游 SDK 偶发的 snake_case 别名（pi-ai SDK / 用户自定 model 配置）
  const baseUrl = lower(model.baseUrl || model.base_url);
  return provider === "deepseek" || baseUrl.includes("api.deepseek.com");
}

function isKnownThinkingModelId(id) {
  const normalized = lower(id);
  return normalized === "deepseek-reasoner" || normalized.startsWith("deepseek-v4-");
}

function isThinkingOff(level) {
  return level === "off" || level === "none" || level === "disabled";
}

function reasoningEffortForLevel(level) {
  if (!level) return null;
  if (level === "xhigh" || level === "max") return "max";
  if (level === "minimal" || level === "low" || level === "medium" || level === "high") return "high";
  return null;
}

function applyRequestedReasoningLevel(payload, level) {
  const effort = reasoningEffortForLevel(level);
  if (effort) payload.reasoning_effort = effort;
}

function enableThinking(payload) {
  payload.thinking = { type: "enabled" };
}

function shouldUseThinking(payload, model, reasoningLevel) {
  if (payload.thinking?.type === "disabled") return false;
  if (isThinkingOff(reasoningLevel)) return false;
  const knownThinkingModel = model?.reasoning === true || isKnownThinkingModelId(model?.id || payload.model);
  return Boolean(
    payload.reasoning_effort
    || (knownThinkingModel && reasoningEffortForLevel(reasoningLevel))
    || knownThinkingModel
  );
}

function normalizeReasoningEffort(payload) {
  if (!hasOwn(payload, "reasoning_effort")) return;
  if (payload.reasoning_effort === "low" || payload.reasoning_effort === "medium") {
    payload.reasoning_effort = "high";
  } else if (payload.reasoning_effort === "xhigh") {
    payload.reasoning_effort = "max";
  }
}

function stripReasoningContent(messages) {
  let changed = false;
  const next = messages.map((message) => {
    if (!message || typeof message !== "object" || !hasOwn(message, "reasoning_content")) {
      return message;
    }
    changed = true;
    const copy = { ...message };
    delete copy.reasoning_content;
    return copy;
  });
  return changed ? next : messages;
}

function disableThinking(payload) {
  delete payload.reasoning_effort;
  payload.thinking = { type: "disabled" };
  if (Array.isArray(payload.messages)) {
    const stripped = stripReasoningContent(payload.messages);
    if (stripped !== payload.messages) payload.messages = stripped;
  }
}

function normalizeMaxTokenField(payload) {
  if (!hasOwn(payload, "max_completion_tokens")) return;
  if (!hasOwn(payload, "max_tokens")) {
    payload.max_tokens = payload.max_completion_tokens;
  }
  delete payload.max_completion_tokens;
}

function ensureThinkingTokenBudget(payload, model) {
  const current = positiveInteger(payload.max_tokens);
  if (current && current > DEEPSEEK_HIGH_THINKING_BUDGET) return;

  const modelLimit = positiveInteger(model?.maxTokens || model?.maxOutput);
  const desired = payload.reasoning_effort === "max"
    ? DEEPSEEK_MAX_SAFE_MAX_TOKENS
    : DEEPSEEK_HIGH_SAFE_MAX_TOKENS;
  const target = modelLimit ? Math.min(modelLimit, desired) : desired;

  if (target <= DEEPSEEK_HIGH_THINKING_BUDGET) {
    disableThinking(payload);
    return;
  }

  payload.max_tokens = target;
}

/**
 * 从 message.content 恢复 DeepSeek 思考链原文。
 *
 * 处理两种历史路径：
 *   1. 同模型保留路径：pi-ai 流式累积时把 delta.reasoning_content 累加到
 *      content[i] = { type: "thinking", thinking: "...", thinkingSignature: "reasoning_content" }
 *   2. 跨模型降级路径：pi-ai transform-messages 跨模型保护把 thinking block
 *      降级为 { type: "text", text: <思考原文> }，convertMessages 随后会把
 *      text block 拼成出站 assistant.content 字符串。若调用方在 convertMessages
 *      之前测试本函数，也可能看到 content 数组。
 *      由于 DeepSeek 流式累积 reasoning_content 一定先于 content 到达
 *      （参见 openai-completions.js:115-172 的 currentBlock 切换逻辑），
 *      原始 content 首位是 thinking → 降级后的首段 text / 字符串即思考原文。
 *      若未来 SDK 改变累积顺序，此假设需重新评估（README 升级 SDK 检查清单已点名本函数）。
 *
 * 找不到原文时返回空字符串（调用方决定是否 fail closed）。
 *
 * 注：导出仅供单元测试使用，运行时只在本文件内部被 ensureReasoningContentForToolCalls 调用。
 *
 * @param {object|null|undefined} message
 * @returns {string}
 */
export function extractReasoningFromContent(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) return "";

  // 路径 1：同模型，content 里有 thinking block
  for (const block of content) {
    if (block && block.type === "thinking" && typeof block.thinking === "string") {
      return block.thinking;
    }
  }

  // 路径 2：跨模型降级，第一个 text block 即原文
  const first = content[0];
  if (first && first.type === "text" && typeof first.text === "string") {
    return first.text;
  }

  return "";
}

/**
 * 恢复/校验：保证所有「带 tool_calls 的 assistant message」都有真实 reasoning_content 字段。
 *
 * 三档策略：
 *   档 1：已有非空 reasoning_content → 不动
 *   档 2：无 reasoning_content 但能从 message.content 恢复原文 → 注入恢复值
 *   档 3：原文也找不到 → 抛错，阻止远端 400（禁止空字符串伪造）
 *
 * 这条恢复/校验覆盖以下漏字段路径：
 *   - 跨 V4 子版本切换：pi-ai transform-messages 把 thinking block 降级 text
 *   - 空思考被过滤：openai-completions:492 nonEmptyThinkingBlocks filter 掉空内容
 *   - compaction / 跨 session 续接边界：原文确实丢失（此时本函数 fail closed）
 *
 * 不可变契约：未修改时返回原数组；修改时返回新数组（仅修改的 message 浅拷贝）。
 *
 * @param {Array|any} messages — payload.messages
 * @returns {Array|any} — 原数组或新数组
 */
export function ensureReasoningContentForToolCalls(messages) {
  if (!Array.isArray(messages)) return messages;

  let changed = false;
  const next = messages.map((message) => {
    if (!message || typeof message !== "object" || message.role !== "assistant") {
      return message;
    }
    if (!hasToolCalls(message)) {
      return message;
    }
    if (isNonEmptyString(message.reasoning_content)) {
      return message;
    }
    const recovered = extractReasoningFromContent(message);
    if (!isNonEmptyString(recovered)) {
      throw new Error(MISSING_TOOL_REASONING_ERROR);
    }
    changed = true;
    return { ...message, reasoning_content: recovered };
  });

  return changed ? next : messages;
}

export function apply(payload, model, options = {}) {
  if (!Array.isArray(payload.messages)) return payload;
  const mode = options.mode || "chat";
  const reasoningLevel = options.reasoningLevel;

  let next = payload;
  const editable = () => {
    if (next === payload) next = { ...payload };
    return next;
  };

  if (hasOwn(payload, "max_completion_tokens")) {
    normalizeMaxTokenField(editable());
  }

  if (isThinkingOff(reasoningLevel) || next.thinking?.type === "disabled") {
    disableThinking(editable());
    return next;
  }

  if (!shouldUseThinking(next, model, reasoningLevel)) return next;

  if (mode === "utility") {
    disableThinking(editable());
    return next;
  }

  const p = editable();
  applyRequestedReasoningLevel(p, reasoningLevel);
  normalizeReasoningEffort(p);
  enableThinking(p);
  ensureThinkingTokenBudget(p, model);
  if (p.thinking?.type === "disabled") {
    return next;
  }

  // chat mode 思考开启：严格校验 tool_calls 历史的 reasoning_content（覆盖 transform-messages 降级）。
  // 守卫与上方 off-path / utility-path 风格对称；此处 p 已是副本，去掉守卫直接赋值也对，但保持三处同形便于阅读。
  const ensured = ensureReasoningContentForToolCalls(p.messages);
  if (ensured !== p.messages) {
    p.messages = ensured;
  }

  return next;
}
