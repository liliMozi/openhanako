/**
 * DmRouter — 私信路由
 *
 * 当 agent 通过 dm 工具发送私信后，DmRouter 负责：
 * 1. 用频道模式的 prompt 让接收方读取聊天记录并回复
 * 2. 回复写回双方的 dm/ 文件
 * 3. 有轮次限制，防止无限对话
 *
 * 与 ChannelRouter 的区别：
 * - DM 是 1v1，不需要 triage（私信就是给你的）
 * - DM 用 personality + memory 构建 prompt，不用完整 system prompt
 * - DM session 临时创建、用完销毁，不进记忆系统
 */

import fs from "fs";
import path from "path";
import {
  appendMessage,
  getRecentMessages,
  formatMessagesForLLM,
} from "../lib/channels/channel-store.js";
import { runAgentSession } from "./agent-executor.js";
import { debugLog } from "../lib/debug-log.js";
import { getLocale } from "../server/i18n.js";

const MAX_ROUNDS = 3;
const COOLDOWN_MS = 10_000;

export class DmRouter {
  constructor({ hub }) {
    this._hub = hub;
    this._cooldowns = new Map();
    this._processing = new Map(); // key → startTimestamp
  }

  get _engine() { return this._hub.engine; }

  /**
   * 处理新私信：让接收方回复
   * @param {string} fromId - 发送方 agent ID
   * @param {string} toId - 接收方 agent ID
   */
  async handleNewDm(fromId, toId) {
    const key = `${fromId}→${toId}`;

    // 清理卡住的 entry（超过 5 分钟视为异常）
    const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;
    const now = Date.now();
    for (const [k, ts] of this._processing) {
      if (now - ts > PROCESSING_TIMEOUT_MS) this._processing.delete(k);
    }

    // 防重入
    if (this._processing.has(key)) return;

    // 冷却期
    for (const [k, t] of this._cooldowns) {
      if (now - t >= COOLDOWN_MS) this._cooldowns.delete(k);
    }
    if (this._cooldowns.has(key) && now - this._cooldowns.get(key) < COOLDOWN_MS) {
      debugLog()?.log("dm-router", `cooldown hit: ${key}`);
      return;
    }

    this._processing.set(key, Date.now());
    this._cooldowns.set(key, now);

    try {
      await this._processReply(fromId, toId);
    } catch (err) {
      console.error(`[dm-router] ${key} failed: ${err.message}`);
    } finally {
      this._processing.delete(key);
    }
  }

  /**
   * 让 toId 读取聊天记录并回复，可能触发多轮
   */
  async _processReply(fromId, toId) {
    const engine = this._engine;
    const agentsDir = engine.agentsDir;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // 读取 toId 视角的聊天记录
      const dmFile = path.join(agentsDir, toId, "dm", `${fromId}.md`);
      if (!fs.existsSync(dmFile)) break;

      const recentMsgs = getRecentMessages(dmFile, 20);
      if (recentMsgs.length === 0) break;

      // 最后一条不是对方发的，说明已经回复过了，不需要再回
      const lastMsg = recentMsgs[recentMsgs.length - 1];
      if (lastMsg.sender === toId) break;

      const msgText = formatMessagesForLLM(recentMsgs);

      // 获取对方的显示名
      const fromAgent = engine.getAgent(fromId);
      const toAgent = engine.getAgent(toId);
      const fromName = fromAgent?.agentName || fromId;
      const toName = toAgent?.agentName || toId;

      debugLog()?.log("dm-router", `${toId} replying to ${fromId} (round ${round + 1}/${MAX_ROUNDS})`);

      // 用频道模式 prompt 让 toId 回复
      const isZh = getLocale().startsWith("zh");
      const replyText = await runAgentSession(
        toId,
        [
          {
            text: isZh
              ? `你的手机收到了来自「${fromName}」的私信。\n\n`
                + `以下是你们最近的聊天记录：\n\n${msgText}\n\n`
                + `---\n\n`
                + `请给出你的回复（第 ${round + 1}/${MAX_ROUNDS} 轮）。直接输出内容，不要加前缀。\n`
                + `如果你觉得对话可以结束了，在末尾加 <done/>。\n`
                + `如果你不想回复，输出 [NO_REPLY]。`
              : `You received a DM from "${fromName}".\n\n`
                + `Here is your recent chat history:\n\n${msgText}\n\n`
                + `---\n\n`
                + `Give your reply (round ${round + 1}/${MAX_ROUNDS}). Output directly, no prefix.\n`
                + `If you think the conversation can end, append <done/>.\n`
                + `If you don't want to reply, output [NO_REPLY].`,
            capture: true,
          },
        ],
        {
          engine,
          sessionSuffix: "dm-temp",
          keepSession: false,
          noTools: true,
        },
      );

      if (!replyText || replyText.includes("[NO_REPLY]")) {
        debugLog()?.log("dm-router", `${toName} chose not to reply to ${fromName}`);
        break;
      }

      const isDone = /<done\s*\/?>/i.test(replyText);
      const cleanReply = replyText.replace(/<done\s*\/?>/gi, "").trim();

      if (!cleanReply) break;

      // 写入双方的 dm 文件
      const toFile = path.join(agentsDir, toId, "dm", `${fromId}.md`);
      const fromFile = path.join(agentsDir, fromId, "dm", `${toId}.md`);
      await appendMessage(toFile, toId, cleanReply);
      if (fs.existsSync(fromFile)) {
        await appendMessage(fromFile, toId, cleanReply);
      }

      // 通知前端
      this._hub.eventBus.emit({
        type: "dm_new_message",
        from: toId,
        to: fromId,
      }, null);

      debugLog()?.log("dm-router", `${toName} replied to ${fromName}: ${cleanReply.slice(0, 60)}...${isDone ? " [done]" : ""}`);

      if (isDone) break;

      // 交换角色，让对方也回复
      const swapKey = `${toId}→${fromId}`;
      this._cooldowns.set(swapKey, Date.now());
      [fromId, toId] = [toId, fromId];
    }
  }
}
