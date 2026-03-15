/**
 * AgentMessenger — Agent 私聊适配器
 *
 * 处理 agent → agent 的双向对话。
 * 防无限循环：maxRounds 硬上限 + <done/> 软终止 + 冷却期。
 */

import { runAgentSession } from "./agent-executor.js";
import { appendMessage } from "../lib/channels/channel-store.js";
import { debugLog } from "../lib/debug-log.js";
import path from "path";
import fs from "fs";

const COOLDOWN_MS = 10_000;
const DEFAULT_MAX_ROUNDS = 3;
const DONE_RE = /<done\s*\/>/i;

export class AgentMessenger {
  /** @param {{ hub: import('./index.js').Hub }} opts */
  constructor({ hub }) {
    this._hub = hub;
    this._cooldowns = new Map();
  }

  /**
   * fromAgent 向 toAgent 发起对话，双方交替回复直到 <done/> 或 maxRounds 耗尽。
   *
   * @param {string} text
   * @param {string} fromAgent
   * @param {string} toAgent
   * @param {{ maxRounds?: number, signal?: AbortSignal }} [opts]
   * @returns {Promise<string|null>}  最后一轮的回复（已剥离 <done/>）
   */
  async send(text, fromAgent, toAgent, opts = {}) {
    const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;

    const cooldownKey = `${fromAgent}→${toAgent}`;
    const now = Date.now();
    for (const [key, time] of this._cooldowns) {
      if (now - time >= COOLDOWN_MS) this._cooldowns.delete(key);
    }
    const last = this._cooldowns.get(cooldownKey);
    if (last && now - last < COOLDOWN_MS) {
      debugLog()?.log("agent-messenger", `cooldown hit: ${cooldownKey}`);
      return null;
    }
    this._cooldowns.set(cooldownKey, now);

    // DM 频道文件（用于前端展示）
    const pair = [fromAgent, toAgent].sort();
    const dmName = `${pair[0]}-${pair[1]}`;
    const channelsDir = this._hub.engine.channelsDir;
    const dmFile = channelsDir ? path.join(channelsDir, `${dmName}.md`) : null;
    const canWrite = dmFile && fs.existsSync(dmFile);

    const traceId = `dm_${Date.now()}`;
    debugLog()?.log("agent-messenger", `[${traceId}] ${fromAgent} ⇄ ${toAgent} (maxRounds=${maxRounds})`);

    const systemNote = (sender) =>
      `当前消息来自内部 agent「${sender}」，这是 agent 间的内部通信，不是用户发来的。如果你认为对话可以结束了，在回复末尾加 <done/>。`;

    let sender = fromAgent;
    let receiver = toAgent;
    let currentText = text;
    let lastReply = null;

    try {
      // 写入发起方的初始消息
      if (canWrite) appendMessage(dmFile, fromAgent, text);

      for (let round = 0; round < maxRounds; round++) {
        if (opts.signal?.aborted) break;

        const reply = await runAgentSession(
          receiver,
          [{ text: `[来自 ${sender}] ${currentText}`, capture: true }],
          {
            engine: this._hub.engine,
            signal: opts.signal,
            sessionSuffix: "dms",
            keepSession: true,
            systemAppend: systemNote(sender),
          }
        );

        if (!reply) break;

        const isDone = DONE_RE.test(reply);
        lastReply = reply.replace(DONE_RE, "").trim();

        // 写入接收方的回复到频道文件
        if (canWrite && lastReply) {
          appendMessage(dmFile, receiver, lastReply);
          this._hub.eventBus.emit({ type: "channel_new_message", channelName: dmName, sender: receiver }, null);
        }

        debugLog()?.log(
          "agent-messenger",
          `[${traceId}] round ${round + 1}/${maxRounds} ${sender}→${receiver}${isDone ? " [done]" : ""}`
        );

        if (isDone) break;

        // 交换发送方和接收方，进入下一轮
        [sender, receiver] = [receiver, sender];
        currentText = lastReply;
      }
    } catch (err) {
      console.error(`[agent-messenger] ${fromAgent} ⇄ ${toAgent} failed: ${err.message}`);
      return null;
    }

    return lastReply;
  }
}
