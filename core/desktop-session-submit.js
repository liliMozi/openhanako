/**
 * 桌面 session 的统一提交入口。
 * 本地输入与 bridge /rc 接管都应通过这一层提交消息到桌面 session。
 */

/**
 * @param {object} engine
 * @param {object} opts
 * @param {string} opts.sessionPath
 * @param {string} opts.text
 * @param {Array<{type:'image', data:string, mimeType:string}>} [opts.images]
 * @param {string[]} [opts.imageAttachmentPaths]
 * @param {(delta: string, accumulated: string) => void} [opts.onDelta]
 * @param {object} [opts.displayMessage]
 * @param {object|null|undefined} [opts.uiContext]
 * @returns {Promise<{ text: string | null, toolMedia: string[] }>}
 */
export async function submitDesktopSessionMessage(engine, opts = {}) {
  const {
    sessionPath,
    text,
    images,
    imageAttachmentPaths,
    onDelta,
    displayMessage,
    uiContext,
  } = opts;

  if (!engine || typeof engine.ensureSessionLoaded !== "function" || typeof engine.promptSession !== "function") {
    throw new Error("desktop-session-submit: engine session API unavailable");
  }
  if (!sessionPath) throw new Error("desktop-session-submit: sessionPath is required");
  if (!text && !images?.length) throw new Error("desktop-session-submit: text or images required");
  if (typeof engine.isSessionStreaming === "function" && engine.isSessionStreaming(sessionPath)) {
    throw new Error("session_busy");
  }

  const session = await engine.ensureSessionLoaded(sessionPath);
  if (!session) throw new Error(`desktop-session-submit: failed to load session ${sessionPath}`);

  if (uiContext !== undefined) {
    engine.setUiContext?.(sessionPath, uiContext ?? null);
  }

  engine.emitEvent?.({ type: "session_status", isStreaming: true }, sessionPath);
  engine.emitEvent?.({
    type: "session_user_message",
    message: {
      text: displayMessage?.text ?? text ?? "",
      attachments: displayMessage?.attachments,
      quotedText: displayMessage?.quotedText,
      skills: displayMessage?.skills,
      deskContext: displayMessage?.deskContext ?? null,
    },
  }, sessionPath);

  let captured = "";
  const toolMedia = [];
  const unsub = session.subscribe?.((event) => {
    if (event.type === "message_update") {
      const sub = event.assistantMessageEvent;
      if (sub?.type === "text_delta") {
        const delta = sub.delta || "";
        captured += delta;
        try { onDelta?.(delta, captured); } catch {}
      }
    } else if (event.type === "tool_execution_end" && !event.isError) {
      const media = event.result?.details?.media;
      if (media?.mediaUrls?.length) toolMedia.push(...media.mediaUrls);
      const card = event.result?.details?.card;
      if (card?.description) {
        captured += (captured ? "\n\n" : "") + card.description;
      }
    }
  });

  try {
    const promptOpts = images?.length
      ? { images, ...(imageAttachmentPaths?.length ? { imageAttachmentPaths } : {}) }
      : undefined;
    await engine.promptSession(sessionPath, text || "", promptOpts);
  } finally {
    try { unsub?.(); } catch {}
    engine.emitEvent?.({ type: "session_status", isStreaming: false }, sessionPath);
  }

  return {
    text: captured.trim() || null,
    toolMedia,
  };
}
