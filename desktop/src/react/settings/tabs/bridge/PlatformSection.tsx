/**
 * Generic platform configuration section for Bridge settings.
 * Eliminates per-platform copy-paste by accepting credential fields declaratively.
 */
import React from 'react';
import { t } from '../../helpers';
import { KeyInput } from '../../widgets/KeyInput';
import { Toggle } from '../../widgets/Toggle';
import { BridgeStatusDot, BridgeStatusText, OwnerSelect } from './BridgeWidgets';
import type { KnownUser } from './BridgeWidgets';
import { SettingsSection } from '../../components/SettingsSection';
import { SettingsRow } from '../../components/SettingsRow';
import styles from '../../Settings.module.css';

// ── Types ──

export interface CredentialField {
  key: string;
  label: string;
  type: 'text' | 'secret';
  value: string;
  onChange: (v: string) => void;
}

interface PlatformSectionProps {
  platform: string;
  title: string;
  status?: { status?: string; error?: string; enabled?: boolean };
  credentialFields: CredentialField[];
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  testing: boolean;
  hint?: string;
  ownerUsers?: KnownUser[];
  currentOwner?: string;
  onOwnerChange?: (userId: string) => void;
  onCredentialBlur?: () => void;
  children?: React.ReactNode;
}

export function PlatformSection({
  title,
  status,
  credentialFields,
  onToggle,
  onTest,
  testing,
  hint,
  ownerUsers,
  currentOwner,
  onOwnerChange,
  onCredentialBlur,
  platform,
  children,
}: PlatformSectionProps) {
  const lastFieldIndex = credentialFields.length - 1;

  /** 状态点 + 文字 + Toggle 作为 section 右上角 context */
  const statusContext = (
    <div className="bridge-platform-header" style={{ margin: 0 }}>
      <BridgeStatusDot status={status?.status} />
      <BridgeStatusText status={status?.status} error={status?.error} />
      <Toggle on={!!status?.enabled} onChange={onToggle} />
    </div>
  );

  return (
    <SettingsSection title={title} context={statusContext}>
      {credentialFields.map((field, idx) => {
        const isLast = idx === lastFieldIndex;
        const input = field.type === 'secret' ? (
          <div className="bridge-input-row">
            <KeyInput
              value={field.value}
              onChange={field.onChange}
              placeholder=""
              onBlur={onCredentialBlur}
            />
            {isLast && (
              <button
                className="bridge-test-btn"
                disabled={testing}
                onClick={onTest}
              >
                {testing ? '...' : t('settings.bridge.test')}
              </button>
            )}
          </div>
        ) : (
          <input
            className={styles['settings-input']}
            type="text"
            value={field.value}
            onChange={(e) => field.onChange(e.target.value)}
            onBlur={onCredentialBlur}
          />
        );

        return (
          <SettingsRow
            key={field.key}
            label={field.label}
            hint={isLast && hint ? hint : undefined}
            layout="stacked"
            control={input}
          />
        );
      })}

      {/* 无凭据（如 WhatsApp）：只显示 hint */}
      {credentialFields.length === 0 && hint && (
        <div style={{
          padding: 'var(--space-sm) var(--space-md)',
          fontSize: '0.7rem',
          color: 'var(--text-muted)',
          lineHeight: 1.4,
        }}>
          {hint}
        </div>
      )}

      {children}

      {ownerUsers && onOwnerChange && (
        <div style={{
          padding: 'var(--space-sm) var(--space-md)',
          borderTop: '1px solid var(--border)',
        }}>
          <OwnerSelect
            platform={platform}
            users={ownerUsers}
            currentOwner={currentOwner}
            onChange={onOwnerChange}
          />
        </div>
      )}
    </SettingsSection>
  );
}
