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

  return (
    <section className={styles['settings-section']}>
      <h2 className={styles['settings-section-title']}>{title}</h2>
      <div className="bridge-platform-header">
        <BridgeStatusDot status={status?.status} />
        <BridgeStatusText status={status?.status} error={status?.error} />
        <Toggle on={!!status?.enabled} onChange={onToggle} />
      </div>

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
          <div key={field.key} className={styles['settings-field']}>
            <label className={styles['settings-field-label']}>{field.label}</label>
            {input}
            {isLast && hint && (
              <span className={styles['settings-field-hint']}>{hint}</span>
            )}
          </div>
        );
      })}

      {credentialFields.length === 0 && hint && (
        <div className={styles['settings-field']}>
          <span className={styles['settings-field-hint']}>{hint}</span>
        </div>
      )}

      {children}

      {ownerUsers && onOwnerChange && (
        <OwnerSelect
          platform={platform}
          users={ownerUsers}
          currentOwner={currentOwner}
          onChange={onOwnerChange}
        />
      )}
    </section>
  );
}
