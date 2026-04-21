import React from 'react';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { Toggle } from '../widgets/Toggle';
import { PlatformSection } from './bridge/PlatformSection';
import { WechatSection } from './bridge/WechatSection';
import { useBridgeState } from './bridge/useBridgeState';
import { BridgeAgentRow } from './bridge/BridgeAgentRow';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import styles from '../Settings.module.css';

export function BridgeTab() {
  const b = useBridgeState();
  const tgInfo = b.status?.telegram || {};
  const fsInfo = b.status?.feishu || {};
  const qqInfo = b.status?.qq || {};
  const wxInfo = b.status?.wechat || {};
  const readOnly = !!b.status?.readOnly;

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="bridge">
      {/* BridgeAgentRow：tab 级 context，水平平铺头像+名字
       * 未超宽时居中显示，超宽时横向滚动；selected 高亮对齐 AgentCardStack */}
      <BridgeAgentRow
        value={b.selectedAgentId}
        onChange={b.setSelectedAgentId}
      />

      {/* 对外意识：hint 在上、textarea 在下，直接作为 section body children（单 textarea 不套 row） */}
      <SettingsSection title={t('settings.agent.publicIshiki')}>
        <div style={{ padding: 'var(--space-sm) var(--space-md)' }}>
          <div style={{
            fontSize: '0.7rem',
            color: 'var(--text-muted)',
            lineHeight: 1.5,
            marginBottom: 'var(--space-sm)',
            whiteSpace: 'pre-line',
          }}>
            {t('settings.agent.publicIshikiHint')}
          </div>
          <textarea
            className={styles['settings-textarea']}
            rows={6}
            spellCheck={false}
            value={b.publicIshiki}
            onChange={(e) => b.setPublicIshiki(e.target.value)}
            onBlur={b.savePublicIshiki}
          />
        </div>
      </SettingsSection>

      <div className="bridge-help-link-row">
        <span className="bridge-help-link" onClick={() => window.dispatchEvent(new Event('hana-show-bridge-tutorial'))}>
          {t('settings.bridge.howTo')}
        </span>
      </div>

      {/* Telegram */}
      <PlatformSection
        platform="telegram"
        title={t('settings.bridge.telegram')}
        status={tgInfo}
        credentialFields={[
          { key: 'token', label: t('settings.bridge.telegramToken'), type: 'secret', value: b.tgToken, onChange: b.setTgToken },
        ]}
        onToggle={async (on) => {
          if (on && !b.tgToken.trim()) { b.showToast(t('settings.bridge.noToken'), 'error'); return; }
          await b.saveBridgeConfig('telegram', b.tgToken.trim() ? { token: b.tgToken.trim() } : null, on);
        }}
        onTest={() => {
          if (!b.tgToken.trim()) { b.showToast(t('settings.bridge.noToken'), 'error'); return; }
          b.testPlatform('telegram', { token: b.tgToken.trim() });
        }}
        onCredentialBlur={async () => {
          if (b.tgToken.trim()) await b.saveBridgeConfig('telegram', { token: b.tgToken.trim() }, undefined);
        }}
        testing={b.testingPlatform === 'telegram'}
        hint={t('settings.bridge.telegramHint')}
        ownerUsers={b.status?.knownUsers?.telegram || []}
        currentOwner={b.status?.owner?.telegram}
        onOwnerChange={(userId) => b.setOwner('telegram', userId)}
      />

      {/* 飞书 */}
      <PlatformSection
        platform="feishu"
        title={t('settings.bridge.feishu')}
        status={fsInfo}
        credentialFields={[
          { key: 'appId', label: t('settings.bridge.feishuAppId'), type: 'text', value: b.fsAppId, onChange: b.setFsAppId },
          { key: 'appSecret', label: t('settings.bridge.feishuAppSecret'), type: 'secret', value: b.fsAppSecret, onChange: b.setFsAppSecret },
        ]}
        onToggle={async (on) => {
          if (on && (!b.fsAppId.trim() || !b.fsAppSecret.trim())) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          await b.saveBridgeConfig('feishu', { appId: b.fsAppId.trim(), appSecret: b.fsAppSecret.trim() }, on);
        }}
        onTest={() => {
          if (!b.fsAppId.trim() || !b.fsAppSecret.trim()) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          b.testPlatform('feishu', { appId: b.fsAppId.trim(), appSecret: b.fsAppSecret.trim() });
        }}
        onCredentialBlur={async () => {
          if (b.fsAppId.trim() && b.fsAppSecret.trim())
            await b.saveBridgeConfig('feishu', { appId: b.fsAppId.trim(), appSecret: b.fsAppSecret.trim() }, undefined);
        }}
        testing={b.testingPlatform === 'feishu'}
        hint={t('settings.bridge.feishuHint')}
        ownerUsers={b.status?.knownUsers?.feishu || []}
        currentOwner={b.status?.owner?.feishu}
        onOwnerChange={(userId) => b.setOwner('feishu', userId)}
      />

      {/* QQ */}
      <PlatformSection
        platform="qq"
        title="QQ"
        status={qqInfo}
        credentialFields={[
          { key: 'appID', label: t('settings.bridge.qqAppId'), type: 'text', value: b.qqAppId, onChange: b.setQqAppId },
          { key: 'appSecret', label: t('settings.bridge.qqAppSecret'), type: 'secret', value: b.qqAppSecret, onChange: b.setQqAppSecret },
        ]}
        onToggle={async (on) => {
          if (on && (!b.qqAppId.trim() || !b.qqAppSecret.trim())) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          await b.saveBridgeConfig('qq', { appID: b.qqAppId.trim(), appSecret: b.qqAppSecret.trim() }, on);
        }}
        onTest={() => {
          if (!b.qqAppId.trim() || !b.qqAppSecret.trim()) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          b.testPlatform('qq', { appID: b.qqAppId.trim(), appSecret: b.qqAppSecret.trim() });
        }}
        onCredentialBlur={async () => {
          if (b.qqAppId.trim() && b.qqAppSecret.trim())
            await b.saveBridgeConfig('qq', { appID: b.qqAppId.trim(), appSecret: b.qqAppSecret.trim() }, undefined);
        }}
        testing={b.testingPlatform === 'qq'}
        hint={t('settings.bridge.qqHint')}
        ownerUsers={b.status?.knownUsers?.qq || []}
        currentOwner={b.status?.owner?.qq}
        onOwnerChange={(userId) => b.setOwner('qq', userId)}
      />

      {/* 微信 */}
      <WechatSection
        status={wxInfo}
        showToast={b.showToast}
        onSaveConfig={(creds, enabled) => b.saveBridgeConfig('wechat', creds, enabled)}
        onReload={b.loadStatus}
        agentId={b.selectedAgentId}
      />

      {/* 只读模式 */}
      <SettingsSection title={t('settings.bridge.readOnly')}>
        <SettingsRow
          label={t('settings.bridge.readOnlyDesc')}
          control={
            <Toggle
              on={readOnly}
              onChange={async (on) => {
                try {
                  const agentQuery = b.selectedAgentId ? `?agentId=${encodeURIComponent(b.selectedAgentId)}` : '';
                  await hanaFetch(`/api/bridge/settings${agentQuery}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ readOnly: on }),
                  });
                  b.showToast(t('settings.saved'), 'success');
                  await b.loadStatus();
                } catch {
                  b.showToast(t('settings.saveFailed'), 'error');
                }
              }}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}
