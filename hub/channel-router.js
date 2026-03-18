/**
 * ChannelRouter — 频道调度（从 engine.js 搬出）
 *
 * 频道 = 内部 Channel，和 Telegram/飞书一样通过 Hub 路由。
 * 包装 channel-ticker（不改 ticker，只提供回调）。
 *
 * 搬出的方法：
 *   _getChannelAgentOrder  → getAgentOrder()
 *   _executeChannelCheck   → _executeCheck()
 *   _executeChannelReply   → _executeReply()
 *   _channelMemorySummarize → _memorySummarize()
 *   _setupChannelPostHandler → setupPostHandler()
 *   toggleChannels          → toggle()
 */

import fs from "fs";
import path from "path";
import { createChannelTicker } from "../lib/channels/channel-ticker.js";
import { appendMessage, formatMessagesForLLM } from "../lib/channels/channel-store.js";
import { loadConfig } from "../lib/memory/config-loader.js";
import { callProviderText } from "../lib/llm/provider-client.js";
import { runAgentSession } from "./agent-executor.js";
import { debugLog } from "../lib/debug-log.js";

export class ChannelRouter {
  /**
   * @param {object} opts
   * @param {import('./index.js').Hub} opts.hub
   */
  static _AGENT_ORDER_TTL = 30_000; // 30 秒

  constructor({ hub }) {
    this._hub = hub;
    this._ticker = null;
    this._agentOrderCache = null; // { list: string[], ts: number }
  }

  /** @returns {import('../core/engine.js').HanaEngine} */
  get _engine() { return this._hub.engine; }

  // ──────────── 生命周期 ────────────

  start() {
    const engine = this._engine;
    if (!engine.channelsDir) return;

    this._ticker = createChannelTicker({
      channelsDir: engine.channelsDir,
      agentsDir: engine.agentsDir,
      getAgentOrder: () => this.getAgentOrder(),
      executeCheck: (agentId, channelName, newMessages, allUpdates, opts) =>
        this._executeCheck(agentId, channelName, newMessages, allUpdates, opts),
      onMemorySummarize: (agentId, channelName, contextText) =>
        this._memorySummarize(agentId, channelName, contextText),
      onEvent: (event, data) => {
        this._hub.eventBus.emit({ type: event, ...data }, null);
      },
    });
    this._ticker.start();
  }

  async stop() {
    if (this._ticker) {
      await this._ticker.stop();
      this._ticker = null;
    }
  }

  async toggle(enabled) {
    if (enabled) {
      if (this._ticker) return;
      this.start();
    } else {
      await this.stop();
    }
  }

  triggerImmediate(channelName, opts) {
    return this._ticker?.triggerImmediate(channelName, opts);
  }

  /**
   * 注入频道 post 回调到当前 agent
   * agent 用 channel tool 发消息后，触发其他 agent 的 triage
   */
  setupPostHandler() {
    this._engine.agent._channelPostHandler = (channelName, senderId) => {
      debugLog()?.log("channel", `agent ${senderId} posted to #${channelName}, triggering triage`);
      this.triggerImmediate(channelName)?.catch(err =>
        console.error(`[channel] agent post triage 失败: ${err.message}`)
      );
    };
  }

  // ──────────── 频道 Agent 顺序 ────────────

  /** 获取参与频道轮转的 agent 列表（只含有 channels.md 的，30s TTL 缓存） */
  getAgentOrder() {
    const now = Date.now();
    if (this._agentOrderCache && now - this._agentOrderCache.ts < ChannelRouter._AGENT_ORDER_TTL) {
      return this._agentOrderCache.list;
    }
    try {
      const entries = fs.readdirSync(this._engine.agentsDir, { withFileTypes: true });
      const list = entries
        .filter(e => e.isDirectory())
        .filter(e => {
          const channelsMd = path.join(this._engine.agentsDir, e.name, "channels.md");
          return fs.existsSync(channelsMd);
        })
        .map(e => e.name);
      this._agentOrderCache = { list, ts: now };
      return list;
    } catch {
      return [];
    }
  }

  // ──────────── Triage + Reply ────────────

  /**
   * 频道检查回调：triage → 两轮 Agent Session → 写入回复
   * 从 engine._executeChannelCheck 搬入
   */
  async _executeCheck(agentId, channelName, newMessages, _allChannelUpdates, { signal } = {}) {
    const engine = this._engine;
    const msgText = formatMessagesForLLM(newMessages);

    // ── 读 agent 完整上下文 ──
    const readFile = (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return ""; } };
    const agentDir = path.join(engine.agentsDir, agentId);

    // 复用 Agent 实例的 personality（identity + yuan + ishiki 已在内存中组装）
    const agentInstance = engine.agents?.get(agentId);
    const cfg = agentInstance?.config || loadConfig(path.join(agentDir, "config.yaml"));
    const agentName = cfg.agent?.name || agentId;

    const agentContext = agentInstance?.personality
      || [readFile(path.join(agentDir, "identity.md")),
          readFile(path.join(engine.productDir, "yuan", `${cfg.agent?.yuan || "hanako"}.md`)),
          readFile(path.join(agentDir, "ishiki.md"))].filter(Boolean).join("\n\n");

    // memory.md 和 user.md 内容会变，仍需从磁盘读取
    const memoryMd = readFile(path.join(agentDir, "memory", "memory.md"));
    const userMd = readFile(path.join(engine.userDir, "user.md"));
    const memoryContext = memoryMd?.trim() ? `\n\n你的记忆：\n${memoryMd}` : "";
    const userContext = userMd?.trim() ? `\n\n用户档案：\n${userMd}` : "";

    // ── 检测 @ ──
    const isMentioned = msgText.includes(`@${agentName}`) || msgText.includes(`@${agentId}`);

    // ── Step 1: Triage ──
    let shouldReply = isMentioned;

    if (!shouldReply) {
      try {
        const { utility_large: model, large_api_key: api_key, large_base_url: base_url, large_api: api } = engine.resolveUtilityConfig();
        if (api_key && base_url && api) {
          const triageSystem = agentContext + memoryContext + userContext
            + "\n\n---\n\n"
            + "你在一个群聊频道里。阅读以下最近的消息，判断你是否要回复。\n"
            + "回答 YES 的情况：有人跟你说话、@你、问了你能回答的问题、或者你有想说的话。\n"
            + "回答 NO 的情况：别人已经充分回答了问题（你没有新的补充）、话题跟你无关、你插不上话、或者你刚回复过且没人追问你。\n"
            + "只回答 YES 或 NO。";

          const triageTimeout = AbortSignal.timeout(10_000);
          const triageSignal = signal
            ? AbortSignal.any([signal, triageTimeout])
            : triageTimeout;
          const answer = await callProviderText({
            api,
            model,
            api_key,
            base_url,
            systemPrompt: triageSystem,
            messages: [{ role: "user", content: `#${channelName} 频道最近消息：\n${msgText}` }],
            temperature: 0,
            max_tokens: 10,
            timeoutMs: 10_000,
            signal: triageSignal,
          });
          shouldReply = answer.trim().toUpperCase().includes("YES");
        } else {
          // utility_large 凭证不完整，跳过 triage 直接回复
          shouldReply = true;
        }
      } catch (err) {
        // utility 模型未配置或 triage 调用失败 → 默认回复（让 agent 自己在 reply 阶段判断要不要说话）
        console.warn(`[channel] triage 不可用，默认回复 (${agentId}/#${channelName}): ${err.message}`);
        shouldReply = true;
      }
    }

    console.log(`\x1b[90m[channel] triage ${agentId}/#${channelName}: ${shouldReply ? "YES" : "NO"}${isMentioned ? " (@)" : ""}\x1b[0m`);
    debugLog()?.log("channel", `triage ${agentId}/#${channelName}: ${shouldReply ? "YES" : "NO"}${isMentioned ? " (mentioned)" : ""} (${newMessages.length} msgs)`);

    if (!shouldReply) {
      return { replied: false };
    }

    // ── Step 2: 两轮 Agent Session 生成回复 ──
    try {
      const replyText = await this._executeReply(agentId, channelName, msgText, { signal });

      if (!replyText) {
        console.log(`\x1b[90m[channel] ${agentId} 回复为空 (#${channelName})\x1b[0m`);
        return { replied: false };
      }

      // 写入频道文件
      const channelFile = path.join(engine.channelsDir, `${channelName}.md`);
      appendMessage(channelFile, agentId, replyText);

      console.log(`\x1b[90m[channel] ${agentId} replied #${channelName} (${replyText.length} chars)\x1b[0m`);
      debugLog()?.log("channel", `${agentId} replied #${channelName} (${replyText.length} chars)`);

      // WS 广播
      this._hub.eventBus.emit({ type: "channel_new_message", channelName, sender: agentId }, null);

      return { replied: true, replyContent: replyText };
    } catch (err) {
      console.error(`[channel] 回复失败 (${agentId}/#${channelName}): ${err.message}`);
      debugLog()?.error("channel", `回复失败 (${agentId}/#${channelName}): ${err.message}`);
      return { replied: false };
    }
  }

  /**
   * 两轮 Agent Session 生成频道回复
   */
  async _executeReply(agentId, channelName, msgText, { signal } = {}) {
    const text = await runAgentSession(
      agentId,
      [
        {
          text: `#${channelName} 频道的最近消息：\n\n${msgText}\n\n`
            + `请阅读这些消息，用 search_memory 查阅记忆来了解上下文和真实发生过的事。\n`
            + `注意：你现在的回复用户看不到，这是你的内部思考环节，仅用于查阅资料和理解上下文。下一轮才是你真正发到群聊的内容。`,
          capture: false,
        },
        {
          text: `现在请给出你想在 #${channelName} 群聊中发送的回复。这条回复会直接发送到群聊，所有人都能看到。\n\n`
            + `回复规定：\n`
            + `- 默认30字以内，像在群里说话，简短自然\n`
            + `- 如果话题确实需要展开（比如讲故事、分析问题、详细解释），可以写到1000字\n`
            + `- 直接输出回复内容，不要加任何前缀、解释、MOOD 或代码块\n`
            + `- 不要重复别人已经说过的内容\n`
            + `- 只说真实发生过的事，不要编造你没做过的活动或经历\n`
            + `- 如果你觉得没什么好说的，回复 [NO_REPLY]`,
          capture: true,
        },
      ],
      { engine: this._engine, signal, sessionSuffix: "channel-temp" },
    );

    if (!text || text.includes("[NO_REPLY]")) {
      debugLog()?.log("channel", `${agentId}/#${channelName}: chose not to reply`);
      return null;
    }

    return text;
  }

  /**
   * 频道记忆摘要
   * 从 engine._channelMemorySummarize 搬入
   */
  async _memorySummarize(agentId, channelName, contextText) {
    const engine = this._engine;
    try {
      const { utility: model, api_key, base_url, api } = engine.resolveUtilityConfig();
      if (!api_key || !base_url || !api) {
        console.log(`\x1b[90m[channel] ${agentId} 无 API 配置，跳过记忆摘要\x1b[0m`);
        return;
      }

      const summaryText = await callProviderText({
        api,
        model,
        api_key,
        base_url,
        systemPrompt: "将频道对话摘要为一条简短的记忆（一两句话），记录关键信息和结论。直接输出摘要，不要前缀。",
        messages: [{ role: "user", content: `频道 #${channelName}：\n${contextText.slice(0, 2000)}` }],
        temperature: 0.3,
        max_tokens: 200,
      });

      // 写入 agent 的 fact store
      const isCurrentAgent = (agentId === engine.currentAgentId);
      let factStore = null;
      let needClose = false;

      if (isCurrentAgent && engine.agent?.factStore) {
        factStore = engine.agent.factStore;
      } else {
        const { FactStore } = await import("../lib/memory/fact-store.js");
        const dbPath = path.join(engine.agentsDir, agentId, "memory", "facts.db");
        factStore = new FactStore(dbPath);
        needClose = true;
      }

      const now = new Date();
      try {
        factStore.add({
          fact: `[#${channelName}] ${summaryText}`,
          tags: ["频道", channelName],
          time: now.toISOString().slice(0, 16),
          session_id: `channel-${channelName}`,
        });
      } finally {
        if (needClose) factStore.close();
      }

      console.log(`\x1b[90m[channel] ${agentId} memory saved (#${channelName}, ${summaryText.length} chars)\x1b[0m`);
    } catch (err) {
      console.error(`[channel] 记忆摘要失败 (${agentId}/#${channelName}): ${err.message}`);
    }
  }
}
