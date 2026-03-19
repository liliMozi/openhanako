import React, { useEffect, useState, useMemo } from 'react';
import { hanaFetch } from '../api';
import { t } from '../helpers';

// ── 类型定义 ────────────────────────────────────────────────────────────────

interface DayTrend {
  date: string;
  dayLabel: string;
  totalTokens: number;
  costUsd: number;
  isToday?: boolean;
}

interface ModelCost {
  model: string;
  cost: number;
  percentage: number;
  displayName: string;
}

interface ProviderCost {
  provider: string;
  cost: number;
  displayName: string;
}

interface UsageStats {
  today: { totalTokens: number; cost: number; count: number; trend: number };
  week: { totalTokens: number; cost: number; count: number; trend: number };
  month: { totalTokens: number; cost: number; count: number; forecast: number };
  recent7Days: DayTrend[];
  modelCosts: ModelCost[];
  providerCosts: ProviderCost[];
  actualDays: number;
  lastUpdated: string;
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(cny: number): string {
  return `¥${cny.toFixed(2)}`;
}

function formatTrend(trend: number): string {
  const sign = trend >= 0 ? '+' : '';
  return `${sign}${trend.toFixed(1)}%`;
}

// CNY 汇率估算（1 USD ≈ 7.2 CNY）
const USD_TO_CNY = 7.2;

function usdToCny(usd: number): number {
  return usd * USD_TO_CNY;
}

// ── 颜色工具 ────────────────────────────────────────────────────────────────

function getBarColor(ratio: number): string {
  if (ratio === 0) return 'var(--overlay-light)';
  if (ratio < 0.2) return '#fef3c7'; // yellow-100
  if (ratio < 0.4) return '#fcd34d'; // yellow-300
  if (ratio < 0.6) return '#f59e0b'; // yellow-500
  if (ratio < 0.8) return '#d97706'; // yellow-600
  return '#b45309'; // yellow-700
}

// ── 组件 ──────────────────────────────────────────────────────────────────

function StatCard({ 
  label, 
  value, 
  trend, 
  subtitle, 
  note 
}: { 
  label: string; 
  value: string; 
  trend?: number; 
  subtitle?: string; 
  note?: string;
}) {
  const hasTrend = trend !== undefined && trend !== 0;
  const isUp = trend !== undefined && trend > 0;

  return (
    <div className="usage-stat-card">
      <div className="usage-stat-label">{label}</div>
      <div className="usage-stat-value">{value}</div>
      {hasTrend && (
        <div className={`usage-stat-trend ${isUp ? 'up' : 'down'}`}>
          <span className="usage-stat-trend-arrow">{isUp ? '↑' : '↓'}</span>
          <span>{formatTrend(Math.abs(trend))}</span>
        </div>
      )}
      {subtitle && <div className="usage-stat-subtitle">{subtitle}</div>}
      {note && <div className="usage-stat-note">{note}</div>}
    </div>
  );
}

function BarChart({ data, maxCost }: { data: DayTrend[]; maxCost: number }) {
  return (
    <div className="usage-bar-chart">
      {data.map((day, i) => {
        const ratio = maxCost > 0 ? day.costUsd / maxCost : 0;
        const color = getBarColor(ratio);
        return (
          <div key={day.date} className="usage-bar-item">
            <div className="usage-bar-wrapper">
              <div 
                className="usage-bar" 
                style={{ 
                  height: `${Math.max(ratio * 100, 4)}%`,
                  backgroundColor: color,
                }}
              >
                {day.costUsd > 0 && (
                  <span className="usage-bar-value">
                    ${day.costUsd.toFixed(2)}
                  </span>
                )}
              </div>
            </div>
            <div className={`usage-bar-label ${day.isToday ? 'today' : ''}`}>
              {day.dayLabel}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CostDistribution({ 
  title, 
  items, 
  type 
}: { 
  title: string; 
  items: ModelCost[] | ProviderCost[]; 
  type: 'model' | 'provider';
}) {
  const totalCost = items.reduce((sum, item) => sum + item.cost, 0);
  const maxCost = items.length > 0 ? Math.max(...items.map(i => i.cost)) : 0;

  return (
    <div className="usage-distribution">
      <div className="usage-distribution-title">{title}</div>
      {items.length === 0 ? (
        <div className="usage-distribution-empty">暂无数据</div>
      ) : (
        <div className="usage-distribution-list">
          {items.map((item, i) => {
            const displayName = type === 'model' 
              ? (item as ModelCost).displayName 
              : (item as ProviderCost).displayName;
            const percentage = type === 'model' 
              ? (item as ModelCost).percentage 
              : (totalCost > 0 ? (item.cost / totalCost) * 100 : 0);
            const ratio = maxCost > 0 ? item.cost / maxCost : 0;
            const isTop = i === 0;

            return (
              <div key={item.model || item.provider} className={`usage-distribution-item ${isTop ? 'top' : ''}`}>
                <div className="usage-distribution-info">
                  <span className="usage-distribution-name">{displayName}</span>
                  <span className="usage-distribution-amount">
                    {formatCost(usdToCny(item.cost))}
                  </span>
                </div>
                <div className="usage-distribution-bar-wrapper">
                  <div 
                    className="usage-distribution-bar"
                    style={{ 
                      width: `${Math.max(ratio * 100, 2)}%`,
                      backgroundColor: isTop ? 'var(--accent, #f59e0b)' : 'var(--text-muted, #9ca3af)',
                    }}
                  />
                </div>
                <span className="usage-distribution-pct">{percentage.toFixed(1)}%</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── 主组件 ──────────────────────────────────────────────────────────────────

export function UsageTab() {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [resetting, setResetting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showEstimateNote, setShowEstimateNote] = useState(false);

  async function loadUsage() {
    setLoading(true);
    setError('');
    try {
      const res = await hanaFetch('/api/usage');
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setStats(data);
      }
    } catch (e: any) {
      setError(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsage();
  }, []);

  async function handleReset() {
    setResetting(true);
    try {
      await hanaFetch('/api/usage', { method: 'DELETE' });
      setShowConfirm(false);
      await loadUsage();
    } catch (e: any) {
      setError(e.message || '重置失败');
    } finally {
      setResetting(false);
    }
  }

  // 计算 7 天最大值
  const maxDayCost = useMemo(() => {
    if (!stats?.recent7Days) return 0;
    return Math.max(...stats.recent7Days.map(d => d.costUsd), 0.01);
  }, [stats?.recent7Days]);

  return (
    <div className="settings-tab-content active" data-tab="usage">
      <div className="usage-container">
        {/* 标题 */}
        <div className="usage-header">
          <div className="usage-header-left">
            <h2 className="usage-title">{t('settings.usage.title')}</h2>
            <button
              className="hana-btn hana-btn--ghost hana-btn--sm"
              onClick={loadUsage}
              disabled={loading}
            >
              {loading ? '…' : '↻'}
            </button>
          </div>
          <div className="usage-header-right">
            <span className="usage-info-icon" title="此模块仅用于发朋友圈">ℹ️</span>
          </div>
        </div>

        {error && <div className="settings-error">{error}</div>}

        {loading ? (
          <div className="settings-loading">加载中…</div>
        ) : stats ? (
          <>
            {/* 四个指标卡片 */}
            <div className="usage-stats-grid">
              <StatCard
                label="今日成本"
                value={formatCost(usdToCny(stats.today.cost))}
                trend={stats.today.trend}
                subtitle={`${formatTokens(stats.today.totalTokens)} tokens`}
              />
              <StatCard
                label="本周成本"
                value={formatCost(usdToCny(stats.week.cost))}
                trend={stats.week.trend}
                subtitle={`${formatTokens(stats.week.totalTokens)} tokens`}
              />
              <StatCard
                label={`${new Date().getFullYear()}年${new Date().getMonth() + 1}月成本`}
                value={formatCost(usdToCny(stats.month.cost))}
                subtitle={`${formatTokens(stats.month.totalTokens)} tokens`}
              />
              <StatCard
                label="月度预测"
                value={formatCost(usdToCny(stats.month.forecast))}
                note={`基于 ${stats.actualDays} 天实际数据`}
              />
            </div>

            {/* 近 7 天趋势 */}
            <div className="usage-section">
              <div className="usage-section-header">
                <h3 className="usage-section-title">近 7 天成本趋势</h3>
                <span className="usage-section-badge">USD</span>
              </div>
              <BarChart data={stats.recent7Days} maxCost={maxDayCost} />
            </div>

            {/* 分布 */}
            <div className="usage-distribution-grid">
              <CostDistribution
                title="模型成本分布"
                items={stats.modelCosts}
                type="model"
              />
              <CostDistribution
                title="供应商成本分布"
                items={stats.providerCosts}
                type="provider"
              />
            </div>

            {/* 估算说明 */}
            <div 
              className="usage-estimate-note"
              onClick={() => setShowEstimateNote(!showEstimateNote)}
            >
              <span className="usage-estimate-icon">ℹ️</span>
              <span className="usage-estimate-text">
                部分数据基于估算（价格来源于公开定价，仅供参考）
              </span>
              <span className="usage-estimate-arrow">{showEstimateNote ? '▼' : '▶'}</span>
            </div>
            {showEstimateNote && (
              <div className="usage-estimate-detail">
                实际成本可能有所差异，请以供应商账单为准。
              </div>
            )}
          </>
        ) : null}

        {/* 底部操作 */}
        <div className="usage-footer">
          <p className="usage-note">
            {t('settings.usage.note')}
          </p>
          <button
            className="hana-btn hana-btn--danger hana-btn--sm"
            onClick={() => setShowConfirm(true)}
          >
            {t('settings.usage.reset')}
          </button>
        </div>
      </div>

      {showConfirm && (
        <div className="hana-warning-overlay" onClick={() => setShowConfirm(false)}>
          <div className="hana-warning-box" onClick={e => e.stopPropagation()}>
            <h3 className="hana-warning-title">{t('settings.usage.resetConfirmTitle')}</h3>
            <p className="hana-warning-body">{t('settings.usage.resetConfirmBody')}</p>
            <div className="hana-warning-actions">
              <button className="hana-warning-cancel" onClick={() => setShowConfirm(false)}>
                {t('settings.usage.cancel')}
              </button>
              <button className="hana-warning-confirm" onClick={handleReset} disabled={resetting}>
                {resetting ? '…' : t('settings.usage.confirmReset')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
