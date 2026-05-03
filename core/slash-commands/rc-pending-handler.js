/**
 * rc-pending-handler.js — bridge-manager 侧的 pending-selection 消息处理
 *
 * 当 bridge sessionKey 处于 rc-select pending 状态时（/rc 后等待编号输入），
 * bridge-manager 在 _handleMessage 里拦截非斜杠消息转给这里处理。
 *
 * 斜杠命令必须始终优先（用户纪律），因此本 handler 只在消息**不是**
 * 斜杠命令时由 bridge-manager 调用。
 *
 * 未来扩展：pending.type === 'yes-no' / 'free-text' 等新交互类型会在这里分支处理。
 * 现在只支持 'rc-select'（数字 1..N）。
 */
import fs from "fs/promises";
import { summarizeSessionForRc } from "./rc-summary.js";

const STREAM_WAIT_TIMEOUT_MS = 30_000;
const STREAM_POLL_INTERVAL_MS = 200;

/**
 * @param {object} ctx
 * @param {object} ctx.engine
 * @param {string} ctx.agentId
 * @param {string} ctx.sessionKey
 * @param {string} ctx.text  用户原始输入
 * @param {boolean} [ctx.isGroup]
 * @param {(text: string) => Promise<void>} ctx.reply  发回 bridge 平台的回调
 * @returns {Promise<{handled: boolean}>}
 */
export async function handleRcPendingInput(ctx) {
  const { engine, agentId, sessionKey, text, reply, isGroup = false, chatId = null, messageThreadId = null } = ctx;
  const rcState = engine.rcState;
  if (!rcState) return { handled: false };

  const pending = rcState.getPending(sessionKey);
  if (!pending) return { handled: false };
  if (pending.type !== "rc-select") {
    // 未来类型先放通，这版只实现 rc-select
    return { handled: false };
  }
  if (isGroup) {
    rcState.clearPending(sessionKey);
    await _safeReply(reply, "群聊里不能使用 /rc 接管，请到私聊里重新执行 /rc");
    return { handled: true };
  }

  // 解析数字
  const num = _parseSelectionNumber(text);
  if (num === null) {
    await _safeReply(reply, `请输入数字编号（1-${pending.options.length}）`);
    // 不清 pending，让用户继续尝试直到超时或 /exitrc
    return { handled: true };
  }
  if (num < 1 || num > pending.options.length) {
    await _safeReply(reply, `编号超出范围（有效 1-${pending.options.length}）`);
    return { handled: true };
  }

  // 合法选择：清 pending，进入接管流程
  rcState.clearPending(sessionKey);

  const selected = pending.options[num - 1];
  const sessionPath = selected.path;
  const title = selected.title || "未命名会话";

  const initialCheck = await _validateAttachTarget(engine, rcState, sessionKey, sessionPath, agentId);
  if (initialCheck) {
    await _safeReply(reply, initialCheck);
    return { handled: true };
  }

  await _safeReply(reply, "正在接管桌面 session...");

  // streaming 中等结束再接管（用户决策 ⑤：等结束再接管）
  const idle = await _waitForSessionIdle(engine, sessionPath);
  if (!idle) {
    await _safeReply(reply, "目标会话持续在回复中（>30s），接管取消。稍后重试 /rc");
    return { handled: true };
  }

  const preSummaryCheck = await _validateAttachTarget(engine, rcState, sessionKey, sessionPath, agentId);
  if (preSummaryCheck) {
    await _safeReply(reply, preSummaryCheck);
    return { handled: true };
  }

  // 三级 summary fallback（失败则兜底文案）
  const agent = engine.getAgent?.(agentId);
  let summary = null;
  try {
    summary = await summarizeSessionForRc(engine, agent, sessionPath);
  } catch (err) {
    console.warn(`[rc] summarize threw: ${err.message}`);
  }

  const preAttachCheck = await _validateAttachTarget(engine, rcState, sessionKey, sessionPath, agentId);
  if (preAttachCheck) {
    await _safeReply(reply, preAttachCheck);
    return { handled: true };
  }

  // 建立接管态
  try {
    rcState.attach(sessionKey, sessionPath, {
      platform: _platformFromSessionKey(sessionKey),
      chatId,
      agentId,
      messageThreadId,
    });
  } catch (err) {
    await _safeReply(reply, _normalizeAttachFailure(err));
    return { handled: true };
  }

  // Phase 2-D：广播 attached 事件，桌面 UI 据此渲染横幅
  // sessionPath 是第二参数——前端按 sessionPath 路由到对应 session 的 UI 槽
  try {
    engine.emitEvent?.({
      type: "bridge_rc_attached",
      sessionKey,
      sessionPath,
      title,
      platform: _platformFromSessionKey(sessionKey),
    }, sessionPath);
  } catch (err) {
    console.warn(`[rc] emit attached event failed: ${err.message}`);
  }

  const body = summary
    ? `已接管桌面会话《${title}》\n${summary}`
    : `已接管对话 ${title}`;
  await _safeReply(reply, body);

  return { handled: true };
}

/**
 * sessionKey 格式 `{platform}_{chatType}_{chatId}@{agentId}`，
 * 第一段 `_` 前就是 platform。UI 横幅可以显示"正被 TG 远程接管"。
 */
function _platformFromSessionKey(sessionKey) {
  const m = /^([a-z]+)_/i.exec(sessionKey || "");
  return m ? m[1] : "bridge";
}

function _parseSelectionNumber(text) {
  const trimmed = (text || "").trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return null;
  return n;
}

async function _validateAttachTarget(engine, rcState, sessionKey, sessionPath, agentId) {
  const exists = await _desktopSessionExists(engine, sessionPath, agentId);
  if (!exists) {
    return "目标会话已不存在，接管取消。请重新 /rc";
  }
  const holderSessionKey = rcState.getAttachedBridgeSessionKey?.(sessionPath);
  if (holderSessionKey && holderSessionKey !== sessionKey) {
    return "目标会话已被另一个 bridge 会话接管，接管取消。请重新 /rc";
  }
  return null;
}

async function _desktopSessionExists(engine, sessionPath, agentId) {
  let hadAuthoritativeCheck = false;
  if (typeof engine?.listSessions === "function") {
    hadAuthoritativeCheck = true;
    const sessions = await engine.listSessions();
    return sessions.some(session => session?.path === sessionPath && (!agentId || session?.agentId === agentId));
  }
  if (typeof engine?.getSessionByPath === "function") {
    hadAuthoritativeCheck = true;
    if (engine.getSessionByPath(sessionPath)) return true;
  }
  if (typeof engine?.ensureSessionLoaded === "function") {
    hadAuthoritativeCheck = true;
    try {
      if (await engine.ensureSessionLoaded(sessionPath)) return true;
    } catch {
      return false;
    }
  }
  try {
    await fs.access(sessionPath);
    return true;
  } catch {
    return !hadAuthoritativeCheck;
  }
}

function _normalizeAttachFailure(err) {
  const msg = err?.message || "";
  if (msg.includes("bridge 会话接管")) return msg;
  return "目标会话已被另一个 bridge 会话接管，接管取消。请重新 /rc";
}

async function _waitForSessionIdle(engine, sessionPath) {
  const deadline = Date.now() + STREAM_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const streaming = engine.isSessionStreaming?.(sessionPath) ?? false;
    if (!streaming) return true;
    await new Promise(r => setTimeout(r, STREAM_POLL_INTERVAL_MS));
  }
  // deadline 后最后再查一次
  return !(engine.isSessionStreaming?.(sessionPath) ?? false);
}

async function _safeReply(reply, text) {
  try { await reply(text); } catch (err) {
    console.warn(`[rc] reply failed: ${err.message}`);
  }
}
