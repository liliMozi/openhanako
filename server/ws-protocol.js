/**
 * WebSocket 消息协议定义
 *
 * Client → Server:
 *   { type: "prompt", text: "..." }
 *   { type: "abort" }
 *   { type: "resume_stream", sessionPath: "...", streamId: "...", sinceSeq: 128 }  (按事件序号续传)
 *
 * Server → Client:
 *   { type: "text_delta", delta: "..." }
 *   { type: "mood_start" }
 *   { type: "mood_text", delta: "..." }
 *   { type: "mood_end" }
 *   { type: "thinking_start" }
 *   { type: "thinking_delta", delta: "..." }
 *   { type: "thinking_end" }
 *   { type: "tool_start", name: "..." }
 *   { type: "tool_end", name: "...", success: bool, details?: object }
 *   { type: "turn_end" }
 *   { type: "error", message: "..." }
 *   { type: "status", isStreaming: bool }
 *   { type: "session_title", title: "...", path: "..." }
 *   { type: "jian_update", content: "..." }
 *   { type: "devlog", text: "...", level: "info"|"heartbeat"|"error" }
 *   { type: "activity_update", activity: { id, type, startedAt, finishedAt, summary, sessionFile, status } }
 *   { type: "content_block", block: { type: "file"|"artifact"|"screenshot"|"skill"|"plugin_card"|"cron_confirm"|"settings_confirm", ... } }  (工具结果统一内容块，含 stage_files/create_artifact/browser screenshot/install_skill/plugin card/cron 确认/settings 确认)
 *   { type: "confirmation_resolved", confirmId: "...", action: "confirmed"|"rejected", value?: any }  (用户操作确认卡片后广播，前端更新卡片状态)
 *   { type: "browser_status", running: bool, url: "...", thumbnail?: "..." }  (浏览器状态变更，用于前端浮动卡片)
 *   { type: "bridge_status", platform: "telegram"|"feishu", status: "connected"|"disconnected"|"error", error?: "..." }  (外部平台连接状态变更)
 *   { type: "stream_resume", sessionPath: "...", streamId: "...", sinceSeq: number, nextSeq: number, reset: bool, truncated: bool, isStreaming: bool, events: [{ seq, event, ts }] }  (新协议)
 */

/** 安全地发送 JSON 消息到 WebSocket */
export function wsSend(ws, msg) {
  if (ws.readyState === 1) { // OPEN
    ws.send(JSON.stringify(msg));
  }
}

/** 安全地解析 WebSocket 消息（兼容 Buffer / string / ArrayBuffer） */
export function wsParse(data) {
  try {
    const str = typeof data === "string" ? data : (data?.toString?.() ?? String(data));
    return JSON.parse(str);
  } catch {
    return null;
  }
}
