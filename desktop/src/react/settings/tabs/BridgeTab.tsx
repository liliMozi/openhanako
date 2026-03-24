import React from 'react';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { Toggle } from '../widgets/Toggle';
import { PlatformSection } from './bridge/PlatformSection';
import { WechatSection } from './bridge/WechatSection';
import { useBridgeState, isMasked } from './bridge/useBridgeState';
import styles from '../Settings.module.css';

export function BridgeTab() {
  const b = useBridgeState();
  const tgInfo = b.status?.telegram || {};
  const fsInfo = b.status?.feishu || {};
  const waInfo = b.status?.whatsapp || {};
  const qqInfo = b.status?.qq || {};
  const wxInfo = b.status?.wechat || {};
  const readOnly = !!b.status?.readOnly;

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="bridge">
      {/* 对外意识 */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.agent.publicIshiki')}</h2>
        <div className={styles['settings-field']}>
          <textarea
            className={styles['settings-textarea']}
            rows={6}
            spellCheck={false}
            value={b.publicIshiki}
            onChange={(e) => b.setPublicIshiki(e.target.value)}
            onBlur={b.savePublicIshiki}
          />
          <span className={styles['settings-field-hint']}>{t('settings.agent.publicIshikiHint')}</span>
        </div>
      </section>

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
          const hasRealToken = b.tgToken && !isMasked(b.tgToken);
          if (on && !hasRealToken && !b.status?.telegram?.tokenMasked) { b.showToast(t('settings.bridge.noToken'), 'error'); return; }
          await b.saveBridgeConfig('telegram', hasRealToken ? { token: b.tgToken } : null, on);
        }}
        onTest={() => {
          const trimmed = b.tgToken.trim();
          if (!trimmed || isMasked(trimmed)) { b.showToast(t('settings.bridge.noToken'), 'error'); return; }
          b.testPlatform('telegram', { token: trimmed });
        }}
        onCredentialBlur={async () => {
          const trimmed = b.tgToken.trim();
          if (trimmed && !isMasked(trimmed)) await b.saveBridgeConfig('telegram', { token: trimmed }, undefined);
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
          const hasRealSecret = b.fsAppSecret && !isMasked(b.fsAppSecret);
          if (on && !hasRealSecret && !fsInfo.appSecretMasked) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          await b.saveBridgeConfig('feishu', hasRealSecret ? { appId: b.fsAppId, appSecret: b.fsAppSecret } : null, on);
        }}
        onTest={() => {
          if (!b.fsAppId.trim() || !b.fsAppSecret.trim() || isMasked(b.fsAppSecret)) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          b.testPlatform('feishu', { appId: b.fsAppId.trim(), appSecret: b.fsAppSecret.trim() });
        }}
        onCredentialBlur={async () => {
          if (b.fsAppId.trim() && b.fsAppSecret.trim() && !isMasked(b.fsAppSecret))
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
          const hasRealCreds = b.qqAppId && b.qqAppSecret && !isMasked(b.qqAppSecret);
          if (on && !hasRealCreds && !(qqInfo.appID && qqInfo.appSecretMasked)) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          await b.saveBridgeConfig('qq', hasRealCreds ? { appID: b.qqAppId, appSecret: b.qqAppSecret } : null, on);
        }}
        onTest={() => {
          if (!b.qqAppId.trim() || !b.qqAppSecret.trim() || isMasked(b.qqAppSecret)) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          b.testPlatform('qq', { appID: b.qqAppId.trim(), appSecret: b.qqAppSecret.trim() });
        }}
        onCredentialBlur={async () => {
          if (b.qqAppId.trim() && b.qqAppSecret.trim() && !isMasked(b.qqAppSecret))
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
      />

      {/* WhatsApp */}
      <PlatformSection
        platform="whatsapp"
        title="WhatsApp"
        status={waInfo}
        credentialFields={[]}
        onToggle={async (on) => { await b.saveBridgeConfig('whatsapp', null, on); }}
        onTest={() => {}}
        testing={false}
        hint={t('settings.bridge.whatsappHint')}
        ownerUsers={b.status?.knownUsers?.whatsapp || []}
        currentOwner={b.status?.owner?.whatsapp}
        onOwnerChange={(userId) => b.setOwner('whatsapp', userId)}
      />

      {/* 只读模式 */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.bridge.readOnly')}</h2>
        <div className="bridge-platform-header">
          <span className="bridge-readonly-desc">{t('settings.bridge.readOnlyDesc')}</span>
          <Toggle
            on={readOnly}
            onChange={async (on) => {
              try {
                await hanaFetch('/api/bridge/settings', {
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
        </div>
      </section>
    </div>
  );
}
