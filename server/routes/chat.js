/**
 * WebSocket 聊天路由
 *
 * 桥接 Pi SDK streaming 事件 → WebSocket 消息
 * 支持多 session 并发：后台 session 静默运行，只转发当前活跃 session 的事件
 */
import { MoodParser, XingParser, ThinkTagParser } from "../../core/events.js";
import { wsSend, wsParse } from "../ws-protocol.js";
import { debugLog } from "../../lib/debug-log.js";
import { t } from "../i18n.js";
import { BrowserManager } from "../../lib/browser/browser-manager.js";
import {
  createSessionStreamState,
  beginSessionStream,
  finishSessionStream,
  appendSessionStreamEvent,
  resumeSessionStream,
} from "../session-stream-store.js";

/** tool_start 事件只广播这些 arg 字段，避免传输完整文件内容（同步维护：chat-render-shim.ts extractToolDetail） */
const TOOL_ARG_SUMMARY_KEYS = ["file_path", "path", "command", "pattern", "url", "query"];

/**
 * 从 Pi SDK 的 content 块中提取纯文本
 */
function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(b => b.type === "text" && b.text)
    .map(b => b.text)
    .join("");
}

export default async function chatRoute(app, { engine, hub }) {
  let activeWsClients = 0;
  let disconnectAbortTimer = null;
  const DISCONNECT_ABORT_GRACE_MS = 15_000;
  const sessionState = new Map(); // sessionPath -> shared stream state

  function cancelDisconnectAbort() {
    if (disconnectAbortTimer) {
      clearTimeout(disconnectAbortTimer);
      disconnectAbortTimer = null;
    }
  }

  function scheduleDisconnectAbort() {
    if (disconnectAbortTimer || activeWsClients > 0) return;
    disconnectAbortTimer = setTimeout(() => {
      disconnectAbortTimer = null;
      if (activeWsClients > 0) return;

      // 中断所有正在 streaming 的 owner session（焦点 + 后台）
      debugLog()?.log("ws", `no clients for ${DISCONNECT_ABORT_GRACE_MS}ms, aborting all streaming`);
      engine.abortAllStreaming().catch(() => {});
    }, DISCONNECT_ABORT_GRACE_MS);
  }

  const MAX_SESSION_STATES = 20;

  function getState(sessionPath) {
    if (!sessionPath) return null;
    if (!sessionState.has(sessionPath)) {
      // 超过上限时，淘汰非流式的旧 entry
      if (sessionState.size >= MAX_SESSION_STATES) {
        for (const [sp, ss] of sessionState) {
          if (!ss.isStreaming && sp !== sessionPath) {
            sessionState.delete(sp);
            if (sessionState.size < MAX_SESSION_STATES) break;
          }
        }
      }
      sessionState.set(sessionPath, {
        thinkTagParser: new ThinkTagParser(),
        moodParser: new MoodParser(),
        xingParser: new XingParser(),
        isThinking: false,
        titleRequested: false,
        titlePreview: "",
        ...createSessionStreamState(),
      });
    }
    return sessionState.get(sessionPath);
  }

  const clients = new Set();

  function broadcast(msg) {
    for (const client of clients) {
      wsSend(client, msg);
    }
  }

  // 浏览器缩略图 30s 定时刷新（browser 活跃时）
  let _browserThumbTimer = null;
  function startBrowserThumbPoll() {
    if (_browserThumbTimer) return;
    _browserThumbTimer = setInterval(async () => {
      const browser = BrowserManager.instance();
      if (!browser.isRunning) { stopBrowserThumbPoll(); return; }
      const thumbnail = await browser.thumbnail();
      if (thumbnail) {
        broadcast({ type: "browser_status", running: true, url: browser.currentUrl, thumbnail });
      }
    }, 30_000);
  }
  function stopBrowserThumbPoll() {
    if (_browserThumbTimer) { clearInterval(_browserThumbTimer); _browserThumbTimer = null; }
  }

  function emitStreamEvent(sessionPath, ss, event) {
    const entry = appendSessionStreamEvent(ss, event);
    // Phase 4: 始终广播所有事件，前端按 sessionPath 路由到对应 panel
    broadcast({
      ...event,
      sessionPath,
      streamId: entry.streamId,
      seq: entry.seq,
    });
    return entry;
  }

  function maybeGenerateFirstTurnTitle(sessionPath, ss) {
    if (!sessionPath || !ss || ss.titleRequested) return;

    const session = engine.getSessionByPath(sessionPath);
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const userMsgCount = messages.filter(m => m.role === "user").length;
    if (userMsgCount !== 1) return;

    const assistantMsg = messages.find(m => m.role === "assistant");
    const assistantText = (ss.titlePreview || extractText(assistantMsg?.content)).trim();
    if (!assistantText) return;

    ss.titleRequested = true;
    generateSessionTitle(engine, broadcast, {
      sessionPath,
      assistantTextHint: assistantText,
    }).then((ok) => {
      if (!ok) ss.titleRequested = false;
    }).catch((err) => {
      ss.titleRequested = false;
      console.error("[chat] generateSessionTitle error:", err.message);
    });
  }

  // 单订阅：事件只写入一次，再按需广播到所有连接中的客户端。
  hub.subscribe((event, sessionPath) => {
    const isActive = sessionPath === engine.currentSessionPath;
    const ss = sessionPath ? getState(sessionPath) : null;

    if (event.type === "message_update") {
      if (!ss) return;
      const sub = event.assistantMessageEvent?.type;

      if (sub === "text_delta") {
        if (ss.isThinking) {
          ss.isThinking = false;
          emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
        }

        const delta = event.assistantMessageEvent.delta;
        // ThinkTagParser（最外层）→ MoodParser → XingParser
        ss.thinkTagParser.feed(delta, (tEvt) => {
          switch (tEvt.type) {
            case "think_start":
              emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
              break;
            case "think_text":
              emitStreamEvent(sessionPath, ss, { type: "thinking_delta", delta: tEvt.data });
              break;
            case "think_end":
              emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
              break;
            case "text":
              // 非 think 内容继续走 MoodParser → XingParser 链
              ss.moodParser.feed(tEvt.data, (evt) => {
                switch (evt.type) {
                  case "text":
                    ss.xingParser.feed(evt.data, (xEvt) => {
                      switch (xEvt.type) {
                        case "text":
                          ss.titlePreview += xEvt.data || "";
                          emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: xEvt.data });
                          maybeGenerateFirstTurnTitle(sessionPath, ss);
                          break;
                        case "xing_start":
                          emitStreamEvent(sessionPath, ss, { type: "xing_start", title: xEvt.title });
                          break;
                        case "xing_text":
                          emitStreamEvent(sessionPath, ss, { type: "xing_text", delta: xEvt.data });
                          break;
                        case "xing_end":
                          emitStreamEvent(sessionPath, ss, { type: "xing_end" });
                          break;
                      }
                    });
                    break;
                  case "mood_start":
                    emitStreamEvent(sessionPath, ss, { type: "mood_start" });
                    break;
                  case "mood_text":
                    emitStreamEvent(sessionPath, ss, { type: "mood_text", delta: evt.data });
                    break;
                  case "mood_end":
                    emitStreamEvent(sessionPath, ss, { type: "mood_end" });
                    break;
                }
              });
              break;
          }
        });
      } else if (sub === "thinking_delta") {
        if (!ss.isThinking) {
          ss.isThinking = true;
          emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
        }
        emitStreamEvent(sessionPath, ss, {
          type: "thinking_delta",
          delta: event.assistantMessageEvent.delta || "",
        });
      } else if (sub === "toolcall_start") {
        // 不在这里关闭 thinking 状态
      } else if (sub === "error") {
        if (isActive) broadcast({ type: "error", message: event.assistantMessageEvent.error || "Unknown error" });
      }
    } else if (event.type === "tool_execution_start") {
      if (!ss) return;
      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }
      // 只保留前端 extractToolDetail 需要的字段，避免广播完整文件内容
      const rawArgs = event.args;
      let args;
      if (rawArgs && typeof rawArgs === "object") {
        args = {};
        for (const k of TOOL_ARG_SUMMARY_KEYS) { if (rawArgs[k] !== undefined) args[k] = rawArgs[k]; }
      }
      emitStreamEvent(sessionPath, ss, { type: "tool_start", name: event.toolName || "", args });
    } else if (event.type === "tool_execution_end") {
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, {
        type: "tool_end",
        name: event.toolName || "",
        success: !event.isError,
        details: event.result?.details,
      });

      if (event.toolName === "present_files") {
        const details = event.result?.details || {};
        const files = details.files || [];
        if (files.length === 0 && details.filePath) {
          files.push({ filePath: details.filePath, label: details.label, ext: details.ext || "" });
        }
        for (const f of files) {
          emitStreamEvent(sessionPath, ss, {
            type: "file_output",
            filePath: f.filePath,
            label: f.label,
            ext: f.ext || "",
          });
        }
      }

      if (event.toolName === "create_artifact") {
        const d = event.result?.details || {};
        emitStreamEvent(sessionPath, ss, {
          type: "artifact",
          artifactId: d.artifactId,
          artifactType: d.type,
          title: d.title,
          content: d.content,
          language: d.language,
        });
      }

      if (event.toolName === "browser") {
        const d = event.result?.details || {};
        if (d.action === "screenshot" && event.result?.content) {
          const imgBlock = event.result.content.find(c => c.type === "image");
          if (imgBlock?.source?.data) {
            emitStreamEvent(sessionPath, ss, {
              type: "browser_screenshot",
              base64: imgBlock.source.data,
              mimeType: imgBlock.source.media_type || "image/jpeg",
            });
          }
        }

        const statusMsg = {
          type: "browser_status",
          running: d.running ?? false,
          url: d.url || null,
        };
        if (d.thumbnail) statusMsg.thumbnail = d.thumbnail;
        emitStreamEvent(sessionPath, ss, statusMsg);
        if (statusMsg.running) startBrowserThumbPoll();
        else stopBrowserThumbPoll();
      }

      if (event.toolName === "cron") {
        const d = event.result?.details || {};
        if (d.action === "pending_add" && d.jobData) {
          emitStreamEvent(sessionPath, ss, { type: "cron_confirmation", jobData: d.jobData });
        }
      }

      if (isActive && ["write", "edit", "bash"].includes(event.toolName)) {
        broadcast({ type: "desk_changed" });
      }
    } else if (event.type === "jian_update") {
      broadcast({ type: "jian_update", content: event.content });
    } else if (event.type === "devlog") {
      broadcast({ type: "devlog", text: event.text, level: event.level });
    } else if (event.type === "browser_bg_status") {
      broadcast({ type: "browser_bg_status", running: event.running, url: event.url });
    } else if (event.type === "activity_update") {
      broadcast({ type: "activity_update", activity: event.activity });
    } else if (event.type === "notification") {
      broadcast({ type: "notification", title: event.title, body: event.body });
    } else if (event.type === "channel_new_message") {
      broadcast({ type: "channel_new_message", channelName: event.channelName, sender: event.sender });
    } else if (event.type === "dm_new_message") {
      broadcast({ type: "dm_new_message", from: event.from, to: event.to });
    } else if (event.type === "turn_end") {
      if (!ss) return;
      // 关闭结构化 thinking（如有）——必须在 flush 之前，否则前端收不到 thinking_end
      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }
      // flush 顺序：ThinkTag → Mood → Xing（和 feed 顺序一致）
      // flush 内部的 mood → xing 管线（thinkTag flush 和 mood flush 共用）
      const feedMoodPipeline = (text) => {
        ss.moodParser.feed(text, (evt) => {
          if (evt.type === "text") {
            ss.xingParser.feed(evt.data, (xEvt) => {
              switch (xEvt.type) {
                case "text":
                  emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: xEvt.data });
                  break;
                case "xing_start":
                  emitStreamEvent(sessionPath, ss, { type: "xing_start", title: xEvt.title });
                  break;
                case "xing_text":
                  emitStreamEvent(sessionPath, ss, { type: "xing_text", delta: xEvt.data });
                  break;
                case "xing_end":
                  emitStreamEvent(sessionPath, ss, { type: "xing_end" });
                  break;
              }
            });
          } else if (evt.type === "mood_start") {
            emitStreamEvent(sessionPath, ss, { type: "mood_start" });
          } else if (evt.type === "mood_text") {
            emitStreamEvent(sessionPath, ss, { type: "mood_text", delta: evt.data });
          } else if (evt.type === "mood_end") {
            emitStreamEvent(sessionPath, ss, { type: "mood_end" });
          }
        });
      };
      ss.thinkTagParser.flush((tEvt) => {
        if (tEvt.type === "think_text") {
          emitStreamEvent(sessionPath, ss, { type: "thinking_delta", delta: tEvt.data });
        } else if (tEvt.type === "think_end") {
          emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
        } else if (tEvt.type === "text") {
          feedMoodPipeline(tEvt.data);
        }
      });
      ss.moodParser.flush((evt) => {
        if (evt.type === "text") {
          ss.xingParser.feed(evt.data, (xEvt) => {
            switch (xEvt.type) {
              case "text":
                emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: xEvt.data });
                break;
              case "xing_start":
                emitStreamEvent(sessionPath, ss, { type: "xing_start", title: xEvt.title });
                break;
              case "xing_text":
                emitStreamEvent(sessionPath, ss, { type: "xing_text", delta: xEvt.data });
                break;
              case "xing_end":
                emitStreamEvent(sessionPath, ss, { type: "xing_end" });
                break;
            }
          });
        } else if (evt.type === "mood_text") {
          emitStreamEvent(sessionPath, ss, { type: "mood_text", delta: evt.data });
        }
      });
      ss.xingParser.flush((xEvt) => {
        if (xEvt.type === "text") {
          emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: xEvt.data });
        } else if (xEvt.type === "xing_text") {
          emitStreamEvent(sessionPath, ss, { type: "xing_text", delta: xEvt.data });
        }
      });

      emitStreamEvent(sessionPath, ss, { type: "turn_end" });
      finishSessionStream(ss);
      ss.thinkTagParser.reset();
      ss.moodParser.reset();
      ss.xingParser.reset();

      if (isActive) {
        debugLog()?.log("ws", "assistant reply done");
        maybeGenerateFirstTurnTitle(sessionPath, ss);
      }
    } else if (event.type === "auto_compaction_start") {
      if (isActive) broadcast({ type: "compaction_start" });
    } else if (event.type === "auto_compaction_end") {
      if (isActive) {
        const usage = engine.session?.getContextUsage?.();
        broadcast({
          type: "compaction_end",
          tokens: usage?.tokens ?? null,
          contextWindow: usage?.contextWindow ?? null,
          percent: usage?.percent ?? null,
        });
      }
    }
  });

  app.get("/ws", { websocket: true }, (socket, req) => {
    const ws = socket;
    let closed = false;
    activeWsClients++;
    clients.add(ws);
    cancelDisconnectAbort();
    debugLog()?.log("ws", "client connected");

    // 注意：token 校验由 server/index.js 的 onRequest hook 统一处理，
    // Fastify @fastify/websocket 的 WS 升级请求也会经过该 hook

    // 处理客户端消息
    ws.on("message", async (raw) => {
      const msg = wsParse(raw);
      if (!msg) return;

      if (msg.type === "abort") {
        const abortPath = msg.sessionPath || engine.currentSessionPath;
        if (engine.isSessionStreaming(abortPath)) {
          try { await hub.abort(abortPath); } catch {}
        }
        return;
      }

      if (msg.type === "steer" && msg.text) {
        debugLog()?.log("ws", `steer (${msg.text.length} chars)`);
        const steerPath = msg.sessionPath || engine.currentSessionPath;
        if (engine.steerSession(steerPath, msg.text)) {
          wsSend(ws, { type: "steered" });
          return;
        }
        // agent 已停止，降级为正常 prompt（下面的 prompt 分支会处理）
        debugLog()?.log("ws", `steer missed, falling back to prompt`);
        msg.type = "prompt";
      }

      // session 切回时，前端请求补发离屏期间的流式内容
      if (msg.type === "resume_stream") {
        const currentPath = msg.sessionPath || engine.currentSessionPath;
        const ss = sessionState.get(currentPath);
        if (ss) {
          const resumed = resumeSessionStream(ss, {
            streamId: msg.streamId,
            sinceSeq: msg.sinceSeq,
          });
          wsSend(ws, {
            type: "stream_resume",
            sessionPath: currentPath,
            streamId: resumed.streamId,
            sinceSeq: resumed.sinceSeq,
            nextSeq: resumed.nextSeq,
            reset: resumed.reset,
            truncated: resumed.truncated,
            isStreaming: resumed.isStreaming,
            events: resumed.events,
          });
        } else {
          wsSend(ws, {
            type: "stream_resume",
            sessionPath: currentPath,
            streamId: null,
            sinceSeq: Number.isFinite(msg.sinceSeq) ? Math.max(0, msg.sinceSeq) : 0,
            nextSeq: 1,
            reset: false,
            truncated: false,
            isStreaming: false,
            events: [],
          });
        }
        return;
      }

      if (msg.type === "context_usage") {
        const usage = engine.session?.getContextUsage?.();
        wsSend(ws, {
          type: "context_usage",
          tokens: usage?.tokens ?? null,
          contextWindow: usage?.contextWindow ?? null,
          percent: usage?.percent ?? null,
        });
        return;
      }

      if (msg.type === "compact") {
        const session = engine.session;
        if (!session) {
          wsSend(ws, { type: "error", message: "没有活跃的 session" });
          return;
        }
        if (session.isCompacting) {
          wsSend(ws, { type: "error", message: "正在压缩中" });
          return;
        }
        // streaming 时不允许手动压缩，避免与 prompt 并发
        if (engine.isStreaming) {
          wsSend(ws, { type: "error", message: "请等待回复结束后再压缩" });
          return;
        }
        broadcast({ type: "compaction_start" });
        try {
          await session.compact();
          const usage = session.getContextUsage?.();
          broadcast({
            type: "compaction_end",
            tokens: usage?.tokens ?? null,
            contextWindow: usage?.contextWindow ?? null,
            percent: usage?.percent ?? null,
          });
        } catch (err) {
          // Already compacted / Nothing to compact 不算错误
          const msg = err.message || "";
          if (msg.includes("Already compacted") || msg.includes("Nothing to compact")) {
            broadcast({ type: "compaction_end" });
          } else {
            broadcast({ type: "compaction_end" });
            wsSend(ws, { type: "error", message: `压缩失败: ${msg}` });
          }
        }
        return;
      }

      if (msg.type === "prompt" && (msg.text || msg.images?.length)) {
        // 图片校验：最多 10 张，单张 ≤ 20MB，仅允许常见图片 MIME
        if (msg.images?.length) {
          const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
          const MAX_IMAGES = 10;
          const MAX_BYTES = 20 * 1024 * 1024; // 20MB base64 ≈ 15MB 原始
          if (msg.images.length > MAX_IMAGES) {
            wsSend(ws, { type: "error", message: `最多支持 ${MAX_IMAGES} 张图片` });
            return;
          }
          for (const img of msg.images) {
            if (!img?.mimeType || !ALLOWED_MIME.has(img.mimeType)) {
              wsSend(ws, { type: "error", message: `不支持的图片格式: ${img?.mimeType || "unknown"}` });
              return;
            }
            if (img.data && img.data.length > MAX_BYTES) {
              wsSend(ws, { type: "error", message: "单张图片不得超过 20MB" });
              return;
            }
          }
        }
        // 只发图片没文字时补一个占位文本，防止空 text 导致某些 API 异常
        let promptText = msg.text || "";
        if (!promptText.trim() && msg.images?.length) {
          promptText = "（看图）";
        }
        debugLog()?.log("ws", `user message (${promptText.length} chars, ${msg.images?.length || 0} images)`);
        // Phase 2: 客户端可指定 sessionPath，否则用焦点 session
        const promptSessionPath = msg.sessionPath || engine.currentSessionPath;
        if (engine.isSessionStreaming(promptSessionPath)) {
          wsSend(ws, { type: "error", message: t("error.stillStreaming", { name: engine.agentName }) });
          return;
        }
        const ss = getState(promptSessionPath);
        try {
          ss.thinkTagParser.reset();
          ss.moodParser.reset();
          ss.xingParser.reset();
          ss.titleRequested = false;
          ss.titlePreview = "";
          beginSessionStream(ss);
          broadcast({ type: "status", isStreaming: true, sessionPath: promptSessionPath });
          await hub.send(promptText, msg.images ? { images: msg.images, sessionPath: promptSessionPath } : { sessionPath: promptSessionPath });
          broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
        } catch (err) {
          if (!err.message?.includes("aborted")) {
            wsSend(ws, { type: "error", message: err.message });
          }
          broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
        }
      }
    });

    ws.on("error", (err) => {
      console.error("[ws] error:", err.message);
      debugLog()?.error("ws", err.message);
    });

    // 清理：WS 断开时只中断前台 session（后台 channel triage / cron 不受影响）
    ws.on("close", () => {
      if (closed) return;
      closed = true;
      activeWsClients = Math.max(0, activeWsClients - 1);
      clients.delete(ws);
      debugLog()?.log("ws", "client disconnected");
      scheduleDisconnectAbort();
      // 无活跃客户端时，清理非流式 session 状态（防止 Map 无限增长）
      if (activeWsClients === 0) {
        for (const [sp, ss] of sessionState) {
          if (!ss.isStreaming) sessionState.delete(sp);
        }
      }
    });
  });
}

/**
 * 后台生成 session 标题：从第一轮对话提取摘要
 * 只在 session 还没有自定义标题时执行
 */
async function generateSessionTitle(engine, notify, opts = {}) {
  try {
    const sessionPath = opts.sessionPath || engine.currentSessionPath;
    if (!sessionPath) return false;

    // 检查是否已有标题（避免重复生成）
    const sessions = await engine.listSessions();
    const current = sessions.find(s => s.path === sessionPath);
    if (current?.title) return true;

    const session = engine.getSessionByPath(sessionPath);
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const userMsg = messages.find(m => m.role === "user");
    const assistantMsg = messages.find(m => m.role === "assistant");
    if (!userMsg && !opts.userTextHint) return false;

    const userText = (opts.userTextHint || extractText(userMsg?.content)).trim();
    const assistantText = (opts.assistantTextHint || extractText(assistantMsg?.content)).trim();
    if (!userText || !assistantText) return false;

    const TITLE_TIMEOUT = 15_000; // 15 秒超时
    let title = await Promise.race([
      engine.summarizeTitle(userText, assistantText),
      new Promise(resolve => setTimeout(() => resolve(null), TITLE_TIMEOUT)),
    ]);

    // API 失败时，用用户第一条消息截取作为 fallback 标题
    if (!title) {
      const fallback = userText.replace(/\n/g, " ").trim().slice(0, 30);
      if (!fallback) return;
      title = fallback;
      console.log("[chat] session 标题 API 失败，使用 fallback:", title);
    }

    // 保存标题
    await engine.saveSessionTitle(sessionPath, title);

    // 通知前端更新
    notify({ type: "session_title", title, path: sessionPath });
    return true;
  } catch (err) {
    console.error("[chat] 生成 session 标题失败:", err.message);
    return false;
  }
}
