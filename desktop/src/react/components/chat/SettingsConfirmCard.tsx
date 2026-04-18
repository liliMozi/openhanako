/**
 * SettingsConfirmCard — 设置修改确认卡片
 *
 * 三种控件：toggle / list / text
 * 用户可编辑后确认/取消，通过 REST API resolve 阻塞的 tool Promise。
 */

import { memo, useState, useCallback, useMemo } from 'react';
import styles from './Chat.module.css';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';

interface Props {
  confirmId?: string;
  settingKey: string;
  cardType: 'toggle' | 'list' | 'text';
  currentValue: string;
  proposedValue: string;
  options?: string[];
  optionLabels?: Record<string, string>;
  label: string;
  description?: string;
  status: 'pending' | 'confirmed' | 'rejected' | 'timeout';
}

const THEME_I18N: Record<string, string> = {
  'warm-paper': 'settings.appearance.warmPaper',
  'midnight': 'settings.appearance.midnight',
  'high-contrast': 'settings.appearance.highContrast',
  'grass-aroma': 'settings.appearance.grassAroma',
  'contemplation': 'settings.appearance.contemplation',
  'absolutely': 'settings.appearance.absolutely',
  'delve': 'settings.appearance.delve',
  'deep-think': 'settings.appearance.deepThink',
  'auto': 'settings.appearance.auto',
};

const THINKING_I18N: Record<string, string> = {
  'auto': 'settings.agent.thinkingLevels.auto',
  'off': 'settings.agent.thinkingLevels.off',
  'low': 'settings.agent.thinkingLevels.low',
  'medium': 'settings.agent.thinkingLevels.medium',
  'high': 'settings.agent.thinkingLevels.high',
};

const LOCALE_LABELS: Record<string, string> = {
  'zh-CN': '简体中文', 'zh-TW': '繁體中文', 'ja': '日本語', 'ko': '한국어', 'en': 'English',
};

const SETTING_LABEL_KEYS: Record<string, string> = {
  'sandbox': 'toolDef.updateSettings.sandbox',
  'locale': 'toolDef.updateSettings.locale',
  'timezone': 'toolDef.updateSettings.timezone',
  'thinking_level': 'toolDef.updateSettings.thinkingBudget',
  'memory.enabled': 'toolDef.updateSettings.memory',
  'agent.name': 'toolDef.updateSettings.agentName',
  'user.name': 'toolDef.updateSettings.userName',
  'home_folder': 'toolDef.updateSettings.workingDir',
  'theme': 'toolDef.updateSettings.theme',
  'models.chat': 'toolDef.updateSettings.chatModel',
};

function toggleLabel(from: string, to: string, t: (k: string) => string): string {
  const f = from === 'true' ? t('common.on') : t('common.off');
  const toLabel = to === 'true' ? t('common.on') : t('common.off');
  return `${f} → ${toLabel}`;
}

export const SettingsConfirmCard = memo(function SettingsConfirmCard(props: Props) {
  const { confirmId, settingKey, cardType, currentValue, proposedValue, options, optionLabels: externalLabels, label, description, status: initialStatus } = props;
  const { t } = useI18n();
  const [status, setStatus] = useState(initialStatus);
  const [editValue, setEditValue] = useState(proposedValue);

  // 本地化标签：优先用外部传入的，否则卡片自行查 i18n
  const optionLabels = useMemo(() => {
    if (externalLabels && Object.keys(externalLabels).length) return externalLabels;
    if (settingKey === 'theme') return Object.fromEntries(Object.entries(THEME_I18N).map(([k, v]) => [k, t(v)]));
    if (settingKey === 'thinking_level') return Object.fromEntries(Object.entries(THINKING_I18N).map(([k, v]) => [k, t(v)]));
    if (settingKey === 'locale') return LOCALE_LABELS;
    return undefined;
  }, [externalLabels, settingKey, t]);

  // 设置项标签：优先用外部传入的，否则自行查 i18n
  const displayLabel = useMemo(() => {
    if (label && label !== settingKey) return label;
    const key = SETTING_LABEL_KEYS[settingKey];
    return key ? t(key) : label;
  }, [label, settingKey, t]);

  const handleConfirm = useCallback(async () => {
    try {
      await hanaFetch(`/api/confirm/${confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirmed', value: editValue }),
      });
      setStatus('confirmed');
    } catch { /* silent */ }
  }, [confirmId, editValue]);

  const handleReject = useCallback(async () => {
    try {
      await hanaFetch(`/api/confirm/${confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rejected' }),
      });
      setStatus('rejected');
    } catch { /* silent */ }
  }, [confirmId]);

  // ── 已完成状态 ──
  if (status !== 'pending') {
    if (status === 'confirmed' && cardType === 'toggle') {
      return (
        <div className={`${styles.settingsConfirmCard} ${styles.settingsConfirmCardDone}`}>
          <div className={styles.settingsConfirmHeader}>
            <span className={styles.settingsConfirmLabel}>{displayLabel}</span>
            <div className={`hana-toggle${editValue === 'true' ? ' on' : ''}`} style={{ pointerEvents: 'none' }}>
              <div className="hana-toggle-thumb" />
            </div>
          </div>
          <div className={styles.settingsConfirmNote}>{toggleLabel(currentValue, editValue, t)}</div>
        </div>
      );
    }
    const displayValue = optionLabels?.[editValue] || editValue;
    const statusText = status === 'confirmed' ? `${displayLabel} → ${displayValue}`
      : status === 'rejected' ? t('common.changeRejected').replace('{label}', displayLabel)
      : t('common.changeTimeout').replace('{label}', displayLabel);
    const statusClass = status === 'confirmed' ? 'confirmed' : 'rejected';
    return (
      <div className={`${styles.settingsConfirmCard} ${styles.settingsConfirmCardDone}`}>
        <div className={`${styles.settingsConfirmStatus} ${statusClass === 'confirmed' ? styles.settingsConfirmStatusConfirmed : ''}`}>
          <span>{statusText}</span>
          {status === 'confirmed' ? (
            <svg className={styles.settingsConfirmIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg className={styles.settingsConfirmIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          )}
        </div>
      </div>
    );
  }

  // ── Pending 状态 ──
  return (
    <div className={styles.settingsConfirmCard}>
      {cardType === 'toggle' ? (
        <>
          <div className={styles.settingsConfirmHeader} onClick={() => setEditValue(editValue === 'true' ? 'false' : 'true')} style={{ cursor: 'pointer' }}>
            <div>
              <div className={styles.settingsConfirmLabel}>{displayLabel}</div>
              {description && <div className={styles.settingsConfirmDesc}>{description}</div>}
            </div>
            <div className={`hana-toggle${editValue === 'true' ? ' on' : ''}`}>
              <div className="hana-toggle-thumb" />
            </div>
          </div>
          <div className={styles.settingsConfirmNote}>{toggleLabel(currentValue, editValue, t)}</div>
        </>
      ) : (
        <>
          <div className={styles.settingsConfirmLabel}>{displayLabel}</div>
          {description && <div className={styles.settingsConfirmDesc}>{description}</div>}
          <div className={styles.settingsConfirmControl}>
            {cardType === 'list' && options && (
              <div className={styles.settingsConfirmOptions}>
                {options.map(opt => (
                  <button
                    key={opt}
                    className={`${styles.settingsConfirmOption}${opt === editValue ? ` ${styles.settingsConfirmOptionSelected}` : ''}`}
                    onClick={() => setEditValue(opt)}
                  >
                    {opt === editValue ? '✓ ' : ''}{optionLabels?.[opt] || opt}
                  </button>
                ))}
              </div>
            )}
            {cardType === 'text' && (
              <input
                className={styles.settingsConfirmInput}
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
              />
            )}
          </div>
        </>
      )}

      <div className={styles.settingsConfirmActions}>
        <button className={`${styles.settingsConfirmBtn} ${styles.settingsConfirmBtnConfirm}`} onClick={handleConfirm}>{t('common.confirm')}</button>
        <button className={`${styles.settingsConfirmBtn} ${styles.settingsConfirmBtnReject}`} onClick={handleReject}>{t('common.cancel')}</button>
      </div>
    </div>
  );
});
