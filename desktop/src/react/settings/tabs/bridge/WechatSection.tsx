/**
 * WeChat platform section — uses QR scan instead of token input.
 */
import React from 'react';
import { t } from '../../helpers';
import { hanaFetch } from '../../api';
import { Toggle } from '../../widgets/Toggle';
import { BridgeStatusDot, BridgeStatusText } from './BridgeWidgets';
import styles from '../../Settings.module.css';
import bridgeStyles from '../BridgeTab.module.css';

interface WechatSectionProps {
  status: { status?: string; error?: string; enabled?: boolean; token?: string };
  showToast: (msg: string, type: 'success' | 'error') => void;
  onSaveConfig: (credentials: Record<string, string> | null, enabled?: boolean) => Promise<void>;
  onReload: () => Promise<void>;
  agentId: string | null;
}

export function WechatSection({ status, showToast, onSaveConfig, onReload, agentId }: WechatSectionProps) {
  const unbind = async () => {
    try {
      const agentQuery = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      await Promise.all([
        hanaFetch(`/api/bridge/config${agentQuery}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform: 'wechat', credentials: { botToken: '' }, enabled: false }),
        }),
        hanaFetch(`/api/bridge/owner${agentQuery}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform: 'wechat', userId: null }),
        }),
      ]);
      showToast(t('settings.bridge.wechatUnbound'), 'success');
    } catch {
      showToast(t('settings.saveFailed'), 'error');
    }
    await onReload();
  };

  return (
    <section className={styles['settings-section']}>
      <h2 className={styles['settings-section-title']}>{t('settings.bridge.wechat')}</h2>
      <div className="bridge-platform-header">
        <BridgeStatusDot status={status.status} />
        <BridgeStatusText status={status.status} error={status.error} />
        <Toggle
          on={!!status.enabled}
          onChange={async (on) => {
            if (on && !status.token) { showToast(t('settings.bridge.wechatNeedScan'), 'error'); return; }
            await onSaveConfig(null, on);
          }}
        />
      </div>
      <div className={styles['settings-field']}>
        {status.token ? (
          <div className={bridgeStyles['wechat-logged-in']}>
            <span className={bridgeStyles['wechat-login-info']}>
              {t('settings.bridge.wechatLoggedIn')}
            </span>
            <div className={bridgeStyles['wechat-btn-row']}>
              <button className="bridge-test-btn" onClick={() => window.dispatchEvent(new CustomEvent('hana-show-wechat-qrcode', { detail: { agentId } }))}>
                {t('settings.bridge.wechatRescan')}
              </button>
              <button className="bridge-test-btn" onClick={unbind}>
                {t('settings.bridge.wechatUnbind')}
              </button>
            </div>
          </div>
        ) : (
          <div className={bridgeStyles['wechat-scan-row']}>
            <button className="bridge-test-btn" onClick={() => window.dispatchEvent(new CustomEvent('hana-show-wechat-qrcode', { detail: { agentId } }))}>
              {t('settings.bridge.wechatScan')}
            </button>
          </div>
        )}
        <span className={styles['settings-field-hint']}>{t('settings.bridge.wechatHint')}</span>
        <span className={styles['settings-field-hint']}>{t('settings.bridge.wechatExclusive')}</span>
      </div>
    </section>
  );
}
