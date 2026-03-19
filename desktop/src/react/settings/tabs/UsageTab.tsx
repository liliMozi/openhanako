import React, { useEffect, useState } from 'react';
import { hanaFetch } from '../api';
import { t } from '../helpers';

interface UsageStats {
  today: { totalTokens: number; inputTokens: number; outputTokens: number; cost: number; count: number };
  thisWeek: { totalTokens: number; inputTokens: number; outputTokens: number; cost: number; count: number };
  thisMonth: { totalTokens: number; inputTokens: number; outputTokens: number; cost: number; count: number };
  allTime: { totalTokens: number; inputTokens: number; outputTokens: number; cost: number; count: number };
  lastUpdated: string;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function StatCard({ label, stats }: { label: string; stats: UsageStats[keyof UsageStats] }) {
  return (
    <div className="usage-card">
      <div className="usage-card-label">{label}</div>
      <div className="usage-card-value">{formatTokens(stats.totalTokens)}</div>
      <div className="usage-card-sub">
        <span>输入 {formatTokens(stats.inputTokens)}</span>
        <span>输出 {formatTokens(stats.outputTokens)}</span>
      </div>
      {stats.cost > 0 && (
        <div className="usage-card-cost">$ {stats.cost.toFixed(4)}</div>
      )}
      <div className="usage-card-count">{stats.count} 次对话</div>
    </div>
  );
}

export function UsageTab() {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [resetting, setResetting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

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

  return (
    <div className="settings-tab-content active" data-tab="usage">
      <div className="settings-section">
        <div className="settings-section-header">
          <h2 className="settings-section-title">{t('settings.usage.title')}</h2>
          <button
            className="hana-btn hana-btn--ghost hana-btn--sm"
            onClick={loadUsage}
            disabled={loading}
          >
            {loading ? '…' : '↻'}
          </button>
        </div>

        <p className="settings-section-desc">
          {t('settings.usage.desc')}
        </p>

        {error && (
          <div className="settings-error">{error}</div>
        )}

        {loading ? (
          <div className="settings-loading">加载中…</div>
        ) : stats ? (
          <div className="usage-grid">
            <StatCard label={t('settings.usage.today')} stats={stats.today} />
            <StatCard label={t('settings.usage.thisWeek')} stats={stats.thisWeek} />
            <StatCard label={t('settings.usage.thisMonth')} stats={stats.thisMonth} />
            <StatCard label={t('settings.usage.allTime')} stats={stats.allTime} />
          </div>
        ) : null}

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
