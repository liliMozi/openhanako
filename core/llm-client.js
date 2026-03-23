import { AppError } from '../shared/errors.js';
import { errorBus } from '../shared/error-bus.js';

/**
 * core/llm-client.js — 统一的非流式 LLM 调用入口
 *
 * 直接 HTTP POST（非流式），不走 Pi SDK 的 completeSimple（强制流式）。
 * Pi SDK completeSimple 对 DashScope 等供应商有 20-40x 延迟膨胀（stream SSE 首 token 慢），
 * utility 短文本生成（50-200 token）不需要流式，直接 POST 最快。
 *
 * URL 构造规则与 Pi SDK 内部一致，确保和 Chat 链路（走 Pi SDK stream）访问同一个端点：
 *   - openai-completions:  baseUrl + "/chat/completions"
 *   - anthropic-messages:  baseUrl + "/v1/messages"
 *   - openai-responses:    baseUrl + "/responses"
 */

/**
 * 统一非流式文本生成。
 *
 * @param {object} opts
 * @param {string} opts.api            API 协议
 * @param {string} opts.apiKey         API key（本地模型可省略）
 * @param {string} opts.baseUrl        Provider base URL
 * @param {string} opts.model          模型 ID
 * @param {string} [opts.provider]     Provider ID
 * @param {string} [opts.systemPrompt] System prompt
 * @param {Array}  [opts.messages]     消息数组 [{ role, content }]
 * @param {number} [opts.temperature]  温度 (default 0.3)
 * @param {number} [opts.maxTokens]    最大输出 token (default 512)
 * @param {number} [opts.timeoutMs]    超时毫秒 (default 60000)
 * @param {AbortSignal} [opts.signal]  外部取消信号
 * @returns {Promise<string>} 生成的文本
 */
export async function callText({
  api,
  apiKey,
  baseUrl,
  model,
  provider = "custom",
  systemPrompt = "",
  messages = [],
  temperature = 0.3,
  maxTokens = 512,
  timeoutMs = 60_000,
  signal,
}) {
  // ── 1. 消息归一化：提取 system 消息合并到 systemPrompt ──
  let mergedSystem = systemPrompt || "";
  const normalizedMessages = [];
  for (const m of messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(c => c.text || "").join("")
          : "";
      if (text) mergedSystem += (mergedSystem ? "\n" : "") + text;
    } else {
      normalizedMessages.push({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) });
    }
  }

  // ── 2. 超时信号 ──
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  // ── 3. 按协议构造请求 ──
  const base = (baseUrl || "").replace(/\/+$/, "");
  let endpoint, headers, body;

  if (api === "anthropic-messages") {
    // Anthropic Messages API：baseUrl + /v1/messages（和 Pi SDK Anthropic provider 一致）
    endpoint = `${base}/v1/messages`;
    headers = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
    if (apiKey) headers["x-api-key"] = apiKey;

    // Anthropic 格式：system 和 messages 分离
    const anthropicMessages = normalizedMessages.filter(m => m.role === "user" || m.role === "assistant");
    if (anthropicMessages.length === 0) anthropicMessages.push({ role: "user", content: "" });
    body = {
      model, temperature, max_tokens: maxTokens,
      ...(mergedSystem && { system: mergedSystem }),
      messages: anthropicMessages,
    };
  } else if (api === "openai-responses" || api === "openai-codex-responses") {
    // OpenAI Responses API
    endpoint = `${base}/responses`;
    headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    body = {
      model, temperature, max_output_tokens: maxTokens,
      ...(mergedSystem && { instructions: mergedSystem }),
      input: normalizedMessages,
    };
  } else {
    // OpenAI Completions API（默认）：baseUrl + /chat/completions
    endpoint = `${base}/chat/completions`;
    headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const allMessages = [];
    if (mergedSystem) allMessages.push({ role: "system", content: mergedSystem });
    allMessages.push(...normalizedMessages);
    body = {
      model, temperature, max_tokens: maxTokens,
      messages: allMessages,
      enable_thinking: false,
    };
  }

  // ── 4. 发送请求 ──
  const SLOW_THRESHOLD_MS = 15_000;
  const slowTimer = setTimeout(() => {
    errorBus.report(new AppError('LLM_SLOW_RESPONSE', {
      context: { model, provider, elapsed: SLOW_THRESHOLD_MS },
    }));
  }, SLOW_THRESHOLD_MS);

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: combinedSignal,
  }).catch(err => {
    clearTimeout(slowTimer);
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      throw new AppError('LLM_TIMEOUT', { context: { model }, cause: err });
    }
    throw err;
  });

  // ── 5. 解析响应 ──
  const rawText = await res.text();
  clearTimeout(slowTimer);
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    throw new Error(`LLM returned invalid JSON (status=${res.status})`);
  }

  if (!res.ok) {
    const message = data?.error?.message || data?.message || rawText || `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      throw new AppError('LLM_AUTH_FAILED', { context: { model, status: res.status } });
    }
    if (res.status === 429) {
      throw new AppError('LLM_RATE_LIMITED', { context: { model } });
    }
    throw new AppError('UNKNOWN', { message, context: { model, status: res.status } });
  }

  // ── 6. 提取文本 ──
  let text = "";
  if (api === "anthropic-messages") {
    text = (data?.content || [])
      .filter(c => c?.type === "text" && typeof c.text === "string")
      .map(c => c.text).join("\n").trim();
  } else if (api === "openai-responses" || api === "openai-codex-responses") {
    if (typeof data?.output_text === "string") {
      text = data.output_text.trim();
    } else {
      text = (data?.output || [])
        .filter(item => item?.type === "message" && item?.role === "assistant")
        .flatMap(item => (item.content || []).filter(c => typeof c?.text === "string").map(c => c.text.trim()))
        .join("\n").trim();
    }
  } else {
    text = (typeof data?.choices?.[0]?.message?.content === "string")
      ? data.choices[0].message.content.trim()
      : "";
  }

  if (!text) {
    if (combinedSignal.aborted) {
      throw new AppError('LLM_TIMEOUT', { context: { model } });
    }
    throw new AppError('LLM_EMPTY_RESPONSE', { context: { model } });
  }

  return text;
}
