/**
 * Bridge state management hook — loads status, saves config, tests platforms.
 */
import { useState, useEffect } from 'react';
import { useSettingsStore } from '../../store';
import { hanaFetch } from '../../api';
import { t } from '../../helpers';
import type { KnownUser } from './BridgeWidgets';

// ── Types ──

interface PlatformStatusBase {
  status?: string;
  error?: string;
  enabled?: boolean;
}

export interface TelegramStatus extends PlatformStatusBase { tokenMasked?: string }
export interface FeishuStatus extends PlatformStatusBase { appId?: string; appSecretMasked?: string }
export interface QQStatus extends PlatformStatusBase { appID?: string; appSecretMasked?: string }
export interface WechatStatus extends PlatformStatusBase { tokenMasked?: string }

export interface BridgeStatus {
  telegram: TelegramStatus;
  feishu: FeishuStatus;
  whatsapp: PlatformStatusBase;
  qq: QQStatus;
  wechat: WechatStatus;
  readOnly: boolean;
  knownUsers: { telegram?: KnownUser[]; feishu?: KnownUser[]; whatsapp?: KnownUser[]; qq?: KnownUser[]; wechat?: KnownUser[] };
  owner: { telegram?: string; feishu?: string; whatsapp?: string; qq?: string; wechat?: string };
}

export type BridgePlatform = 'telegram' | 'feishu' | 'whatsapp' | 'qq' | 'wechat';

export const isMasked = (v: string) => v.includes('••••');

export function useBridgeState() {
  const store = useSettingsStore();
  const { showToast } = store;
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [testingPlatform, setTestingPlatform] = useState<BridgePlatform | null>(null);

  // Public Ishiki
  const [publicIshiki, setPublicIshiki] = useState('');
  const [publicIshikiOriginal, setPublicIshikiOriginal] = useState('');

  // Credential fields
  const [tgToken, setTgToken] = useState('');
  const [fsAppId, setFsAppId] = useState('');
  const [fsAppSecret, setFsAppSecret] = useState('');
  const [qqAppId, setQqAppId] = useState('');
  const [qqAppSecret, setQqAppSecret] = useState('');

  useEffect(() => {
    const agentId = store.getSettingsAgentId();
    if (!agentId) return;
    hanaFetch(`/api/agents/${agentId}/public-ishiki`)
      .then(r => r.json())
      .then(data => { setPublicIshiki(data.content || ''); setPublicIshikiOriginal(data.content || ''); })
      .catch(err => console.warn('[bridge] fetch public-ishiki failed:', err));
  }, [store.settingsConfig]);

  const savePublicIshiki = async () => {
    const agentId = store.getSettingsAgentId();
    if (!agentId || publicIshiki === publicIshikiOriginal) return;
    try {
      await hanaFetch(`/api/agents/${agentId}/public-ishiki`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: publicIshiki }),
      });
      setPublicIshikiOriginal(publicIshiki);
      showToast(t('settings.saved'), 'success');
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const loadStatus = async () => {
    try {
      const res = await hanaFetch('/api/bridge/status');
      const data = await res.json();
      setStatus(data);
      if (data.feishu?.appId) setFsAppId(data.feishu.appId);
      if (data.qq?.appID) setQqAppId(data.qq.appID);
      setTgToken(data.telegram?.tokenMasked || '');
      setFsAppSecret(data.feishu?.appSecretMasked || '');
      setQqAppSecret(data.qq?.appSecretMasked || '');
    } catch (err) {
      console.error('[bridge] load status failed:', err);
    }
  };

  useEffect(() => { loadStatus(); }, []);

  useEffect(() => {
    const handler = () => loadStatus();
    window.addEventListener('hana-bridge-reload', handler);
    return () => window.removeEventListener('hana-bridge-reload', handler);
  }, []);

  const saveBridgeConfig = async (plat: string, credentials: Record<string, string> | null, enabled?: boolean) => {
    try {
      await hanaFetch('/api/bridge/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: plat, credentials, enabled }),
      });
      showToast(t('settings.saved'), 'success');
      await loadStatus();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const testPlatform = async (plat: BridgePlatform, credentials: Record<string, string>) => {
    setTestingPlatform(plat);
    try {
      const res = await hanaFetch('/api/bridge/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: plat, credentials }),
      });
      const data = await res.json();
      if (data.ok) {
        const info = plat === 'telegram' ? ` @${data.info?.username || ''}` : '';
        showToast(t('settings.bridge.testOk') + info, 'success');
      } else {
        showToast(t('settings.bridge.testFail') + ': ' + (data.error || ''), 'error');
      }
    } catch (err: unknown) {
      showToast(t('settings.bridge.testFail') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setTestingPlatform(null);
    }
  };

  const setOwner = async (plat: string, userId: string) => {
    try {
      await hanaFetch('/api/bridge/owner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: plat, userId: userId || null }),
      });
      showToast(t('settings.bridge.ownerSaved'), 'success');
    } catch {
      showToast(t('settings.saveFailed'), 'error');
    }
  };

  return {
    status, testingPlatform, showToast, loadStatus,
    publicIshiki, setPublicIshiki, savePublicIshiki,
    tgToken, setTgToken,
    fsAppId, setFsAppId, fsAppSecret, setFsAppSecret,
    qqAppId, setQqAppId, qqAppSecret, setQqAppSecret,
    saveBridgeConfig, testPlatform, setOwner,
  };
}
