function stripTrailingSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

function isLocalBaseUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(String(url || ""));
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!content) return "";
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content?.text === "string") return content.text;
  return String(content);
}

function normalizeMessages(messages = [], systemPrompt = "") {
  const combined = [];

  if (systemPrompt) {
    combined.push({ role: "system", content: systemPrompt });
  }

  for (const message of messages) {
    if (!message?.role) continue;
    const text = contentToText(message.content);
    if (!text) continue;
    combined.push({ role: message.role, content: text });
  }

  return combined;
}

function buildAnthropicPayload(messages) {
  let system = "";
  const anthropicMessages = [];

  for (const message of messages) {
    if (message.role === "system") {
      system = system ? `${system}\n\n${message.content}` : message.content;
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    anthropicMessages.push({
      role: message.role,
      content: message.content,
    });
  }

  if (anthropicMessages.length === 0) {
    anthropicMessages.push({ role: "user", content: "" });
  }

  return { system, messages: anthropicMessages };
}

function extractOpenAIText(data) {
  const content = data?.choices?.[0]?.message?.content;
  const text = contentToText(content).trim();
  return text || "";
}

function extractResponsesText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];
  for (const item of data?.output || []) {
    if (item?.type !== "message" || item?.role !== "assistant") continue;
    for (const chunk of item.content || []) {
      if (typeof chunk?.text === "string" && chunk.text.trim()) {
        parts.push(chunk.text.trim());
      } else if (typeof chunk?.content === "string" && chunk.content.trim()) {
        parts.push(chunk.content.trim());
      }
    }
  }
  return parts.join("\n").trim();
}

function extractAnthropicText(data) {
  return (data?.content || [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

export function buildProviderAuthHeaders(api, apiKey, opts = {}) {
  const allowMissingApiKey = opts.allowMissingApiKey === true;
  if (!api) {
    throw new Error("缺少 API 协议配置");
  }
  if (!apiKey && !allowMissingApiKey) {
    throw new Error("缺少 API Key");
  }

  if (api === "anthropic-messages") {
    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (apiKey) headers["x-api-key"] = apiKey;
    return headers;
  }

  if (api === "openai-completions" || api === "openai-codex-responses" || api === "openai-responses") {
    const headers = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    return headers;
  }

  throw new Error(`不支持的 API 协议: ${api}`);
}

export async function callProviderText({
  api,
  api_key,
  base_url,
  model,
  systemPrompt = "",
  messages = [],
  temperature = 0.3,
  max_tokens = 512,
  timeoutMs = 60_000,
  signal,
}) {
  if (!model) throw new Error("缺少模型 ID");
  if (!base_url) throw new Error("缺少 Base URL");

  const combinedMessages = normalizeMessages(messages, systemPrompt);
  const baseUrl = stripTrailingSlash(base_url);
  const headers = buildProviderAuthHeaders(api, api_key, {
    allowMissingApiKey: isLocalBaseUrl(baseUrl),
  });
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let endpoint = "";
  let body = null;
  let extractText = () => "";

  if (api === "openai-completions") {
    endpoint = `${baseUrl}/chat/completions`;
    body = {
      model,
      messages: combinedMessages,
      temperature,
      max_tokens,
      enable_thinking: false,
    };
    extractText = extractOpenAIText;
  } else if (api === "anthropic-messages") {
    const anthropic = buildAnthropicPayload(combinedMessages);
    endpoint = `${baseUrl}/messages`;
    body = {
      model,
      system: anthropic.system || undefined,
      messages: anthropic.messages,
      temperature,
      max_tokens,
    };
    extractText = extractAnthropicText;
  } else if (api === "openai-codex-responses" || api === "openai-responses") {
    const responseInput = combinedMessages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));
    endpoint = `${baseUrl}/responses`;
    body = {
      model,
      instructions: systemPrompt || undefined,
      input: responseInput,
      temperature,
      max_output_tokens: max_tokens,
    };
    extractText = extractResponsesText;
  } else {
    throw new Error(`不支持的 API 协议: ${api}`);
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: requestSignal,
  });

  const rawText = await res.text();
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    throw new Error(`LLM 返回了无法解析的 JSON (${res.status})`);
  }

  if (!res.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      rawText ||
      `HTTP ${res.status}`;
    throw new Error(message);
  }

  const text = extractText(data);
  if (!text) {
    throw new Error("LLM 返回了空内容");
  }
  return text;
}
