/**
 * Scheduler — Heartbeat + Cron 调度（v2）
 *
 * Heartbeat：只跑当前 active agent（有书桌才有心跳）
 * Cron：所有 agent 独立并发，不随 active agent 切换而中断
 *
 * Agent 切换时只 reload heartbeat，cron 持续跑。
 *
 * 通知策略：agent 自行决定是否调用 notify 工具，scheduler 不做通知判断。
 */

import fs from "fs";
import path from "path";
import { createHeartbeat } from "../lib/desk/heartbeat.js";
import { createCronScheduler } from "../lib/desk/cron-scheduler.js";
import { CronStore } from "../lib/desk/cron-store.js";

export class Scheduler {
  /**
   * @param {object} opts
   * @param {import('./index.js').Hub} opts.hub
   */
  constructor({ hub }) {
    this._hub = hub;
    this._heartbeat = null;
    this._agentCrons = new Map(); // agentId → CronScheduler
    this._executingAgents = new Set(); // 正在执行 cron 的 agentId
  }

  /** @returns {import('../core/engine.js').HanaEngine} */
  get _engine() { return this._hub.engine; }

  /** 暴露 heartbeat（给 desk route 的 triggerNow 用） */
  get heartbeat() { return this._heartbeat; }

  /** 暴露某个 agent 的 cronScheduler */
  getCronScheduler(agentId) {
    return this._agentCrons.get(agentId ?? this._engine.currentAgentId) ?? null;
  }

  /** @deprecated 兼容旧访问 */
  get cronScheduler() { return this.getCronScheduler(); }

  // ──────────── 生命周期 ────────────

  start() {
    this.startHeartbeat();
    this._startAllCrons();
  }

  async stop() {
    await this.stopHeartbeat();
    for (const sched of this._agentCrons.values()) {
      await sched.stop();
    }
    this._agentCrons.clear();
  }

  /** 启动某个 agent 的 cron（幂等，已有则跳过） */
  startAgentCron(agentId) { this._startAgentCron(agentId); }

  /** 停止并移除某个 agent 的 cron */
  async removeAgentCron(agentId) {
    const sched = this._agentCrons.get(agentId);
    if (sched) {
      await sched.stop();
      this._agentCrons.delete(agentId);
    }
  }

  /** Agent 切换：只重建 heartbeat，cron 不中断 */
  async reloadHeartbeat() {
    await this.stopHeartbeat();
    this.startHeartbeat();
  }

  startHeartbeat() {
    const engine = this._engine;
    const agent = engine.agent;
    if (!agent.deskManager || !agent.cronStore) return;

    const hbInterval = agent.config?.desk?.heartbeat_interval;
    const hbEnabled = agent.config?.desk?.heartbeat_enabled !== false;
    this._heartbeat = createHeartbeat({
      getDeskFiles: () => engine.listDeskFiles(),
      getWorkspacePath: () => engine.homeCwd,
      registryPath: path.join(agent.deskDir, "jian-registry.json"),
      overwatchPath: path.join(agent.deskDir, "overwatch.md"),
      onBeat: (prompt) => this._executeActivity(prompt, "heartbeat"),
      onJianBeat: (prompt, cwd) => this._executeActivity(prompt, "heartbeat", `笺:${path.basename(cwd)}`, { cwd }),
      intervalMinutes: hbInterval,
      emitDevLog: (text, level) => engine.emitDevLog(text, level),
      locale: agent.config?.locale,
    });
    if (hbEnabled) this._heartbeat.start();
  }

  async stopHeartbeat() {
    if (this._heartbeat) {
      await this._heartbeat.stop();
      this._heartbeat = null;
    }
  }

  // ──────────── Per-agent Cron ────────────

  _startAllCrons() {
    const engine = this._engine;
    let entries;
    try {
      entries = fs.readdirSync(engine.agentsDir, { withFileTypes: true });
    } catch { return; }

    for (const e of entries) {
      if (e.isDirectory()) this._startAgentCron(e.name);
    }
  }

  _startAgentCron(agentId) {
    if (this._agentCrons.has(agentId)) return;
    const engine = this._engine;
    const agentDir = path.join(engine.agentsDir, agentId);
    const deskDir = path.join(agentDir, "desk");

    let cronStore;
    try {
      cronStore = new CronStore(
        path.join(deskDir, "cron-jobs.json"),
        path.join(deskDir, "cron-runs"),
      );
    } catch { return; }

    const sched = createCronScheduler({
      cronStore,
      executeJob: (job) => this._executeCronJobForAgent(agentId, job),
      onJobDone: (job, result) => {
        this._hub.eventBus.emit(
          { type: "cron_job_done", jobId: job.id, label: job.label, agentId, result },
          null,
        );
      },
    });
    this._agentCrons.set(agentId, sched);
    sched.start();
    console.log(`\x1b[90m[scheduler] cron 已启动: ${agentId}\x1b[0m`);
  }

  // ──────────── 执行 ────────────

  /**
   * 执行某个 agent 的 cron 任务（active 或非 active 均可）
   * 同一 agent 同时只运行一个 cron，防止并发写冲突
   */
  async _executeCronJobForAgent(agentId, job) {
    if (this._executingAgents.has(agentId)) {
      console.log(`\x1b[90m[scheduler] cron 跳过 ${agentId}/${job.id}：上一个任务仍在执行\x1b[0m`);
      const err = new Error(`agent ${agentId} 正在执行另一个 cron，跳过 ${job.id}`);
      err.skipped = true;
      throw err;
    }
    this._executingAgents.add(agentId);
    try {
      const prompt = [
        `[定时任务 ${job.id}: ${job.label}]`,
        "",
        "**注意：这是系统自动触发的定时任务，不是用户发来的。**",
        "**不要在执行过程中创建新的定时任务。**",
        "",
        job.prompt,
      ].join("\n");
      await this._executeActivityForAgent(agentId, prompt, "cron", job.label, {
        model: job.model || undefined,
      });
    } finally {
      this._executingAgents.delete(agentId);
    }
  }

  /**
   * 执行活动（任意 agent，统一走 executeIsolated）
   */
  async _executeActivityForAgent(agentId, prompt, type, label, opts = {}) {
    const engine = this._engine;
    const agentDir = path.join(engine.agentsDir, agentId);
    const activityDir = path.join(agentDir, "activity");
    const startedAt = Date.now();
    const id = `${type === "heartbeat" ? "hb" : "cron"}_${startedAt}`;

    // 所有 agent 统一走 executeIsolated（支持 agentId 参数）
    const result = await engine.executeIsolated(prompt, {
      agentId,
      persist: activityDir,
      ...opts,
    });
    const { sessionPath, error } = result;

    const finishedAt = Date.now();
    const failed = !!error;

    // 取 agentName（从长驻实例获取，fallback agentId）
    const ag = engine.getAgent(agentId);
    const agentName = ag?.agentName || agentId;

    // 生成摘要
    let summary = null;
    if (typeof sessionPath === "string" && sessionPath) {
      try {
        summary = await engine.summarizeActivity(sessionPath);
      } catch {}
    }

    const entry = {
      id,
      type,
      label: label || null,
      agentId,
      agentName,
      startedAt,
      finishedAt,
      summary: failed
        ? `${label || (type === "heartbeat" ? "日常巡检" : "定时任务")} 执行失败`
        : (summary || (type === "heartbeat" ? "日常巡检" : (label || "定时任务"))),
      sessionFile: typeof sessionPath === "string" ? path.basename(sessionPath) : null,
      status: failed ? "error" : "done",
      error: error || null,
    };

    // 写入对应 agent 的 ActivityStore
    engine.getActivityStore(agentId).add(entry);

    // WS 广播
    this._hub.eventBus.emit({ type: "activity_update", activity: entry }, null);

    if (failed) {
      const reason = error || "后台任务未生成 session";
      engine.emitDevLog(`[${type}] ${label || "后台任务"} 失败: ${reason}`, "error");
      throw new Error(reason);
    }

    engine.emitDevLog(`活动记录: ${entry.summary}`, "heartbeat");
  }

  /**
   * active agent 的心跳活动（保留向后兼容）
   * 如果 agent 正在回复用户，跳过本次心跳避免资源争抢
   */
  _executeActivity(prompt, type, label, opts = {}) {
    if (this._engine.isStreaming) {
      this._engine.emitDevLog("[heartbeat] 跳过：agent 正在回复用户", "heartbeat");
      return Promise.resolve();
    }
    return this._executeActivityForAgent(this._engine.currentAgentId, prompt, type, label, opts);
  }
}
