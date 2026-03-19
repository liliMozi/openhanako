/**
 * UsageTracker — 累计 Token 消耗统计
 *
 * 存储结构（JSON，按天聚合）：
 * {
 *   "lastUpdated": "2026-03-19T20:00:00.000Z",
 *   "days": {
 *     "2026-03-19": { "totalTokens": 50000, "inputTokens": 30000, "outputTokens": 20000, "cost": 0.05 },
 *     ...
 *   }
 * }
 *
 * 接口：
 *   tracker.add(usage)     — 累加一条 usage
 *   tracker.getStats()    — 返回 { today, thisWeek, thisMonth, allTime }
 *   tracker.reset()       — 清空所有统计
 */
import fs from "fs";
import path from "path";

const DB_FILE = "usage.json";

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function weekRange() {
  const now = new Date();
  const dayOfWeek = now.getDay() || 7; // 周日=7
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + 1);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}

function monthRange() {
  const now = new Date();
  const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const end = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
}

function daysInRange(days, start, end) {
  return Object.entries(days)
    .filter(([k]) => k >= start && k <= end)
    .reduce((acc, [, v]) => {
      acc.totalTokens += v.totalTokens || 0;
      acc.inputTokens += v.inputTokens || 0;
      acc.outputTokens += v.outputTokens || 0;
      acc.cacheReadTokens += v.cacheReadTokens || 0;
      acc.cacheWriteTokens += v.cacheWriteTokens || 0;
      acc.cost += v.cost || 0;
      acc.count += 1;
      return acc;
    }, { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, count: 0 });
}

export class UsageTracker {
  /**
   * @param {string} dataDir - 存放 usage.json 的目录（如 engine.userDir）
   */
  constructor(dataDir) {
    this._dbPath = path.join(dataDir, DB_FILE);
    this._data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this._dbPath)) {
        const raw = fs.readFileSync(this._dbPath, "utf-8");
        return JSON.parse(raw);
      }
    } catch {}
    return { lastUpdated: new Date().toISOString(), days: {} };
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this._dbPath), { recursive: true });
      fs.writeFileSync(this._dbPath, JSON.stringify(this._data, null, 2), "utf-8");
    } catch (err) {
      console.error("[usage-tracker] _save failed:", err.message);
    }
  }

  /**
   * 累加一条 LLM usage
   * @param {object} usage - { input, output, cacheRead, cacheWrite, totalTokens, cost }
   */
  add(usage) {
    if (!usage || typeof usage !== "object") return;
    const key = todayKey();
    if (!this._data.days[key]) {
      this._data.days[key] = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, count: 0 };
    }
    const d = this._data.days[key];
    const input = usage.input || 0;
    const output = usage.output || 0;
    const cacheRead = usage.cacheRead || 0;
    const cacheWrite = usage.cacheWrite || 0;
    const totalTokens = usage.totalTokens || (input + output + cacheRead + cacheWrite);
    const cost = usage.cost?.total || usage.cost || 0;

    d.inputTokens += input;
    d.outputTokens += output;
    d.cacheReadTokens += cacheRead;
    d.cacheWriteTokens += cacheWrite;
    d.totalTokens += totalTokens;
    d.cost += cost;
    d.count += 1;

    this._data.lastUpdated = new Date().toISOString();
    this._save();
  }

  /**
   * 获取分时段统计
   * @returns {{ today: object, thisWeek: object, thisMonth: object, allTime: object }}
   */
  getStats() {
    const today = todayKey();
    const week = weekRange();
    const month = monthRange();

    const todayStats = this._data.days[today] || { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, count: 0 };
    const weekStats = daysInRange(this._data.days, week.start, week.end);
    const monthStats = daysInRange(this._data.days, month.start, month.end);
    const allTime = Object.values(this._data.days).reduce((acc, d) => {
      acc.totalTokens += d.totalTokens || 0;
      acc.inputTokens += d.inputTokens || 0;
      acc.outputTokens += d.outputTokens || 0;
      acc.cacheReadTokens += d.cacheReadTokens || 0;
      acc.cacheWriteTokens += d.cacheWriteTokens || 0;
      acc.cost += d.cost || 0;
      acc.count += d.count || 0;
      return acc;
    }, { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, count: 0 });

    return {
      today: todayStats,
      thisWeek: weekStats,
      thisMonth: monthStats,
      allTime,
      lastUpdated: this._data.lastUpdated,
    };
  }

  /** 清空所有统计 */
  reset() {
    this._data = { lastUpdated: new Date().toISOString(), days: {} };
    this._save();
  }
}
