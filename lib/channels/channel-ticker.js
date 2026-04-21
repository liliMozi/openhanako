/**
 * channel-ticker.js — 频道顺序轮询调度器（中断恢复）
 *
 * 调度模型：
 * - 顺序轮询：Agent A → B → C 依次处理所有频道
 * - 全部完成后休息 10 分钟，再开始下一轮
 * - 用户发群消息 → 中断当前执行 → 全员 triage → 恢复中断点
 *
 * 中断恢复机制：
 * - 用户消息到达时，abort 当前 session
 * - 保存检查点（已处理到哪个 agent 的哪个频道）
 * - 处理完用户消息后，从检查点恢复继续
 *
 * 调度器本身不调用 LLM，通过回调委托给 engine。
 */

import {
  readBookmarks,
  updateBookmark,
  getNewMessages,
  getRecentMessages,
  formatMessagesForLLM,
} from "./channel-store.js";
import { debugLog } from "../debug-log.js";
import { getLocale } from "../../server/i18n.js";
import fs from "fs";
import path from "path";

/**
 * 创建频道顺序轮询调度器
 *
 * @param {object} opts
 * @param {string} opts.channelsDir - 频道目录
 * @param {string} opts.agentsDir - agents 父目录
 * @param {() => string[]} opts.getAgentOrder - 返回参与轮转的 agent ID 列表
 * @param {(agentId, channelName, newMessages, allUpdates, opts?) => Promise<{replied, replyContent?}>} opts.executeCheck
 * @param {(agentId, channelName, contextText) => Promise<void>} opts.onMemorySummarize
 * @param {(event, data) => void} [opts.onEvent]
 * @returns {{ start, stop, triggerImmediate, isRunning }}
 */
export function createChannelTicker({
  channelsDir,
  agentsDir,
  getAgentOrder,
  executeCheck,
  onMemorySummarize,
  onEvent,
}) {
  const PAUSE_MS = 10 * 60 * 1000; // 10 分钟间隔

  // ── 状态 ──
  let _timer = null;          // 下一个 cycle 的定时器
  let _cyclePromise = null;   // 当前 cycle 的 Promise
  let _abortCtrl = null;      // 当前频道执行的 AbortController
  let _interruptPending = false; // 中断标记
  let _checkpoint = null;     // { agentIdx, channelIdx } 中断恢复点
  let _running = false;       // 是否有 cycle 在运行

  // ── triage 状态（用户消息触发的立即处理）──
  let _triageAbortCtrl = null;   // triage 专用 AbortController
  let _triagePromise = null;     // 当前 triage 的 Promise
  let _triggerChain = Promise.resolve(); // 串行化 triggerImmediate 调用
  let _stopped = false;          // stop() 后禁止新的 triage

  // ── 工具函数 ──

  /** 获取频道文件中最新一条消息的时间戳 */
  function getLatestTimestamp(channelFile) {
    if (!fs.existsSync(channelFile)) return null;
    const content = fs.readFileSync(channelFile, "utf-8");
    const headerRe = /^### .+? \| (\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)$/gm;
    let lastMatch = null;
    let m;
    while ((m = headerRe.exec(content)) !== null) {
      lastMatch = m[1];
    }
    return lastMatch;
  }

  /** 收集一个 agent 的所有频道更新（有新消息的） */
  function collectAgentChannels(agentId) {
    const channelsMdPath = path.join(agentsDir, agentId, "channels.md");
    const bookmarks = readBookmarks(channelsMdPath);
    const updates = [];

    for (const [channelName, bookmark] of bookmarks) {
      const channelFile = path.join(channelsDir, `${channelName}.md`);
      const bk = bookmark === "never" ? null : bookmark;
      // 用 bookmark 判断有没有新消息
      const hasNew = getNewMessages(channelFile, bk, agentId).length > 0;
      // 但上下文用滑动窗口（最近 10 条）
      const recentMsgs = hasNew ? getRecentMessages(channelFile, 20, agentId) : [];

      updates.push({
        channelName,
        channelFile,
        channelsMdPath,
        bookmark: bk,
        newMessages: recentMsgs,
        hasNew,
      });
    }
    return updates;
  }

  // ── 核心：顺序轮询 ──

  /**
   * 执行一个完整的 cycle：所有 agent 依次处理所有频道
   * 支持从 checkpoint 恢复
   */
  async function _runCycle() {
    _running = true;
    try {
      const agents = getAgentOrder();
      if (agents.length === 0) return;

      // 从检查点恢复或从头开始
      const startAgent = _checkpoint?.agentIdx ?? 0;
      const startChannel = _checkpoint?.channelIdx ?? 0;
      _checkpoint = null;

      console.log(`\x1b[90m[channel-ticker] cycle 开始（${agents.length} 个 agent${startAgent > 0 ? `，从 ${agents[startAgent]} 恢复` : ""}）\x1b[0m`);
      debugLog()?.log("ticker", `cycle start (${agents.length} agents${startAgent > 0 ? `, resume from idx ${startAgent}` : ""})`);
      onEvent?.("channel_cycle_start", { agents, resumeFrom: startAgent });

      for (let ai = startAgent; ai < agents.length; ai++) {
        const agentId = agents[ai];
        const channelUpdates = collectAgentChannels(agentId);
        const withNew = channelUpdates.filter(u => u.hasNew);
        const startCh = (ai === startAgent) ? startChannel : 0;

        if (withNew.length === 0) {
          debugLog()?.log("ticker", `${agentId}: no new messages, skipping`);
          continue;
        }

        console.log(`\x1b[90m[channel-ticker] → ${agentId}（${withNew.length} 个频道有新消息）\x1b[0m`);
        debugLog()?.log("ticker", `→ ${agentId} (${withNew.length} channels with new msgs)`);

        for (let ci = startCh; ci < channelUpdates.length; ci++) {
          // ★ 每个频道之前检查中断
          if (_interruptPending) {
            _checkpoint = { agentIdx: ai, channelIdx: ci };
            console.log(`\x1b[90m[channel-ticker] 中断！保存检查点 agent=${agentId} ch=${ci}\x1b[0m`);
            debugLog()?.log("ticker", `interrupted, checkpoint: agent=${ai} ch=${ci}`);
            return;
          }

          const update = channelUpdates[ci];
          if (!update.hasNew) continue;

          await _processOneChannel(agentId, update);
        }
      }

      // 全部完成
      console.log(`\x1b[90m[channel-ticker] cycle 完成，${Math.round(PAUSE_MS / 1000)}秒后下一轮\x1b[0m`);
      debugLog()?.log("ticker", `cycle done, next in ${Math.round(PAUSE_MS / 1000)}s`);
      onEvent?.("channel_cycle_done", {});
      _scheduleNext(PAUSE_MS);
    } catch (err) {
      console.error(`\x1b[90m[channel-ticker] cycle 错误: ${err.message}\x1b[0m`);
      debugLog()?.error("ticker", `cycle error: ${err.message}`);
      // 出错后也调度下一轮
      _scheduleNext(PAUSE_MS);
    } finally {
      _running = false;
    }
  }

  /**
   * 处理单个频道（可被 abort）
   */
  async function _processOneChannel(agentId, update) {
    _abortCtrl = new AbortController();

    console.log(`\x1b[90m[channel-ticker] ${agentId} 检查 #${update.channelName}（${update.newMessages.length} 条新消息）\x1b[0m`);

    try {
      const result = await executeCheck(
        agentId,
        update.channelName,
        update.newMessages,
        [],
        { signal: _abortCtrl.signal },
      );

      // 成功：更新 bookmark
      const latestTs = getLatestTimestamp(update.channelFile);
      if (latestTs) {
        updateBookmark(update.channelsMdPath, update.channelName, latestTs);
      }

      // 回复了 → 记忆摘要
      if (result?.replied && onMemorySummarize) {
        const contextText = formatMessagesForLLM(update.newMessages);
        const myReplyLabel = getLocale().startsWith("zh") ? "[我的回复]" : "[My reply]";
        const fullContext = result.replyContent
          ? `${contextText}\n\n${myReplyLabel} ${result.replyContent}`
          : contextText;
        await onMemorySummarize(agentId, update.channelName, fullContext);
      }
    } catch (err) {
      if (_interruptPending) {
        // 被中断，不更新 bookmark（下次重试）
        console.log(`\x1b[90m[channel-ticker] ${agentId}/#${update.channelName} 被中断\x1b[0m`);
        return;
      }
      console.error(`\x1b[90m[channel-ticker] ${agentId} 处理 #${update.channelName} 失败: ${err.message}\x1b[0m`);
    } finally {
      _abortCtrl = null;
    }
  }

  // ── 中断处理 ──

  /**
   * 用户发消息后立即中断 + triage
   *
   * 合并机制：如果用户连续发多条消息，后到的消息会：
   * 1. abort 正在进行的 triage（如果有）
   * 2. 等它结束
   * 3. 用最新的滑动窗口重新开始
   *
   * 这样保证 agent 看到的永远是最新的完整上下文。
   *
   * @param {string} channelName
   * @param {{ mentionedAgents?: string[] }} [opts]
   */
  function triggerImmediate(channelName, { mentionedAgents } = {}) {
    if (_stopped) return Promise.resolve();

    // 串行化：新调用排在前一个完成之后，避免并发重入
    _triggerChain = _triggerChain.then(async () => {
      if (_stopped) return;

      // abort 正在进行的 triage（如果有）
      if (_triageAbortCtrl) {
        console.log(`\x1b[90m[channel-ticker] 新消息到达，abort 当前 triage 并重新开始\x1b[0m`);
        debugLog()?.log("ticker", `new message arrived, aborting current triage to restart`);
        _triageAbortCtrl.abort();
      }
      if (_triagePromise) {
        await _triagePromise.catch(() => {});
        _triagePromise = null;
      }

      // 启动新的 triage
      _triagePromise = _doTriage(channelName, { mentionedAgents });
      await _triagePromise.catch(() => {});
      _triagePromise = null;
    }).catch(() => {});

    return _triggerChain;
  }

  /**
   * 实际执行 triage 的内部方法（可被 abort）
   */
  async function _doTriage(channelName, { mentionedAgents } = {}) {
    // ── 1. 中断正在运行的 cycle ──
    _interruptPending = true;

    if (_abortCtrl) {
      _abortCtrl.abort();
    }

    if (_timer) {
      clearTimeout(_timer);
      _timer = null;
    }

    if (_cyclePromise) {
      await _cyclePromise.catch(() => {});
      _cyclePromise = null;
    }

    _interruptPending = false;

    // ── 2. 创建 triage 专用 AbortController ──
    _triageAbortCtrl = new AbortController();
    const signal = _triageAbortCtrl.signal;

    // ── 3. 过滤 agent：有 @ 只检查被 @ 的，没有 @ 全员检查 ──
    const allAgents = getAgentOrder();
    const hasMentions = mentionedAgents && mentionedAgents.length > 0;
    const agents = hasMentions
      ? allAgents.filter(id => mentionedAgents.includes(id))
      : allAgents;

    console.log(`\x1b[90m[channel-ticker] 用户消息 → 立即 triage #${channelName}（${agents.length}/${allAgents.length} 个 agent${hasMentions ? `，@ ${mentionedAgents.join(",")}` : ""}）\x1b[0m`);
    debugLog()?.log("ticker", `interrupt: immediate triage #${channelName} (${agents.length} agents${hasMentions ? `, mentioned: ${mentionedAgents}` : ""})`);

    // ── 4. 逐个 agent triage（每次重新读滑动窗口，这样前一个 agent 的回复也会包含在内）──
    try {
      for (const agentId of agents) {
        // ★ 被 abort 了就停
        if (signal.aborted) {
          console.log(`\x1b[90m[channel-ticker] triage 被新消息中断，停止\x1b[0m`);
          debugLog()?.log("ticker", `triage aborted by new message`);
          return;
        }

        const channelsMdPath = path.join(agentsDir, agentId, "channels.md");
        const bookmarks = readBookmarks(channelsMdPath);

        if (!bookmarks.has(channelName)) continue;

        const channelFile = path.join(channelsDir, `${channelName}.md`);
  
        // 每次都重新读滑动窗口（包含前面 agent 刚回复的消息）
        const recentMsgs = getRecentMessages(channelFile, 20, agentId);

        if (recentMsgs.length === 0) continue;

        console.log(`\x1b[90m[channel-ticker] 立即 ${agentId} → #${channelName}（${recentMsgs.length} 条上下文）\x1b[0m`);

        try {
          const result = await executeCheck(agentId, channelName, recentMsgs, [], { signal });

          if (signal.aborted) return; // 被 abort 了，不更新 bookmark

          const latestTs = getLatestTimestamp(channelFile);
          if (latestTs) {
            updateBookmark(channelsMdPath, channelName, latestTs);
          }

          if (result?.replied && onMemorySummarize) {
            const contextText = formatMessagesForLLM(recentMsgs);
            const myReplyTag = getLocale().startsWith("zh") ? "[我的回复]" : "[My reply]";
            const fullContext = result.replyContent
              ? `${contextText}\n\n${myReplyTag} ${result.replyContent}`
              : contextText;
            await onMemorySummarize(agentId, channelName, fullContext);
          }
        } catch (err) {
          if (signal.aborted) return; // 被 abort 了，静默退出
          console.error(`[channel-ticker] 立即 triage ${agentId}/#${channelName} 失败: ${err.message}`);
        }
      }
    } finally {
      _triageAbortCtrl = null;

      // ── 5. 恢复被中断的 cycle 或调度下一轮 ──
      // 放在 finally 里，这样即使 triage 被 abort 也能恢复 checkpoint
      // 但如果被 abort 了，由新的 triage 负责恢复，这里跳过
      if (!signal.aborted) {
        if (_checkpoint) {
          console.log(`\x1b[90m[channel-ticker] 恢复中断的 cycle（checkpoint agent=${_checkpoint.agentIdx} ch=${_checkpoint.channelIdx}）\x1b[0m`);
          debugLog()?.log("ticker", `resuming cycle from checkpoint`);
          _cyclePromise = _runCycle();
        } else {
          _scheduleNext(PAUSE_MS);
        }
      }
    }
  }

  // ── 定时调度 ──

  /** 调度下一个 cycle */
  function _scheduleNext(delayMs) {
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(() => {
      _timer = null;
      _checkpoint = null; // 新 cycle 从头开始
      _cyclePromise = _runCycle();
    }, delayMs);
    if (_timer.unref) _timer.unref();

    console.log(`\x1b[90m[channel-ticker] 下次 cycle：${Math.round(delayMs / 1000)}秒后\x1b[0m`);
  }

  /** 启动调度器 */
  function start() {
    if (_timer || _running) return;
    _stopped = false;

    // 首次执行延迟 30 秒（让系统先启动完成）
    const delay = 30 * 1000;
    console.log(`\x1b[90m[channel-ticker] 调度器已启动（${Math.round(delay / 1000)}秒后首次执行，间隔 ${Math.round(PAUSE_MS / 60000)} 分钟）\x1b[0m`);

    _timer = setTimeout(() => {
      _timer = null;
      _cyclePromise = _runCycle();
    }, delay);
    if (_timer.unref) _timer.unref();
  }

  /** 停止调度器 */
  async function stop() {
    _stopped = true; // 禁止新的 triage
    if (_timer) {
      clearTimeout(_timer);
      _timer = null;
    }
    // 停止 triage
    if (_triageAbortCtrl) _triageAbortCtrl.abort();
    if (_triagePromise) {
      await _triagePromise.catch(() => {});
      _triagePromise = null;
    }
    // 等待串行链完成
    await _triggerChain.catch(() => {});
    // 标记中断，让 cycle 尽快退出
    _interruptPending = true;
    if (_abortCtrl) _abortCtrl.abort();
    if (_cyclePromise) {
      await _cyclePromise.catch(() => {});
      _cyclePromise = null;
    }
    _interruptPending = false;
    _checkpoint = null;
  }

  return {
    start,
    stop,
    triggerImmediate,
    get isRunning() { return _running; },
  };
}
