import { useCallback, useEffect, useMemo, useState } from 'react';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { Toggle } from '../widgets/Toggle';
import styles from '../Settings.module.css';

interface ComputerProviderStatus {
  providerId: string;
  status?: {
    available?: boolean;
    reason?: string;
    error?: string;
    permissions?: Array<{ name?: string; granted?: boolean }>;
  };
}

interface ComputerUseStatusResponse {
  selectedProviderId?: string | null;
  status?: {
    enabled?: boolean;
    activeLease?: {
      leaseId?: string;
      agentId?: string | null;
      appId?: string | null;
    } | null;
    providers?: ComputerProviderStatus[];
  } | null;
  settings?: {
    enabled?: boolean;
    app_approvals?: Array<{ providerId: string; appId: string; appName?: string }>;
  };
}

function StatusText({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span style={{
      color: ok ? 'var(--accent)' : 'var(--text-muted)',
      fontSize: '0.78rem',
      whiteSpace: 'nowrap',
      maxWidth: 280,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }}>
      {text}
    </span>
  );
}

export function ComputerUseTab() {
  const [data, setData] = useState<ComputerUseStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [requesting, setRequesting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await hanaFetch('/api/preferences/computer-use');
      setData(await res.json());
    } catch (err) {
      console.warn('[computer-use] load status failed:', err);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const selectedProvider = useMemo(() => {
    const id = data?.selectedProviderId || null;
    return data?.status?.providers?.find((provider) => provider.providerId === id) || null;
  }, [data]);

  const enabled = data?.settings?.enabled === true;
  const available = selectedProvider?.status?.available === true;
  const permissions = selectedProvider?.status?.permissions || [];
  const permissionText = permissions.length > 0
    ? permissions.map((p) => `${p.name || 'permission'}:${p.granted ? 'ok' : 'missing'}`).join(' · ')
    : t('settings.computerUse.permissionsEmpty');
  const approvals = data?.settings?.app_approvals || [];
  const approvalsText = approvals.length > 0
    ? approvals.map((item) => item.appName || item.appId).join(' · ')
    : t('settings.computerUse.approvalsEmpty');
  const activeLease = data?.status?.activeLease;
  const activeLeaseText = activeLease
    ? activeLease.appId || activeLease.agentId || activeLease.leaseId || t('settings.computerUse.active')
    : t('settings.computerUse.idle');

  const saveEnabled = async (next: boolean) => {
    setSaving(true);
    try {
      const res = await hanaFetch('/api/preferences/computer-use', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { enabled: next } }),
      });
      const body = await res.json();
      setData((prev) => ({
        ...(prev || {}),
        settings: {
          ...(prev?.settings || {}),
          ...(body.settings || {}),
        },
      }));
      await load();
    } finally {
      setSaving(false);
    }
  };

  const requestPermissions = async () => {
    setRequesting(true);
    try {
      await hanaFetch('/api/preferences/computer-use/request-permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: data?.selectedProviderId || undefined }),
      });
      await load();
    } finally {
      setRequesting(false);
    }
  };

  const refreshButton = (
    <button
      className={styles['settings-save-btn-sm']}
      onClick={load}
      disabled={loading}
      style={{ minWidth: 72 }}
    >
      {t('settings.computerUse.refresh')}
    </button>
  );

  const permissionsButton = (
    <button
      className={styles['settings-save-btn-sm']}
      onClick={requestPermissions}
      disabled={requesting || loading}
      style={{ minWidth: 120 }}
    >
      {t('settings.computerUse.requestPermissions')}
    </button>
  );

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="computer">
      <SettingsSection title={t('settings.computerUse.title')} context={refreshButton}>
        <SettingsSection.Note>
          {t('settings.computerUse.description')}
        </SettingsSection.Note>
        <SettingsRow
          label={t('settings.computerUse.enabled')}
          hint={t('settings.computerUse.enabledHint')}
          control={<Toggle on={enabled} onChange={(next) => saveEnabled(next)} disabled={saving || loading} />}
        />
        <SettingsRow
          label={t('settings.computerUse.provider')}
          control={<StatusText ok={!!data?.selectedProviderId} text={data?.selectedProviderId || '-'} />}
        />
        <SettingsRow
          label={t('settings.computerUse.availability')}
          hint={selectedProvider?.status?.reason || selectedProvider?.status?.error || undefined}
          control={<StatusText ok={available} text={available ? t('settings.computerUse.available') : t('settings.computerUse.unavailable')} />}
        />
        <SettingsRow
          label={t('settings.computerUse.permissions')}
          hint={t('settings.computerUse.permissionsHint')}
          control={permissionsButton}
        />
        <SettingsRow
          label={t('settings.computerUse.permissionsStatus')}
          control={<StatusText ok={permissions.every((p) => p.granted !== false)} text={permissionText} />}
        />
        <SettingsRow
          label={t('settings.computerUse.approvals')}
          control={<StatusText ok={approvals.length > 0} text={approvalsText} />}
        />
        <SettingsRow
          label={t('settings.computerUse.activeSession')}
          control={<StatusText ok={!activeLease} text={activeLeaseText} />}
        />
      </SettingsSection>
    </div>
  );
}
