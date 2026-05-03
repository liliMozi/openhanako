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
 * @param {Array<{type:string, filename?:string, mimeType?:string, buffer:Buffer|Uint8Array|string}>} [opts.inboundFiles]
 * @param {(delta: string, accumulated: string) => void} [opts.onDelta]
 * @param {object} [opts.displayMessage]
 * @param {object|null|undefined} [opts.uiContext]
 * @returns {Promise<{ text: string | null, toolMedia: string[] }>}
 */
import path from "path";
import { extOfName, inferFileKind } from "../lib/file-metadata.js";
import { collectMediaItems } from "../lib/tools/media-details.js";
import { materializeBridgeInboundFiles } from "../lib/session-files/bridge-inbound-files.js";
import { serializeSessionFile } from "../lib/session-files/session-file-response.js";

export async function submitDesktopSessionMessage(engine, opts = {}) {
  const {
    sessionPath,
    text,
    images,
    imageAttachmentPaths,
    inboundFiles,
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

  let promptImageAttachmentPaths = imageAttachmentPaths || [];
  let displayAttachments = displayMessage?.attachments;
  let promptText = text || "";

  if (displayAttachments?.length) {
    const registeredDisplay = registerDisplayAttachments({
      hanakoHome: engine.hanakoHome,
      sessionPath,
      attachments: displayAttachments,
      registerSessionFile: engine.registerSessionFile?.bind(engine),
    });
    displayAttachments = registeredDisplay.attachments;
    promptImageAttachmentPaths = uniquePaths([
      ...promptImageAttachmentPaths,
      ...registeredDisplay.imageAttachmentPaths,
    ]);
  }

  if (inboundFiles?.length) {
    const materialized = await materializeBridgeInboundFiles({
      hanakoHome: engine.hanakoHome,
      sessionPath,
      files: inboundFiles,
      registerSessionFile: engine.registerSessionFile?.bind(engine),
    });
    promptImageAttachmentPaths = [
      ...promptImageAttachmentPaths,
      ...materialized.imageAttachmentPaths,
    ];
    promptImageAttachmentPaths = uniquePaths(promptImageAttachmentPaths);
    displayAttachments = [
      ...(displayAttachments || []),
      ...materialized.displayAttachments,
    ];
  }

  engine.emitEvent?.({ type: "session_status", isStreaming: true }, sessionPath);
  engine.emitEvent?.({
    type: "session_user_message",
    message: {
      text: displayMessage?.text ?? text ?? "",
      attachments: displayAttachments,
      quotedText: displayMessage?.quotedText,
      skills: displayMessage?.skills,
      deskContext: displayMessage?.deskContext ?? null,
      source: displayMessage?.source || "desktop",
      bridgeSessionKey: displayMessage?.bridgeSessionKey || null,
    },
  }, sessionPath);

  promptText = addAttachedImageMarkers(promptText, promptImageAttachmentPaths);

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
      toolMedia.push(...collectMediaItems(event.result?.details?.media));
      const card = event.result?.details?.card;
      if (card?.description) {
        captured += (captured ? "\n\n" : "") + card.description;
      }
    }
  });

  try {
    const promptOpts = images?.length
      ? { images, ...(promptImageAttachmentPaths.length ? { imageAttachmentPaths: promptImageAttachmentPaths } : {}) }
      : undefined;
    await engine.promptSession(sessionPath, promptText, promptOpts);
  } finally {
    try { unsub?.(); } catch {}
    engine.emitEvent?.({ type: "session_status", isStreaming: false }, sessionPath);
  }

  return {
    text: captured.trim() || null,
    toolMedia,
  };
}

function registerDisplayAttachments({ hanakoHome, sessionPath, attachments, registerSessionFile }) {
  const nextAttachments = [];
  const imageAttachmentPaths = [];

  for (const attachment of attachments || []) {
    let next = { ...attachment };
    let sessionFile = null;

    if (!next.fileId && next.path && path.isAbsolute(next.path) && typeof registerSessionFile === "function") {
      sessionFile = serializeSessionFile(registerSessionFile({
        sessionPath,
        filePath: next.path,
        label: next.name || path.basename(next.path),
        origin: "user_attachment",
        storageKind: displayAttachmentStorageKind(hanakoHome, next.path),
      }));
      if (sessionFile) {
        next = {
          ...next,
          fileId: sessionFile.fileId || sessionFile.id,
          name: next.name || sessionFile.displayName || sessionFile.filename || path.basename(next.path),
          mimeType: next.mimeType || sessionFile.mime,
          isDir: next.isDir || !!sessionFile.isDirectory,
          status: sessionFile.status,
          missingAt: sessionFile.missingAt,
        };
      }
    }

    if (next.path && path.isAbsolute(next.path) && next.base64Data) {
      const { base64Data, ...withoutInlineBytes } = next;
      next = withoutInlineBytes;
    }

    const kind = sessionFile?.kind || inferFileKind({
      mime: next.mimeType,
      ext: extOfName(next.name || next.path),
      isDirectory: !!next.isDir,
    });
    if (!next.isDir && next.path && kind === "image") {
      imageAttachmentPaths.push(next.path);
    }
    nextAttachments.push(next);
  }

  return { attachments: nextAttachments, imageAttachmentPaths: uniquePaths(imageAttachmentPaths) };
}

function displayAttachmentStorageKind(hanakoHome, filePath) {
  if (!hanakoHome) return "external";
  const root = path.resolve(hanakoHome, "session-files");
  const target = path.resolve(filePath);
  const rel = path.relative(root, target);
  if (rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel))) {
    return "managed_cache";
  }
  return "external";
}

function addAttachedImageMarkers(text, imageAttachmentPaths) {
  let promptText = text || "";
  const missing = uniquePaths(imageAttachmentPaths)
    .filter((filePath) => filePath && !promptText.includes(`[attached_image: ${filePath}]`));
  if (!missing.length) return promptText;
  const markerText = missing.map((filePath) => `[attached_image: ${filePath}]`).join("\n");
  return promptText ? `${markerText}\n${promptText}` : markerText;
}

function uniquePaths(paths) {
  return Array.from(new Set((paths || []).filter(Boolean)));
}
