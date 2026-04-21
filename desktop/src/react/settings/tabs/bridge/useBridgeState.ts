/**
 * Bridge state management hook — loads status, saves config, tests platforms.
 */
import { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../../store';
import { hanaFetch } from '../../api';
import { t } from '../../helpers';
import type { KnownUser } from './BridgeWidgets';

// ── Types ──

interface PlatformStatusBase {
  status?: string;
  error?: string;
  enabled?: boolean;
  agentId?: string | null;
}

export interface TelegramStatus extends PlatformStatusBase { token?: string }
export interface FeishuStatus extends PlatformStatusBase { appId?: string; appSecret?: string }
export interface QQStatus extends PlatformStatusBase { appID?: string; appSecret?: string }
export interface WechatStatus extends PlatformStatusBase { token?: string }

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

export function useBridgeState() {
  const store = useSettingsStore();
  const { showToast } = store;
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [testingPlatform, setTestingPlatform] = useState<BridgePlatform | null>(null);

  // Selected agent for bridge config (independent of Agent tab selection)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    store.currentAgentId
  );
  const selectedAgentIdRef = useRef(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;

  // Sync initial value when store becomes ready (only if null)
  useEffect(() => {
    if (selectedAgentId) return;
    if (store.currentAgentId) setSelectedAgentId(store.currentAgentId);
  }, [store.currentAgentId]);

  // Public Ishiki — keyed to selectedAgentId
  const [publicIshiki, setPublicIshiki] = useState('');
  const [publicIshikiOriginal, setPublicIshikiOriginal] = useState('');

  // Credential fields
  const [tgToken, setTgToken] = useState('');
  const [fsAppId, setFsAppId] = useState('');
  const [fsAppSecret, setFsAppSecret] = useState('');
  const [qqAppId, setQqAppId] = useState('');
  const [qqAppSecret, setQqAppSecret] = useState('');

  // Fetch public ishiki for selected agent (abort stale requests on agent switch)
  useEffect(() => {
    if (!selectedAgentId) return;
    const ac = new AbortController();
    hanaFetch(`/api/agents/${selectedAgentId}/public-ishiki`, { signal: ac.signal })
      .then(r => r.json())
      .then(data => { setPublicIshiki(data.content || ''); setPublicIshikiOriginal(data.content || ''); })
      .catch(err => { if (err?.name !== 'AbortError') console.warn('[bridge] fetch public-ishiki failed:', err); });
    return () => ac.abort();
  }, [selectedAgentId]);

  const savePublicIshiki = async () => {
    const agentId = selectedAgentId;
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

  const loadStatus = async (signal?: AbortSignal) => {
    try {
      const query = selectedAgentId ? `?agentId=${encodeURIComponent(selectedAgentId)}` : '';
      const res = await hanaFetch(`/api/bridge/status${query}`, signal ? { signal } : undefined);
      const data = await res.json();
      if (signal?.aborted) return;
      setStatus(data);
      setTgToken(data.telegram?.token || '');
      setFsAppId(data.feishu?.appId || '');
      setFsAppSecret(data.feishu?.appSecret || '');
      setQqAppId(data.qq?.appID || '');
      setQqAppSecret(data.qq?.appSecret || '');
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      console.error('[bridge] load status failed:', err);
    }
  };

  // Auto-fetch when selectedAgentId changes (abort stale on switch)
  useEffect(() => {
    if (!selectedAgentId) return;
    const ac = new AbortController();
    loadStatus(ac.signal);
    return () => ac.abort();
  }, [selectedAgentId]);

  useEffect(() => {
    const handler = () => loadStatus();
    window.addEventListener('hana-bridge-reload', handler);
    return () => window.removeEventListener('hana-bridge-reload', handler);
  }, [selectedAgentId]);

  const saveBridgeConfig = async (plat: string, credentials: Record<string, string> | null, enabled?: boolean) => {
    // Snapshot agentId at call time to avoid stale closure
    const agentId = selectedAgentId;
    try {
      const agentQuery = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      await hanaFetch(`/api/bridge/config${agentQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: plat, credentials, enabled }),
      });
      showToast(t('settings.saved'), 'success');
      // Only reload if user hasn't switched agent during the save (read latest from ref)
      if (selectedAgentIdRef.current === agentId) await loadStatus();
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
    const agentId = selectedAgentId;
    try {
      const agentQuery = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      await hanaFetch(`/api/bridge/owner${agentQuery}`, {
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
    selectedAgentId, setSelectedAgentId,
    publicIshiki, setPublicIshiki, savePublicIshiki,
    tgToken, setTgToken,
    fsAppId, setFsAppId, fsAppSecret, setFsAppSecret,
    qqAppId, setQqAppId, qqAppSecret, setQqAppSecret,
    saveBridgeConfig, testPlatform, setOwner,
  };
}
