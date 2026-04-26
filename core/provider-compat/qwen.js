/**
 * Qwen (Dashscope) provider 兼容层
 *
 * 处理 provider:
 *   - provider === "dashscope" 且 model.quirks 包含 "enable_thinking"
 *
 * 解决的协议问题：
 *   Qwen 思考模式由 enable_thinking: bool 控制（非 OpenAI 标准的 reasoning_effort）。
 *   - chat 路径：Pi SDK 自动处理（compat.thinkingFormat="qwen" + reasoningEffort）
 *     见 node_modules/@mariozechner/pi-ai/dist/providers/openai-completions.js:333-334
 *   - utility 路径：Pi SDK 不参与（callText 直 fetch），hana 必须自己强制关思考
 *     省 token（utility 是 50~500 token 短输出，思考链耗光预算）
 *
 * 删除条件：
 *   - dashscope 协议改成 reasoning_effort（不再用 enable_thinking 字段）
 *   - 或 hana 的 quirks 系统重构（known-models.json 数据格式变更）
 *
 * 接口契约：见 ./README.md
 */

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  const provider = lower(model.provider);
  if (provider !== "dashscope") return false;
  if (!Array.isArray(model.quirks)) return false;
  return model.quirks.includes("enable_thinking");
}

export function apply(payload, model, options = {}) {
  // chat 路径让 Pi SDK 自己处理（compat.thinkingFormat="qwen" 路径），不动 payload
  // utility 路径强制关思考（短输出不需要思考链 + 省 token）
  if (options?.mode === "utility") {
    return { ...payload, enable_thinking: false };
  }
  return payload;
}
