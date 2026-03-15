/**
 * cron-store.js — 定时任务存储
 *
 * 管理 cron job 的 CRUD 和运行历史。
 * 调度逻辑在 cron-scheduler.js，这里只负责持久化。
 *
 * 参考 OpenClaw：jobs.json + runs/<jobId>.jsonl
 *
 * Job 类型：
 * - "at"：一次性任务（schedule = ISO 时间字符串）
 * - "every"：间隔任务（schedule = 毫秒数，如 3600000 = 1小时）
 * - "cron"：标准 cron 表达式（schedule = "0 7 * * *"）
 */

import fs from "fs";
import path from "path";

export class CronStore {
  /**
   * @param {string} jobsPath - cron-jobs.json 路径
   * @param {string} runsDir  - cron-runs/ 目录路径
   */
  constructor(jobsPath, runsDir) {
    this._jobsPath = jobsPath;
    this._runsDir = runsDir;
    this._jobs = [];
    this._nextNum = 1;
    this._load();
  }

  // ════════════════════════════
  //  持久化
  // ════════════════════════════

  _load() {
    try {
      const raw = fs.readFileSync(this._jobsPath, "utf-8");
      const data = JSON.parse(raw);
      this._jobs = Array.isArray(data.jobs) ? data.jobs : [];
      this._nextNum = data.nextNum ?? (this._jobs.length + 1);
    } catch {
      this._jobs = [];
      this._nextNum = 1;
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this._jobsPath), { recursive: true });
    const data = JSON.stringify({
      jobs: this._jobs,
      nextNum: this._nextNum,
    }, null, 2) + "\n";
    // atomic write: tmp + rename，防止写到一半崩溃损坏文件
    const tmpPath = this._jobsPath + ".tmp";
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, this._jobsPath);
  }

  // ════════════════════════════
  //  Job CRUD
  // ════════════════════════════

  /**
   * 添加任务
   * @param {object} opts
   * @param {"at"|"every"|"cron"} opts.type - 调度类型
   * @param {string|number} opts.schedule - 调度参数
   * @param {string} opts.prompt - 执行时的 prompt
   * @param {string} [opts.mode="isolated"] - 执行模式
   * @param {string} [opts.label] - 显示标签
   * @param {string} [opts.model] - 指定模型（为空则用 agent 默认模型）
   * @returns {object} 新建的 job
   */
  addJob({ type, schedule, prompt, mode = "isolated", label = "", model = "" }) {
    const id = `job_${this._nextNum++}`;
    const now = new Date().toISOString();

    const job = {
      id,
      type,
      schedule,
      prompt,
      mode,
      label: label || prompt.slice(0, 30),
      model: model || "",
      enabled: true,
      createdAt: now,
      lastRunAt: null,
      nextRunAt: this._calcNextRun(type, schedule, now),
    };

    this._jobs.push(job);
    this._save();
    return job;
  }

  /**
   * 删除任务
   * @param {string} id
   * @returns {boolean}
   */
  removeJob(id) {
    const idx = this._jobs.findIndex(j => j.id === id);
    if (idx === -1) return false;
    this._jobs.splice(idx, 1);
    this._save();
    return true;
  }

  /**
   * 获取单个任务
   * @param {string} id
   * @returns {object|null}
   */
  getJob(id) {
    return this._jobs.find(j => j.id === id) || null;
  }

  /**
   * 列出所有任务（每次从磁盘重读，确保跨实例的写入都能被感知）
   * @returns {object[]}
   */
  listJobs() {
    this._load();
    return [...this._jobs];
  }

  /**
   * 更新任务字段
   * @param {string} id
   * @param {object} partial
   * @returns {object|null}
   */
  updateJob(id, partial) {
    const job = this._jobs.find(j => j.id === id);
    if (!job) return null;
    Object.assign(job, partial);
    this._save();
    return job;
  }

  /**
   * 切换任务启用/禁用
   * @param {string} id
   * @returns {object|null}
   */
  toggleJob(id) {
    const job = this._jobs.find(j => j.id === id);
    if (!job) return null;
    job.enabled = !job.enabled;
    if (job.enabled) {
      // 重新计算下次执行时间
      job.nextRunAt = this._calcNextRun(job.type, job.schedule, new Date().toISOString());
    }
    this._save();
    return job;
  }

  /**
   * 标记任务已执行，更新 lastRunAt + nextRunAt
   * @param {string} id
   */
  markRun(id) {
    const job = this._jobs.find(j => j.id === id);
    if (!job) return;
    const now = new Date().toISOString();
    job.lastRunAt = now;
    job.nextRunAt = this._calcNextRun(job.type, job.schedule, now);

    // "at" 类型执行一次后自动禁用
    if (job.type === "at") {
      job.enabled = false;
    }

    this._save();
  }

  // ════════════════════════════
  //  运行历史
  // ════════════════════════════

  /**
   * 记录一次运行
   * @param {string} jobId
   * @param {object} run - { status, startedAt, finishedAt, error? }
   */
  logRun(jobId, run) {
    const filePath = path.join(this._runsDir, `${jobId}.jsonl`);
    const line = JSON.stringify({ ...run, timestamp: new Date().toISOString() }) + "\n";
    fs.mkdirSync(this._runsDir, { recursive: true });
    fs.appendFileSync(filePath, line, "utf-8");
  }

  /**
   * 读取运行历史
   * @param {string} jobId
   * @param {number} [limit=20]
   * @returns {object[]}
   */
  getRunHistory(jobId, limit = 20) {
    const filePath = path.join(this._runsDir, `${jobId}.jsonl`);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      return lines
        .slice(-limit)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  // ════════════════════════════
  //  调度计算
  // ════════════════════════════

  /**
   * 计算下次执行时间
   * @param {"at"|"every"|"cron"} type
   * @param {string|number} schedule
   * @param {string} fromISO - 基准时间（ISO string）
   * @returns {string|null} ISO string
   */
  _calcNextRun(type, schedule, fromISO) {
    const from = new Date(fromISO);

    switch (type) {
      case "at": {
        // 一次性：schedule 就是目标时间
        const target = new Date(schedule);
        return target > from ? target.toISOString() : null;
      }

      case "every": {
        // 间隔：从现在起 schedule 毫秒后
        const ms = typeof schedule === "number" ? schedule : parseInt(schedule, 10);
        if (isNaN(ms) || ms <= 0) return null;
        return new Date(from.getTime() + ms).toISOString();
      }

      case "cron": {
        // 简易 cron 解析：支持 "M H * * *" 格式（每天 H:M）
        // 完整 cron 解析需要库，v1 先支持每日定时
        return this._parseSimpleCron(schedule, from);
      }

      default:
        return null;
    }
  }

  /**
   * 简易 cron 解析（v1：支持 "M H * * *" 每日定时）
   * @param {string} expr - cron 表达式
   * @param {Date} from - 基准时间
   * @returns {string|null}
   */
  _parseSimpleCron(expr, from) {
    const parts = expr.trim().split(/\s+/);
    if (parts.length < 5) return null;

    const [minute, hour] = parts;
    if (minute === "*" || hour === "*") {
      // 暂不支持更复杂的 cron，返回 1 小时后
      return new Date(from.getTime() + 3600_000).toISOString();
    }

    const m = parseInt(minute, 10);
    const h = parseInt(hour, 10);
    if (isNaN(m) || isNaN(h)) return null;

    // 计算今天或明天的目标时间
    const target = new Date(from);
    target.setHours(h, m, 0, 0);
    if (target <= from) {
      target.setDate(target.getDate() + 1);
    }
    return target.toISOString();
  }

  /** 任务数量 */
  get size() {
    return this._jobs.length;
  }

  /** 启用的任务数量 */
  get enabledCount() {
    return this._jobs.filter(j => j.enabled).length;
  }
}
