/**
 * UsageTracker — Token 消耗统计 + 成本估算
 *
 * 存储结构：
 * {
 *   "lastUpdated": "2026-03-19T20:00:00.000Z",
 *   "days": {
 *     "2026-03-19": {
 *       "totalTokens": 50000, "inputTokens": 30000, "outputTokens": 20000,
 *       "cost": 0.05, "count": 10,
 *       "models": { "gpt-4o": { "totalTokens": 30000, "cost": 0.30 } },
 *       "providers": { "openai": { "totalTokens": 30000, "cost": 0.30 } }
 *     },
 *     ...
 *   },
 *   "history": [  // 近 30 天扁平记录
 *     { "date": "2026-03-19", "totalTokens": 50000, "cost": 0.05 },
 *     ...
 *   ]
 * }
 *
 * 接口：
 *   tracker.add(usage)     — 累加一条 usage（需包含 model, provider）
 *   tracker.getStats()     — 返回完整统计（含趋势、分布）
 *   tracker.reset()        — 清空所有统计
 */
import fs from "fs";
import path from "path";

const DB_FILE = "usage.json";
const HISTORY_DAYS = 30;

// ── 价格表（每百万 Token 价格 USD）─────────────────────────────────────────
const PRICE_PER_MILLION = {
  anthropic: 28,
  openai: 12,
  google: 10,
  openrouter: 12,
  volcengine: 6,
  ark: 8,
  moonshot: 6,
  siliconflow: 4,
  minimax: 8,
  "minimax-portal": 8,
  "minimax-portal-cn": 8,
  qwen: 6,
  "qwen-portal": 6,
  zhipu: 6,
  doubao: 6,
  groq: 4,
  deepgram: 10,
  cerebras: 5,
  xai: 18,
  mistral: 8,
  ollama: 0,
  kimi: 6,
  "kimi-coding": 6,
  deepseek: 6,
  openai-codex: 12,
  custom: 10,
};

// 模型匹配规则（精确匹配优先）
const MODEL_PRICE_OVERRIDES = [
  { pattern: /claude-opus|opus/i, rate: 40 },
  { pattern: /claude-sonnet|sonnet/i, rate: 12 },
  { pattern: /claude-haiku|haiku/i, rate: 3 },
  { pattern: /gpt-5/i, rate: 15 },
  { pattern: /gpt-4\.1|gpt-4o|gpt-4/i, rate: 10 },
  { pattern: /gemini/i, rate: 8 },
  { pattern: /deepseek|qwen|kimi|doubao|minimax/i, rate: 6 },
  { pattern: /llama|mistral|grok|nova/i, rate: 5 },
];

// 供应商名称映射
const PROVIDER_NAMES = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
  volcengine: "Volcengine",
  ark: "ByteDance Ark",
  moonshot: "Moonshot",
  siliconflow: "SiliconFlow",
  minimax: "MiniMax",
  "minimax-portal": "MiniMax",
  "minimax-portal-cn": "MiniMax (CN)",
  qwen: "Qwen",
  "qwen-portal": "Qwen",
  zhipu: "Zhipu (GLM)",
  doubao: "Doubao",
  groq: "Groq",
  deepgram: "Deepgram",
  cerebras: "Cerebras",
  xai: "xAI",
  mistral: "Mistral",
  ollama: "Ollama",
  kimi: "Moonshot",
  "kimi-coding": "Kimi Coding",
  deepseek: "DeepSeek",
  openai-codex: "OpenAI Codex",
  custom: "Custom",
};

// ── 工具函数 ────────────────────────────────────────────────────────────────

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function weekRange() {
  const now = new Date();
  const dayOfWeek = now.getDay() || 7;
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

/**
 * 计算成本（USD）
 * @param {number} tokens
 * @param {string} provider
 * @param {string} model
 * @returns {number}
 */
function calcCost(tokens, provider, model) {
  if (tokens <= 0 || provider === "ollama") return 0;
  const normalized = (provider || "custom").toLowerCase();
  let rate = PRICE_PER_MILLION[normalized] || 10;
  // 模型匹配优先级更高
  if (model) {
    for (const rule of MODEL_PRICE_OVERRIDES) {
      if (rule.pattern.test(model)) {
        rate = rule.rate;
        break;
      }
    }
  }
  return (tokens / 1_000_000) * rate;
}

/**
 * 获取供应商显示名
 */
function getProviderDisplayName(provider) {
  return PROVIDER_NAMES[provider] || provider || "Custom";
}

// ── UsageTracker ────────────────────────────────────────────────────────────

export class UsageTracker {
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
    return {
      lastUpdated: new Date().toISOString(),
      days: {},
      history: [],
    };
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this._dbPath), { recursive: true });
      fs.writeFileSync(this._dbPath, JSON.stringify(this._data, null, 2), "utf-8");
    } catch (err) {
      console.error("[usage-tracker] _save failed:", err.message);
    }
  }

  _ensureDay(key) {
    if (!this._data.days[key]) {
      this._data.days[key] = {
        totalTokens: 0, inputTokens: 0, outputTokens: 0,
        cost: 0, count: 0,
        models: {}, providers: {},
      };
    }
    return this._data.days[key];
  }

  /**
   * 累加一条 LLM usage
   * @param {object} usage - { input, output, totalTokens, cost, model, provider }
   */
  add(usage) {
    if (!usage || typeof usage !== "object") return;
    const key = todayKey();
    const d = this._ensureDay(key);

    const input = usage.input || 0;
    const output = usage.output || 0;
    const totalTokens = usage.totalTokens || (input + output);
    const cost = usage.cost || 0;
    const model = usage.model || "unknown";
    const provider = usage.provider || "custom";

    // 按模型聚合
    if (!d.models[model]) {
      d.models[model] = { totalTokens: 0, cost: 0 };
    }
    d.models[model].totalTokens += totalTokens;
    d.models[model].cost += cost;

    // 按供应商聚合
    if (!d.providers[provider]) {
      d.providers[provider] = { totalTokens: 0, cost: 0 };
    }
    d.providers[provider].totalTokens += totalTokens;
    d.providers[provider].cost += cost;

    // 累计
    d.inputTokens += input;
    d.outputTokens += output;
    d.totalTokens += totalTokens;
    d.cost += cost;
    d.count += 1;

    // 更新历史（近 30 天）
    this._updateHistory(key, totalTokens, cost);

    this._data.lastUpdated = new Date().toISOString();
    this._save();
  }

  _updateHistory(date, tokens, cost) {
    const existing = this._data.history.find(h => h.date === date);
    if (existing) {
      existing.totalTokens += tokens;
      existing.cost += cost;
    } else {
      this._data.history.push({ date, totalTokens: tokens, cost });
    }
    // 保持近 30 天
    if (this._data.history.length > HISTORY_DAYS) {
      this._data.history = this._data.history.slice(-HISTORY_DAYS);
    }
    // 按日期排序
    this._data.history.sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * 获取完整统计
   */
  getStats() {
    const today = todayKey();
    const week = weekRange();
    const month = monthRange();
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();

    // 近 7 天趋势
    const recent7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateKey = d.toISOString().slice(0, 10);
      const dayData = this._data.days[dateKey] || { totalTokens: 0, cost: 0 };
      recent7Days.push({
        date: dateKey,
        dayLabel: `${d.getMonth() + 1}/${d.getDate()}`,
        totalTokens: dayData.totalTokens || 0,
        costUsd: dayData.cost || 0,
        isToday: i === 0,
      });
    }

    // 合并本周/本月统计
    const mergeDayStats = (start, end) => {
      const result = { totalTokens: 0, cost: 0, count: 0 };
      for (const [dateKey, d] of Object.entries(this._data.days)) {
        if (dateKey >= start && dateKey <= end) {
          result.totalTokens += d.totalTokens || 0;
          result.cost += d.cost || 0;
          result.count += d.count || 0;
        }
      }
      return result;
    };

    const todayStats = this._data.days[today] || { totalTokens: 0, cost: 0, count: 0 };
    const weekStats = mergeDayStats(week.start, week.end);
    const monthStats = mergeDayStats(month.start, month.end);

    // 计算昨天/上周数据（用于趋势）
    const yesterdayKey = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const yesterdayStats = this._data.days[yesterdayKey] || { totalTokens: 0, cost: 0 };
    
    const lastWeekStart = new Date();
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);
    const lastWeekEnd = new Date();
    lastWeekEnd.setDate(lastWeekEnd.getDate() - 1);
    const lastWeekStats = mergeDayStats(
      lastWeekStart.toISOString().slice(0, 10),
      lastWeekEnd.toISOString().slice(0, 10)
    );

    // 模型成本分布（Top 6）
    const modelCosts = {};
    for (const [dateKey, d] of Object.entries(this._data.days)) {
      if (dateKey >= month.start && dateKey <= month.end) {
        for (const [model, stats] of Object.entries(d.models || {})) {
          if (!modelCosts[model]) modelCosts[model] = { totalTokens: 0, cost: 0 };
          modelCosts[model].totalTokens += stats.totalTokens || 0;
          modelCosts[model].cost += stats.cost || 0;
        }
      }
    }
    const modelCostList = Object.entries(modelCosts)
      .map(([model, stats]) => ({ model, cost: stats.cost }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 6);
    const totalModelCost = modelCostList.reduce((sum, m) => sum + m.cost, 0);

    // 供应商成本分布（Top 8）
    const providerCosts = {};
    for (const [dateKey, d] of Object.entries(this._data.days)) {
      if (dateKey >= month.start && dateKey <= month.end) {
        for (const [provider, stats] of Object.entries(d.providers || {})) {
          if (!providerCosts[provider]) providerCosts[provider] = { totalTokens: 0, cost: 0 };
          providerCosts[provider].totalTokens += stats.totalTokens || 0;
          providerCosts[provider].cost += stats.cost || 0;
        }
      }
    }
    const providerCostList = Object.entries(providerCosts)
      .map(([provider, stats]) => ({ provider, cost: stats.cost }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 8);

    // 计算趋势百分比
    const calcTrend = (current, previous) => {
      if (previous <= 0) return current > 0 ? 100 : 0;
      return Math.round(((current - previous) / previous) * 10000) / 100;
    };

    // 月度预测（基于已有天数）
    const monthForecast = dayOfMonth > 0 ? (monthStats.cost / dayOfMonth) * daysInMonth : 0;

    return {
      // 核心指标
      today: {
        totalTokens: todayStats.totalTokens || 0,
        cost: todayStats.cost || 0,
        count: todayStats.count || 0,
        trend: calcTrend(todayStats.cost || 0, yesterdayStats.cost || 0),
      },
      week: {
        totalTokens: weekStats.totalTokens,
        cost: weekStats.cost,
        count: weekStats.count,
        trend: calcTrend(weekStats.cost, lastWeekStats.cost),
      },
      month: {
        totalTokens: monthStats.totalTokens,
        cost: monthStats.cost,
        count: monthStats.count,
        forecast: Math.round(monthForecast * 10000) / 10000,
      },
      // 近 7 天趋势
      recent7Days,
      // 分布
      modelCosts: modelCostList.map(m => ({
        model: m.model,
        cost: Math.round(m.cost * 10000) / 10000,
        percentage: totalModelCost > 0 ? Math.round((m.cost / totalModelCost) * 10000) / 100 : 0,
        displayName: m.model.split("/").pop() || m.model,
      })),
      providerCosts: providerCostList.map(p => ({
        provider: p.provider,
        cost: Math.round(p.cost * 10000) / 10000,
        displayName: getProviderDisplayName(p.provider),
      })),
      // 元数据
      lastUpdated: this._data.lastUpdated,
      actualDays: Object.keys(this._data.days).filter(k => k >= month.start && k <= month.end).length,
    };
  }

  /** 清空所有统计 */
  reset() {
    this._data = { lastUpdated: new Date().toISOString(), days: {}, history: [] };
    this._save();
  }
}
