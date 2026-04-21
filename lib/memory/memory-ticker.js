/**
 * memory-ticker.js — 记忆调度器（v3）
 *
 * 触发机制改为 turn-based：
 * - 每 6 轮：滚动摘要 + compileToday + assemble
 * - session 结束：final 滚动摘要 + compileToday + assemble
 * - 每天一次（日期变化时触发）：compileWeek + compileLongterm + compileFacts + assemble + deep-memory
 *
 * session 关闭记忆时，整条记忆流水线都应跳过，避免被写入 summary/facts。
 */

import fs from "fs";
import path from "path";
import { debugLog } from "../debug-log.js";
import {
  compileToday,
  compileWeek,
  compileLongterm,
  compileFacts,
  assemble,
} from "./compile.js";
import { processDirtySessions } from "./deep-memory.js";
import { getLogicalDay } from "../time-utils.js";

const TURNS_PER_SUMMARY = 6;    // 每隔多少轮触发一次滚动摘要

// ── session JSONL 解析 ──

/**
 * 从 session JSONL 文件提取消息列表（带时间戳）
 */
const TAIL_READ_THRESHOLD = 256 * 1024; // 256KB：超过此大小只读尾部

function readSessionMessages(filePath) {
  let raw;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > TAIL_READ_THRESHOLD) {
      // 大文件：只读尾部，跳过首个不完整行
      const fd = fs.openSync(filePath, "r");
      try {
        const buf = Buffer.alloc(TAIL_READ_THRESHOLD);
        fs.readSync(fd, buf, 0, TAIL_READ_THRESHOLD, stat.size - TAIL_READ_THRESHOLD);
        raw = buf.toString("utf-8");
        const firstNewline = raw.indexOf("\n");
        if (firstNewline !== -1) raw = raw.slice(firstNewline + 1);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      raw = fs.readFileSync(filePath, "utf-8");
    }
  } catch {
    return { messages: [], lastTimestamp: null };
  }

  const messages = [];
  let lastTimestamp = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message" && entry.message) {
        const { role, content } = entry.message;
        if (role === "user" || role === "assistant") {
          messages.push({ role, content, timestamp: entry.timestamp || null });
          if (entry.timestamp) lastTimestamp = entry.timestamp;
        }
      }
    } catch {
      // 跳过损坏行
    }
  }

  return { messages, lastTimestamp };
}

/**
 * 列出所有 session JSONL 文件
 */
function listAllSessions(sessionDir) {
  const results = [];

  function scanDir(dir, prefix) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const fp = path.join(dir, f);
        try {
          const stat = fs.statSync(fp);
          if (stat.isFile()) results.push({ filename: prefix ? `${prefix}/${f}` : f, filePath: fp, mtime: stat.mtime });
        } catch {}
      }
    } catch {}
  }

  scanDir(sessionDir, null);
  scanDir(path.join(sessionDir, "bridge", "owner"), "bridge/owner");
  // DM 不再通过 session 系统，不扫描 dms/ 目录

  return results;
}

function sessionIdFromFilename(filename) {
  return filename.replace(/\.jsonl$/, "");
}

// ── 主调度器 ──

/**
 * 创建 v3 记忆调度器
 *
 * @param {object} opts
 * @param {import('./session-summary.js').SessionSummaryManager} opts.summaryManager
 * @param {string} opts.configPath
 * @param {import('./fact-store.js').FactStore} opts.factStore
 * @param {function} opts.getResolvedMemoryModel - 返回预解析的 { model, provider, api, api_key, base_url }
 * @param {function} [opts.onCompiled] - memory.md 更新后的回调
 * @param {string} opts.sessionDir
 * @param {string} opts.memoryMdPath
 * @param {string} opts.todayMdPath
 * @param {string} opts.weekMdPath
 * @param {string} opts.longtermMdPath
 * @param {string} opts.factsMdPath
 * @param {function} [opts.getMemoryMasterEnabled] - 返回 agent 级别记忆总开关状态
 * @param {(sessionPath: string) => boolean} [opts.isSessionMemoryEnabled] - 返回指定 session 的记忆状态
 */
export function createMemoryTicker(opts) {
  const {
    summaryManager,
    configPath,
    factStore,
    getResolvedMemoryModel,
    onCompiled,
    sessionDir,
    memoryMdPath,
    todayMdPath,
    weekMdPath,
    longtermMdPath,
    factsMdPath,
    getMemoryMasterEnabled,
    isSessionMemoryEnabled,
  } = opts;

  /** agent 级总开关 */
  const _isMemoryMasterOn = () => !getMemoryMasterEnabled || getMemoryMasterEnabled();
  /** 指定 session 是否允许进入记忆流水线 */
  const _isSessionMemoryOn = (sessionPath) =>
    _isMemoryMasterOn() && (!isSessionMemoryEnabled || isSessionMemoryEnabled(sessionPath));

  // 每小时检查日期变化（备用触发，主触发是 notifyTurn）
  const DAILY_CHECK_INTERVAL = 60 * 60 * 1000;

  let _timer = null;
  let _tickInFlight = null;
  let _dailyRunning = false;
  let _lastDailyJobDate = null;
  let _dailyStepsDate = null;               // 当天已完成步骤所属日期
  const _dailyStepsCompleted = new Set();    // 当天已完成的步骤名（断点续跑）
  const _turnCounts = new Map();             // sessionPath → turn count
  const _summaryInProgress = new Set();      // 正在跑滚动摘要的 session

  // ── 错误 dedup：相同根因（如凭证持续无效）只在 console 打一次，避免每轮对话都刷屏 ──
  let _lastErrorSig = null;
  function _logStepError(label, err) {
    const msg = err?.message || String(err);
    const sig = `${label}|${msg}`;
    if (sig === _lastErrorSig) {
      // 同一根因重复 → 只写 debug 文件，不打 console
      debugLog()?.error("memory", `${label} (dup suppressed): ${msg}`);
      return;
    }
    _lastErrorSig = sig;
    console.error(`\x1b[90m[memory-ticker] ${label} 失败: ${msg}\x1b[0m`);
    debugLog()?.error("memory", `${label} failed: ${msg}`);
  }
  function _markStepRecovered(label) {
    if (!_lastErrorSig) return;
    const prev = _lastErrorSig;
    _lastErrorSig = null;
    console.log(`\x1b[90m[memory-ticker] ${label} 恢复正常（之前: ${prev}）\x1b[0m`);
    debugLog()?.log("memory", `${label} recovered (was: ${prev})`);
  }

  // ── 步骤健康状态：每步独立记录，方便 UI 层 / healthz 接口读取 ──
  // 注意：failCount 只在连续失败时递增，一次成功立即清零
  const _stepKeys = ["rollingSummary", "compileToday", "compileWeek", "compileLongterm", "compileFacts", "deepMemory"];
  const _health = {};
  for (const k of _stepKeys) {
    _health[k] = { lastSuccessAt: null, lastErrorAt: null, lastErrorMsg: null, failCount: 0 };
  }
  function _markSuccess(stepKey) {
    const h = _health[stepKey];
    if (!h) return;
    h.lastSuccessAt = new Date().toISOString();
    h.lastErrorAt = null;
    h.lastErrorMsg = null;
    h.failCount = 0;
  }
  function _markFailure(stepKey, err) {
    const h = _health[stepKey];
    if (!h) return;
    h.lastErrorAt = new Date().toISOString();
    h.lastErrorMsg = err?.message || String(err);
    h.failCount += 1;
  }

  // ── 内部：滚动摘要 ──

  async function _doRollingSummary(sessionPath) {
    if (_summaryInProgress.has(sessionPath)) return; // 并发保护
    _summaryInProgress.add(sessionPath);
    try {
      const { messages } = readSessionMessages(sessionPath);
      if (messages.length === 0) return;

      const sessionId = sessionIdFromFilename(path.basename(sessionPath));
      await summaryManager.rollingSummary(sessionId, messages, getResolvedMemoryModel());
      debugLog()?.log("memory", `rolling summary updated: ${sessionId.slice(0, 8)}...`);
      _markSuccess("rollingSummary");
      _markStepRecovered("滚动摘要");
    } catch (err) {
      _markFailure("rollingSummary", err);
      _logStepError(`滚动摘要 (${path.basename(sessionPath)})`, err);
    } finally {
      _summaryInProgress.delete(sessionPath);
    }
  }

  // ── 内部：今天编译 + 组装 ──

  async function _doCompileTodayAndAssemble() {
    try {
      await compileToday(summaryManager, todayMdPath, getResolvedMemoryModel());
      assemble(factsMdPath, todayMdPath, weekMdPath, longtermMdPath, memoryMdPath);
      onCompiled?.();
      debugLog()?.log("memory", "today compiled + assembled");
      _markSuccess("compileToday");
      _markStepRecovered("compileToday");
    } catch (err) {
      _markFailure("compileToday", err);
      _logStepError("compileToday", err);
    }
  }

  // ── 内部：每日任务 ──

  async function _doDaily() {
    if (_dailyRunning) return;
    _dailyRunning = true;
    try {
      const todayStr = getLogicalDay().logicalDate;

      // 日期变化时重置步骤跟踪
      if (_dailyStepsDate !== todayStr) {
        _dailyStepsCompleted.clear();
        _dailyStepsDate = todayStr;
      }

      console.log(`\x1b[90m[memory-ticker] 每日任务开始 (${todayStr})\x1b[0m`);
      let hasFailed = false;

      // Step 0: compileToday（日期切换后刷新 today.md，新一天无 session 时会清空）
      if (!_dailyStepsCompleted.has("compileToday")) {
        try {
          await compileToday(summaryManager, todayMdPath, getResolvedMemoryModel());
          _dailyStepsCompleted.add("compileToday");
          _markSuccess("compileToday");
          _markStepRecovered("compileToday(daily)");
        } catch (err) {
          hasFailed = true;
          _markFailure("compileToday", err);
          _logStepError("compileToday(daily)", err);
        }
      }

      // Step 1: compileWeek
      if (!_dailyStepsCompleted.has("compileWeek")) {
        try {
          await compileWeek(summaryManager, weekMdPath, getResolvedMemoryModel());
          _dailyStepsCompleted.add("compileWeek");
          _markSuccess("compileWeek");
          _markStepRecovered("compileWeek");
        } catch (err) {
          hasFailed = true;
          _markFailure("compileWeek", err);
          _logStepError("compileWeek", err);
        }
      }

      // Step 2: compileLongterm（依赖 compileWeek 产出的 week.md，必须等 compileWeek 完成）
      if (!_dailyStepsCompleted.has("compileLongterm") && _dailyStepsCompleted.has("compileWeek")) {
        try {
          await compileLongterm(weekMdPath, longtermMdPath, getResolvedMemoryModel());
          _dailyStepsCompleted.add("compileLongterm");
          _markSuccess("compileLongterm");
          _markStepRecovered("compileLongterm");
        } catch (err) {
          hasFailed = true;
          _markFailure("compileLongterm", err);
          _logStepError("compileLongterm", err);
        }
      }

      // Step 3: compileFacts（独立于 step 1-2）
      if (!_dailyStepsCompleted.has("compileFacts")) {
        try {
          await compileFacts(summaryManager, factsMdPath, getResolvedMemoryModel());
          _dailyStepsCompleted.add("compileFacts");
          _markSuccess("compileFacts");
          _markStepRecovered("compileFacts");
        } catch (err) {
          hasFailed = true;
          _markFailure("compileFacts", err);
          _logStepError("compileFacts", err);
        }
      }

      // Step 4: assemble（纯文件操作，用已有的 .md 文件组装，总是执行）
      try {
        assemble(factsMdPath, todayMdPath, weekMdPath, longtermMdPath, memoryMdPath);
        onCompiled?.();
      } catch (err) {
        hasFailed = true;
        console.error(`\x1b[90m[memory-ticker] assemble 失败: ${err.message}\x1b[0m`);
      }

      // Step 5: deep-memory（独立，更新 facts.db）
      if (!_dailyStepsCompleted.has("deepMemory")) {
        try {
          const { processed, factsAdded } = await processDirtySessions(
            summaryManager, factStore, getResolvedMemoryModel(),
          );
          _dailyStepsCompleted.add("deepMemory");
          if (processed > 0) {
            console.log(`\x1b[90m[memory-ticker] deep-memory: ${processed} session, ${factsAdded} 条新事实\x1b[0m`);
          }
          _markSuccess("deepMemory");
          _markStepRecovered("deep-memory");
        } catch (err) {
          hasFailed = true;
          _markFailure("deepMemory", err);
          _logStepError("deep-memory", err);
        }
      }

      if (hasFailed) {
        const done = [..._dailyStepsCompleted].join(", ");
        console.error(`\x1b[90m[memory-ticker] 每日任务部分失败，已完成: [${done}]，1 小时后重试未完成步骤\x1b[0m`);
        debugLog()?.error("memory", `daily job partial failure, completed: [${done}]`);
      } else {
        _lastDailyJobDate = todayStr;
        console.log(`\x1b[90m[memory-ticker] 每日任务完成\x1b[0m`);
      }
    } finally {
      _dailyRunning = false;
    }
  }

  function _checkDailyJob() {
    if (!_isMemoryMasterOn()) return;
    const todayStr = getLogicalDay().logicalDate;
    if (_lastDailyJobDate !== todayStr) {
      _doDaily(); // 后台，不 await
    }
  }

  // ── 公开 API ──

  /**
   * 每轮对话结束后调用（由 engine.js 在 prompt() 返回后调用）
   * @param {string} sessionPath - 当前 session 的 .jsonl 文件路径
   */
  function notifyTurn(sessionPath) {
    const count = (_turnCounts.get(sessionPath) || 0) + 1;
    _turnCounts.set(sessionPath, count);

    const memoryOn = _isSessionMemoryOn(sessionPath);

    if (count % TURNS_PER_SUMMARY === 0 && memoryOn) {
      _doRollingSummary(sessionPath)
        .then(() => _doCompileTodayAndAssemble())
        .catch(() => {});
    }

    if (memoryOn) _checkDailyJob();
  }

  /**
   * Session 切换或 dispose 前调用（final pass）
   * @param {string} sessionPath
   */
  async function notifySessionEnd(sessionPath) {
    if (!sessionPath) return;
    const count = _turnCounts.get(sessionPath) || 0;
    _turnCounts.delete(sessionPath);
    if (count === 0) return; // 没有新轮次，无需更新摘要
    if (!_isSessionMemoryOn(sessionPath)) return;
    try {
      await _doRollingSummary(sessionPath);
      await _doCompileTodayAndAssemble();
    } catch (err) {
      console.error(`\x1b[90m[memory-ticker] notifySessionEnd 失败: ${err.message}\x1b[0m`);
    }
  }

  /**
   * 启动每小时的日期检查 timer（备用触发，不依赖用户对话）
   */
  function start() {
    if (_timer) return;
    _timer = setInterval(() => _checkDailyJob(), DAILY_CHECK_INTERVAL);
    if (_timer.unref) _timer.unref();
    console.log(`\x1b[90m[memory-ticker] v3 已启动（turn-based，每日任务备用 timer 1h）\x1b[0m`);
  }

  async function stop() {
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
    if (_tickInFlight) await _tickInFlight.catch(() => {});
  }

  /**
   * 启动时补偿：扫描最近修改过的 session，如果 JSONL mtime > summary.updated_at，
   * 说明上次崩溃/重启前有未收尾的对话，补跑一次滚动摘要。
   * 只处理过去 24 小时内修改的文件，避免全量扫描。
   */
  async function _recoverUnsummarized() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const sessions = listAllSessions(sessionDir);
    for (const { filePath, mtime } of sessions) {
      if (mtime.getTime() < cutoff) continue;
      if (!_isSessionMemoryOn(filePath)) continue;
      const sessionId = sessionIdFromFilename(path.basename(filePath));
      const existing = summaryManager.getSummary(sessionId);
      const summaryAt = existing?.updated_at ? new Date(existing.updated_at).getTime() : 0;
      if (mtime.getTime() > summaryAt + 5000) { // 5s 宽限，避免极近时间戳误判
        await _doRollingSummary(filePath);
      }
    }
  }

  /**
   * 手动触发一次完整编译（调试 / 启动时用）
   * 先跑 daily job（确保 week/facts/longterm.md 存在），再 compileToday + assemble
   */
  async function tick() {
    const p = _tickCore();
    _tickInFlight = p;
    try { await p; } finally { if (_tickInFlight === p) _tickInFlight = null; }
  }

  async function _tickCore() {
    if (!_isMemoryMasterOn()) return;
    await _recoverUnsummarized(); // 补偿崩溃/重启前未收尾的 session
    const todayStr = getLogicalDay().logicalDate;
    if (_lastDailyJobDate !== todayStr) {
      await _doDaily(); // 启动时 await，确保中间文件就绪后再 assemble
    }
    await _doCompileTodayAndAssemble();
  }

  /**
   * 手动触发（兼容旧调用）
   */
  function triggerNow() {
    tick().catch(() => {});
  }

  /**
   * Session promote 后调用（心跳/cron session 从 activity/ 移到 sessions/ 后）
   * executeIsolated 不调 notifyTurn，所以需要显式补一次滚动摘要。
   * @param {string} sessionPath - promote 后的新 session 文件路径
   */
  async function notifyPromoted(sessionPath) {
    if (!sessionPath) return;
    if (!_isSessionMemoryOn(sessionPath)) return;
    try {
      await _doRollingSummary(sessionPath);
      await _doCompileTodayAndAssemble();
      debugLog()?.log("memory", `promoted session summarized: ${path.basename(sessionPath).slice(0, 20)}...`);
    } catch (err) {
      console.error(`\x1b[90m[memory-ticker] notifyPromoted 失败: ${err.message}\x1b[0m`);
    }
    // 注册 turn count = 1，后续 notifySessionEnd 不会因 count===0 跳过
    _turnCounts.set(sessionPath, 1);
  }

  /**
   * 强制刷新指定 session 的摘要（日记等功能调用前确保摘要最新）
   * @param {string} sessionPath
   */
  async function flushSession(sessionPath) {
    if (!sessionPath) return;
    if (!_isSessionMemoryOn(sessionPath)) return;
    await _doRollingSummary(sessionPath);
  }

  /**
   * 返回每个编译步骤的健康状态快照（深拷贝，调用方安全持有）
   * @returns {Record<string, { lastSuccessAt: string|null, lastErrorAt: string|null, lastErrorMsg: string|null, failCount: number }>}
   */
  function getHealthStatus() {
    const snapshot = {};
    for (const k of _stepKeys) snapshot[k] = { ..._health[k] };
    return snapshot;
  }

  return { start, stop, tick, triggerNow, notifyTurn, notifySessionEnd, notifyPromoted, flushSession, getHealthStatus };
}
