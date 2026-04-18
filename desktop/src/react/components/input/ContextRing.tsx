import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../../stores';
import { useI18n } from '../../hooks/use-i18n';
import { getWebSocket } from '../../services/websocket';
import styles from './InputArea.module.css';

export function ContextRing() {
  const { t } = useI18n();
  const agentYuan = useStore(s => s.agentYuan);
  const [tokens, setTokens] = useState<number | null>(null);
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [hovered, setHovered] = useState(false);

  // 从 Zustand store 同步 context 数据（keyed store 优先，compat global 兜底）
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const contextEntry = useStore(s => s.contextBySession[s.currentSessionPath || '']);
  const globalContextTokens = useStore(s => s.contextTokens);
  const globalContextWindow = useStore(s => s.contextWindow);
  const globalContextPercent = useStore(s => s.contextPercent);
  const storeContextTokens = contextEntry?.tokens ?? globalContextTokens;
  const storeContextWindow = contextEntry?.window ?? globalContextWindow;
  const storeContextPercent = contextEntry?.percent ?? globalContextPercent;
  const storeCompacting = useStore(s => currentSessionPath ? s.compactingSessions.includes(currentSessionPath) : false);

  useEffect(() => {
    if (storeContextTokens != null) {
      setTokens(storeContextTokens);
      setContextWindow(storeContextWindow);
      setPercent(storeContextPercent);
    } else {
      setTokens(null);
    }
    setCompacting(storeCompacting);
  }, [storeContextTokens, storeContextWindow, storeContextPercent, storeCompacting]);

  const handleClick = useCallback(() => {
    if (compacting) return;
    const ws = getWebSocket();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'compact', sessionPath: useStore.getState().currentSessionPath }));
    }
  }, [compacting]);

  const pct = percent ?? 0;
  if (tokens == null) return null;
  // 压缩中保留显示以给出反馈，否则低于 50% 隐藏
  if (!compacting && pct < 50) return null;

  // SVG 圆环参数（更小更粗）
  const r = 6;
  const sw = 2.5;
  const size = (r + sw) * 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * r;
  const strokeDashoffset = circumference * (1 - Math.min(pct, 100) / 100);
  const yuan = agentYuan || 'hanako';

  // token 数量格式化
  const tokensK = Math.round(tokens / 1000);
  const windowK = contextWindow != null ? Math.round(contextWindow / 1000) : 0;

  return (
    <span className={styles['context-ring-wrap']}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        className={`${styles['context-ring']}${compacting ? ` ${styles.compacting}` : ''}`}
        data-yuan={yuan}
        onClick={handleClick}
        disabled={compacting}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={center} cy={center} r={r} fill="none" stroke="var(--ring-bg)" strokeWidth={sw} />
          <circle
            cx={center} cy={center} r={r}
            fill="none"
            stroke="var(--ring-fg)"
            strokeWidth={sw}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            transform={`rotate(-90 ${center} ${center})`}
            className={styles['context-ring-progress']}
          />
        </svg>
      </button>
      {hovered && (
        <div className={styles['context-ring-tooltip']}>
          <div>{t('input.contextWindow', { windowK })}</div>
          <div>{t('input.tokensUsed', { tokensK, pct: Math.round(pct) })}</div>
        </div>
      )}
    </span>
  );
}
