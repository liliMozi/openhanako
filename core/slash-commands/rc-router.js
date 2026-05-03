import { collectMediaItems } from "../../lib/tools/media-details.js";

/**
 * rc-router.js — /rc 接管态的消息路由层
 *
 * 当 bridge sessionKey 有 active attachment 时，bridge-manager 不再把消息
 * 丢进 hub.send（那会写 bridge 的 jsonl），而是转给本模块：
 *   1. ensureSessionLoaded 把目标桌面 session 加进 engine 的 session cache
 *   2. 订阅该 session 的流式事件，累积 assistant text delta
 *   3. 通过 onDelta 回调把增量送 bridge adapter（TG 端流式体验）
 *   4. session.prompt(text) 跑完后返回最终文本
 *
 * 桌面 UI 侧的流式显示是"免费"的——session 的 message_update 事件会通过
 * engine 的 event bus 广播给前端，前端按 sessionPath 订阅，自然看到消息流式生成。
 * 本模块不需要额外为桌面 UI 做什么，只负责把同一份事件镜像到 bridge 侧。
 *
 * 订阅生命周期：严格绑定一次 prompt（try/finally unsub），
 * attachment 本身不持有长连接订阅，避免内存泄漏。
 */

/**
 * 在桌面 session 上执行一次 prompt，同时把 assistant text delta 送 bridge adapter。
 *
 * @param {object} engine
 * @param {string} sessionPath  桌面 session 的 jsonl 绝对路径
 * @param {string} text         用户消息（已经过 timeTag 前缀等处理，是最终要进 session 的文本）
 * @param {object} [opts]
 * @param {(delta: string, accumulated: string) => void} [opts.onDelta]  流式 delta 回调
 * @param {Array<{type:'image', data:string, mimeType:string}>} [opts.images]
 * @returns {Promise<{ text: string | null, toolMedia: string[] }>}  最终 assistant 文本（trim 后）+ 工具产出的 media URL 列表
 */
export async function promptAttachedDesktopSession(engine, sessionPath, text, opts = {}) {
  if (!engine || typeof engine.ensureSessionLoaded !== "function") {
    throw new Error("rc-router: engine.ensureSessionLoaded unavailable");
  }

  const session = await engine.ensureSessionLoaded(sessionPath);
  if (!session) throw new Error(`rc-router: failed to load session ${sessionPath}`);

  // 订阅 text_delta + tool_execution_end（媒体产出）
  // 沿用 executeExternalMessage 的模式（bridge-session-manager.js lines 246-266）
  let captured = "";
  const toolMedia = [];
  const unsub = session.subscribe((event) => {
    if (event.type === "message_update") {
      const sub = event.assistantMessageEvent;
      if (sub?.type === "text_delta") {
        const delta = sub.delta || "";
        captured += delta;
        try { opts.onDelta?.(delta, captured); } catch {}
      }
    } else if (event.type === "tool_execution_end" && !event.isError) {
      toolMedia.push(...collectMediaItems(event.result?.details?.media));
      // 工具产生 card.description 时也并入正文，与 bridge-session-manager 一致
      const card = event.result?.details?.card;
      if (card?.description) {
        captured += (captured ? "\n\n" : "") + card.description;
      }
    }
  });

  try {
    // 非 image 模型剥图（防 provider 400；promptSession 内部也会剥，双保险无害）
    const inputMods = session.model?.input;
    let promptOpts;
    if (opts.images?.length && Array.isArray(inputMods) && !inputMods.includes("image")) {
      promptOpts = undefined;
    } else if (opts.images?.length) {
      promptOpts = { images: opts.images };
    }
    await session.prompt(text, promptOpts);
  } finally {
    unsub?.();
  }

  return {
    text: captured.trim() || null,
    toolMedia,
  };
}
