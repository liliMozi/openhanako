import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { KeyInput } from '../widgets/KeyInput';
import { Toggle } from '../widgets/Toggle';

const platform = (window as any).platform;

interface InstanceStatus {
  basePlatform: string;
  configured?: boolean;
  enabled?: boolean;
  status?: string;
  error?: string | null;
  label?: string | null;
  role?: string;  // "ai" | "owner"
  // Telegram
  tokenMasked?: string;
  // Feishu
  appId?: string;
  appSecretMasked?: string;
  // QQ
  appID?: string;
  // Wechat
  baseUrl?: string;
  // WeCom
  botId?: string;
  secretMasked?: string;
}

interface BridgeStatus {
  telegram: any;
  feishu: any;
  whatsapp: any;
  qq: any;
  wechat: any;
  workwechat: any;
  instances: Record<string, InstanceStatus>;
  readOnly: boolean;
  knownUsers: { telegram?: any[]; feishu?: any[]; whatsapp?: any[]; qq?: any[]; wechat?: any[]; workwechat?: any[] };
  owner: { telegram?: string; feishu?: string; whatsapp?: string; qq?: string; wechat?: string; workwechat?: string };
}

export function BridgeTab() {
  const store = useSettingsStore();
  const { showToast } = store;
  const [status, setStatus] = useState<BridgeStatus | null>(null);

  // Public Ishiki
  const [publicIshiki, setPublicIshiki] = useState('');
  const [publicIshikiOriginal, setPublicIshikiOriginal] = useState('');

  useEffect(() => {
    const agentId = store.getSettingsAgentId();
    if (!agentId) return;
    hanaFetch(`/api/agents/${agentId}/public-ishiki`)
      .then(r => r.json())
      .then(data => { setPublicIshiki(data.content || ''); setPublicIshikiOriginal(data.content || ''); })
      .catch(() => {});
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
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  // Telegram fields
  const [tgToken, setTgToken] = useState('');
  // Feishu fields — 多实例
  const [feishuInstances, setFeishuInstances] = useState<{ id: string; appId: string; appSecret: string; label: string; role: string }[]>([]);
  // QQ fields
  const [qqAppId, setQqAppId] = useState('');
  const [qqAppSecret, setQqAppSecret] = useState('');

  const loadStatus = async () => {
    try {
      const res = await hanaFetch('/api/bridge/status');
      const data = await res.json();
      setStatus(data);

      // 从 instances 中提取飞书实例列表
      const instances = data.instances || {};
      const fsIds = Object.keys(instances).filter(id => instances[id]?.basePlatform === 'feishu');
      if (fsIds.length === 0) fsIds.push('feishu'); // 至少保留一个默认实例

      setFeishuInstances(prev => {
        // 仅在首次加载时初始化（或实例数量变化时更新）
        if (prev.length === 0 || prev.length !== fsIds.length) {
          return fsIds.map(id => ({
            id,
            appId: instances[id]?.appId || '',
            appSecret: '',
            label: instances[id]?.label || '',
            role: instances[id]?.role || 'ai',
          }));
        }
        return prev;
      });

      if (data.qq?.appID && !qqAppId) setQqAppId(data.qq.appID);
      // 初始化企业微信用户映射
      if (data.workwechat?.userMap) setWcUserMap(data.workwechat.userMap);
    } catch (err) {
      console.error('[bridge] load status failed:', err);
    }
  };

  const addFeishuInstance = () => {
    // 生成下一个实例 ID：feishu:2, feishu:3, ...
    const existing = feishuInstances.map(i => i.id);
    let next = 2;
    while (existing.includes(`feishu:${next}`)) next++;
    const newId = `feishu:${next}`;
    setFeishuInstances(prev => [...prev, { id: newId, appId: '', appSecret: '', label: '', role: 'ai' }]);
  };

  const removeFeishuInstance = async (instanceId: string) => {
    if (!instanceId.includes(':')) return; // 不能删除默认实例
    try {
      await hanaFetch('/api/bridge/delete-instance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId }),
      });
      setFeishuInstances(prev => prev.filter(i => i.id !== instanceId));
      showToast(t('settings.saved'), 'success');
      await loadStatus();
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  const updateFeishuField = (instanceId: string, field: string, value: string) => {
    setFeishuInstances(prev => prev.map(i =>
      i.id === instanceId ? { ...i, [field]: value } : i
    ));
  };

  useEffect(() => { loadStatus(); }, []);

  const saveBridgeConfig = async (platform_: string, credentials: any, enabled?: boolean, label?: string, role?: string, userMap?: Record<string, string>) => {
    try {
      await hanaFetch('/api/bridge/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: platform_, credentials, enabled, label, role, userMap }),
      });
      showToast(t('settings.saved'), 'success');
      await loadStatus();
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  const testPlatform = async (platform_: string, credentials: any, btn: HTMLButtonElement) => {
    btn.disabled = true;
    btn.textContent = '...';
    try {
      console.log(`[bridge test] testing ${platform_}...`);
      const res = await hanaFetch('/api/bridge/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: platform_, credentials }),
      });
      console.log(`[bridge test] response status: ${res.status}`);
      const data = await res.json();
      console.log(`[bridge test] response data:`, data);
      if (data.ok) {
        const info = platform_ === 'telegram' ? ` @${data.info?.username || ''}` : '';
        showToast(t('settings.bridge.testOk') + info, 'success');
      } else {
        showToast(t('settings.bridge.testFail') + ': ' + (data.error || ''), 'error');
      }
    } catch (err: any) {
      console.error(`[bridge test] error:`, err);
      showToast(t('settings.bridge.testFail') + ': ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = t('settings.bridge.test');
    }
  };

  const setOwner = async (platform_: string, userId: string) => {
    try {
      await hanaFetch('/api/bridge/owner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: platform_, userId: userId || null }),
      });
      showToast(t('settings.bridge.ownerSaved'), 'success');
      await loadStatus();
    } catch {
      showToast(t('settings.saveFailed'), 'error');
    }
  };

  const tgInfo = status?.telegram || {};
  const waInfo = status?.whatsapp || {};
  const qqInfo = status?.qq || {};
  const wxInfo = status?.wechat || {};
  const wcInfo = status?.workwechat || {};
  const readOnly = !!status?.readOnly;

  // 企业微信智能机器人凭证
  const [wcBotId, setWcBotId] = useState('');
  const [wcSecret, setWcSecret] = useState('');
  const [wcUserMap, setWcUserMap] = useState<Record<string, string>>({});
  const [wcNewUserId, setWcNewUserId] = useState('');
  const [wcNewUserName, setWcNewUserName] = useState('');

  // 微信扫码登录状态
  const [wxLoginState, setWxLoginState] = useState<'idle' | 'qr' | 'polling' | 'success' | 'error'>('idle');
  const [wxQrcodeUrl, setWxQrcodeUrl] = useState('');
  const [wxLoginMsg, setWxLoginMsg] = useState('');

  const startWxLogin = async () => {
    setWxLoginState('qr');
    setWxLoginMsg('正在获取二维码...');
    try {
      const res = await hanaFetch('/api/bridge/wechat-login-start', { method: 'POST' });
      const data = await res.json();
      if (data.qrcodeUrl) {
        setWxQrcodeUrl(data.qrcodeUrl);
        setWxLoginMsg(data.message || '请使用微信扫描二维码');
        // 自动开始轮询
        setWxLoginState('polling');
        const pollRes = await hanaFetch('/api/bridge/wechat-login-poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qrcode: data.qrcode, timeoutMs: 120000 }),
        });
        const pollData = await pollRes.json();
        if (pollData.connected) {
          setWxLoginState('success');
          setWxLoginMsg(pollData.message || '✅ 连接成功！');
          showToast('微信连接成功！', 'success');
          await loadStatus();
        } else {
          setWxLoginState('error');
          setWxLoginMsg(pollData.message || '连接失败');
        }
      } else {
        setWxLoginState('error');
        setWxLoginMsg(data.message || '获取二维码失败');
      }
    } catch (err: any) {
      setWxLoginState('error');
      setWxLoginMsg('请求失败: ' + err.message);
    }
  };

  return (
    <div className="settings-tab-content active" data-tab="bridge">
      {/* 对外意识 */}
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.agent.publicIshiki')}</h2>
        <div className="settings-field">
          <textarea
            className="settings-textarea"
            rows={6}
            spellCheck={false}
            value={publicIshiki}
            onChange={(e) => setPublicIshiki(e.target.value)}
            onBlur={savePublicIshiki}
          />
          <span className="settings-field-hint">{t('settings.agent.publicIshikiHint')}</span>
        </div>
      </section>

      {/* 教程链接 */}
      <div className="bridge-help-link-row">
        <span
          className="bridge-help-link"
          onClick={() => window.dispatchEvent(new Event('hana-show-bridge-tutorial'))}
        >
          {t('settings.bridge.howTo')}
        </span>
      </div>

      {/* Telegram */}
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.bridge.telegram')}</h2>
        <div className="bridge-platform-header">
          <BridgeStatusDot status={tgInfo.status} />
          <BridgeStatusText status={tgInfo.status} error={tgInfo.error} />
          <Toggle
            on={!!tgInfo.enabled}
            onChange={async (on) => {
              const token = tgToken || '';
              const hasSaved = !!status?.telegram?.tokenMasked;
              if (on && !token && !hasSaved) {
                showToast(t('settings.bridge.noToken'), 'error');
                return;
              }
              await saveBridgeConfig('telegram', token ? { token } : null, on);
            }}
          />
        </div>
        <div className="settings-field">
          <label className="settings-field-label">{t('settings.bridge.telegramToken')}</label>
          <div className="bridge-input-row">
            <KeyInput
              value={tgToken}
              onChange={setTgToken}
              placeholder={tgInfo.tokenMasked || ''}
              onBlur={async () => {
                if (tgToken.trim()) await saveBridgeConfig('telegram', { token: tgToken.trim() }, undefined);
              }}
            />
            <button
              className="bridge-test-btn"
              onClick={(e) => {
                if (!tgToken.trim()) { showToast(t('settings.bridge.noToken'), 'error'); return; }
                testPlatform('telegram', { token: tgToken.trim() }, e.currentTarget);
              }}
            >
              {t('settings.bridge.test')}
            </button>
          </div>
          <span className="settings-field-hint">{t('settings.bridge.telegramHint')}</span>
        </div>
        <OwnerSelect
          platform_="telegram"
          users={status?.knownUsers?.telegram || []}
          currentOwner={status?.owner?.telegram}
          onChange={(userId) => setOwner('telegram', userId)}
        />
      </section>

      {/* 飞书（支持多实例） */}
      <section className="settings-section">
        <h2 className="settings-section-title">
          {t('settings.bridge.feishu')}
          <button
            className="bridge-add-instance-btn"
            onClick={addFeishuInstance}
            title="添加飞书实例"
          >+</button>
        </h2>
        {feishuInstances.map((inst) => {
          const instanceInfo = status?.instances?.[inst.id] || {};
          const isDefault = !inst.id.includes(':');
          const displayLabel = inst.label || instanceInfo.label || (isDefault ? '' : inst.id.split(':')[1]);
          const currentRole = inst.role || (instanceInfo as any).role || 'ai';
          return (
            <div key={inst.id} className="bridge-instance-block">
              <div className="bridge-instance-header">
                {!isDefault && (
                  <input
                    className="settings-input bridge-instance-label-input"
                    type="text"
                    placeholder={`实例标签（如"Owner 飞书"）`}
                    value={inst.label}
                    onChange={(e) => updateFeishuField(inst.id, 'label', e.target.value)}
                    onBlur={async () => {
                      if (inst.label.trim()) {
                        await saveBridgeConfig(inst.id, null, undefined, inst.label.trim());
                      }
                    }}
                  />
                )}
                <select
                  className="settings-input bridge-role-select"
                  value={currentRole}
                  onChange={async (e) => {
                    const newRole = e.target.value;
                    updateFeishuField(inst.id, 'role', newRole);
                    await saveBridgeConfig(inst.id, null, undefined, undefined, newRole);
                  }}
                >
                  <option value="ai">🤖 AI 自动回复</option>
                  <option value="owner">👤 Owner 通道</option>
                </select>
                {!isDefault && (
                  <button
                    className="bridge-remove-instance-btn"
                    onClick={() => removeFeishuInstance(inst.id)}
                    title="删除此实例"
                  >✕</button>
                )}
              </div>
              <div className="bridge-platform-header">
                <BridgeStatusDot status={instanceInfo.status} />
                <BridgeStatusText status={instanceInfo.status} error={instanceInfo.error} />
                {displayLabel && <span className="bridge-instance-tag">{displayLabel}</span>}
                <Toggle
                  on={!!instanceInfo.enabled}
                  onChange={async (on) => {
                    const hasSaved = !!instanceInfo.appSecretMasked;
                    if (on && !inst.appId && !hasSaved) {
                      showToast(t('settings.bridge.noCredentials'), 'error');
                      return;
                    }
                    const creds = inst.appSecret ? { appId: inst.appId, appSecret: inst.appSecret } : (inst.appId ? { appId: inst.appId } : null);
                    await saveBridgeConfig(inst.id, creds, on);
                  }}
                />
              </div>
              <div className="settings-field">
                <label className="settings-field-label">{t('settings.bridge.feishuAppId')}</label>
                <input
                  className="settings-input"
                  type="text"
                  value={inst.appId}
                  onChange={(e) => updateFeishuField(inst.id, 'appId', e.target.value)}
                  onBlur={async () => {
                    if (inst.appId.trim() && inst.appSecret.trim()) {
                      await saveBridgeConfig(inst.id, { appId: inst.appId.trim(), appSecret: inst.appSecret.trim() }, undefined);
                    }
                  }}
                />
              </div>
              <div className="settings-field">
                <label className="settings-field-label">{t('settings.bridge.feishuAppSecret')}</label>
                <div className="bridge-input-row">
                  <KeyInput
                    value={inst.appSecret}
                    onChange={(v: string) => updateFeishuField(inst.id, 'appSecret', v)}
                    placeholder={instanceInfo.appSecretMasked || ''}
                    onBlur={async () => {
                      if (inst.appId.trim() && inst.appSecret.trim()) {
                        await saveBridgeConfig(inst.id, { appId: inst.appId.trim(), appSecret: inst.appSecret.trim() }, undefined);
                      }
                    }}
                  />
                  <button
                    className="bridge-test-btn"
                    onClick={(e) => {
                      if (!inst.appId.trim() || !inst.appSecret.trim()) { showToast(t('settings.bridge.noCredentials'), 'error'); return; }
                      testPlatform(inst.id, { appId: inst.appId.trim(), appSecret: inst.appSecret.trim() }, e.currentTarget);
                    }}
                  >
                    {t('settings.bridge.test')}
                  </button>
                </div>
                <span className="settings-field-hint">{t('settings.bridge.feishuHint')}</span>
              </div>
              {isDefault && (
                <OwnerSelect
                  platform_="feishu"
                  users={status?.knownUsers?.feishu || []}
                  currentOwner={status?.owner?.feishu}
                  onChange={(userId) => setOwner('feishu', userId)}
                />
              )}
            </div>
          );
        })}
      </section>

      {/* QQ */}
      <section className="settings-section">
        <h2 className="settings-section-title">QQ</h2>
        <div className="bridge-platform-header">
          <BridgeStatusDot status={qqInfo.status} />
          <BridgeStatusText status={qqInfo.status} error={qqInfo.error} />
          <Toggle
            on={!!qqInfo.enabled}
            onChange={async (on) => {
              const hasSaved = !!(qqInfo.appID && qqInfo.appSecretMasked);
              if (on && !(qqAppId && qqAppSecret) && !hasSaved) {
                showToast(t('settings.bridge.noCredentials'), 'error');
                return;
              }
              const creds = (qqAppId && qqAppSecret) ? { appID: qqAppId, appSecret: qqAppSecret } : null;
              await saveBridgeConfig('qq', creds, on);
            }}
          />
        </div>
        <div className="settings-field">
          <label className="settings-field-label">{t('settings.bridge.qqAppId')}</label>
          <input
            className="settings-input"
            type="text"
            value={qqAppId}
            onChange={(e) => setQqAppId(e.target.value)}
            onBlur={async () => {
              if (qqAppId.trim() && qqAppSecret.trim()) {
                await saveBridgeConfig('qq', { appID: qqAppId.trim(), appSecret: qqAppSecret.trim() }, undefined);
              }
            }}
          />
        </div>
        <div className="settings-field">
          <label className="settings-field-label">{t('settings.bridge.qqAppSecret')}</label>
          <div className="bridge-input-row">
            <KeyInput
              value={qqAppSecret}
              onChange={setQqAppSecret}
              placeholder={qqInfo.appSecretMasked || ''}
              onBlur={async () => {
                if (qqAppId.trim() && qqAppSecret.trim()) {
                  await saveBridgeConfig('qq', { appID: qqAppId.trim(), appSecret: qqAppSecret.trim() }, undefined);
                }
              }}
            />
            <button
              className="bridge-test-btn"
              onClick={(e) => {
                if (!qqAppId.trim() || !qqAppSecret.trim()) { showToast(t('settings.bridge.noCredentials'), 'error'); return; }
                testPlatform('qq', { appID: qqAppId.trim(), appSecret: qqAppSecret.trim() }, e.currentTarget);
              }}
            >
              {t('settings.bridge.test')}
            </button>
          </div>
          <span className="settings-field-hint">{t('settings.bridge.qqHint')}</span>
        </div>
        <OwnerSelect
          platform_="qq"
          users={status?.knownUsers?.qq || []}
          currentOwner={status?.owner?.qq}
          onChange={(userId) => setOwner('qq', userId)}
        />
      </section>

      {/* 微信 ClawBot */}
      <section className="settings-section">
        <h2 className="settings-section-title">微信 ClawBot</h2>
        <div className="bridge-platform-header">
          <BridgeStatusDot status={wxInfo.status} />
          <BridgeStatusText status={wxInfo.status} error={wxInfo.error} />
          {wxInfo.configured && (
            <Toggle
              on={!!wxInfo.enabled}
              onChange={async (on) => {
                await saveBridgeConfig('wechat', null, on);
              }}
            />
          )}
        </div>

        {/* 未配置：显示登录按钮 */}
        {!wxInfo.configured && wxLoginState === 'idle' && (
          <div className="settings-field">
            <button className="bridge-wechat-login-btn" onClick={startWxLogin}>
              🔗 扫码连接微信
            </button>
            <span className="settings-field-hint">
              通过微信 ClawBot 插件连接，扫码后即可在微信中与 Hanako 对话
            </span>
          </div>
        )}

        {/* 已配置：显示状态信息 */}
        {wxInfo.configured && (
          <div className="settings-field">
            <span className="settings-field-hint">
              已连接微信 ClawBot{wxInfo.tokenMasked ? `（Token: ${wxInfo.tokenMasked}）` : ''}
            </span>
            <button
              className="bridge-wechat-relogin-btn"
              onClick={() => { setWxLoginState('idle'); startWxLogin(); }}
            >
              重新扫码连接
            </button>
          </div>
        )}

        {/* 扫码登录流程 */}
        {wxLoginState !== 'idle' && (
          <div className="bridge-wechat-qr-section">
            {wxQrcodeUrl && (
              <div className="bridge-wechat-qr-wrapper">
                <img src={wxQrcodeUrl} alt="微信扫码" className="bridge-wechat-qr-img" />
              </div>
            )}
            <p className="bridge-wechat-login-msg">
              {wxLoginState === 'polling' && '⏳ '}
              {wxLoginState === 'success' && '✅ '}
              {wxLoginState === 'error' && '❌ '}
              {wxLoginMsg}
            </p>
            {(wxLoginState === 'error' || wxLoginState === 'success') && (
              <button
                className="bridge-wechat-login-btn"
                onClick={() => { setWxLoginState('idle'); if (wxLoginState === 'error') startWxLogin(); }}
              >
                {wxLoginState === 'error' ? '重试' : '完成'}
              </button>
            )}
          </div>
        )}

        <OwnerSelect
          platform_="wechat"
          users={status?.knownUsers?.wechat || []}
          currentOwner={status?.owner?.wechat}
          onChange={(userId) => setOwner('wechat', userId)}
        />
      </section>

      {/* 企业微信智能机器人 */}
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.bridge.workwechat') || '企业微信智能机器人'}</h2>
        <div className="bridge-platform-header">
          <BridgeStatusDot status={wcInfo.status} />
          <BridgeStatusText status={wcInfo.status} error={wcInfo.error} />
          <Toggle
            on={!!wcInfo.enabled}
            onChange={async (on) => {
              const botId = wcBotId || '';
              const secret = wcSecret || '';
              const hasSaved = !!wcInfo.secretMasked;
              if (on && !botId && !secret && !hasSaved) {
                showToast('请输入 Bot ID 和 Secret', 'error');
                return;
              }
              await saveBridgeConfig('workwechat', (botId && secret) ? { botId, secret } : null, on);
            }}
          />
        </div>
        <div className="settings-field">
          <label className="settings-field-label">Bot ID</label>
          <input
            className="settings-input"
            type="text"
            value={wcBotId}
            onChange={(e) => setWcBotId(e.target.value)}
            onBlur={async () => {
              if (wcBotId.trim() && wcSecret.trim()) {
                await saveBridgeConfig('workwechat', { botId: wcBotId.trim(), secret: wcSecret.trim() }, undefined);
              }
            }}
          />
        </div>
        <div className="settings-field">
          <label className="settings-field-label">Secret</label>
          <div className="bridge-input-row">
            <KeyInput
              value={wcSecret}
              onChange={setWcSecret}
              placeholder={wcInfo.secretMasked || ''}
              onBlur={async () => {
                if (wcBotId.trim() && wcSecret.trim()) {
                  await saveBridgeConfig('workwechat', { botId: wcBotId.trim(), secret: wcSecret.trim() }, undefined);
                }
              }}
            />
            <button
              className="bridge-test-btn"
              onClick={(e) => {
                if (!wcBotId.trim() || !wcSecret.trim()) { showToast('请输入 Bot ID 和 Secret', 'error'); return; }
                const btn = e.currentTarget as HTMLButtonElement;
                console.log('[bridge test] workwechat button clicked, botId=', wcBotId.trim());
                testPlatform('workwechat', { botId: wcBotId.trim(), secret: wcSecret.trim() }, btn);
              }}
            >
              {t('settings.bridge.test')}
            </button>
          </div>
          <span className="settings-field-hint">{t('settings.bridge.workwechatHint') || '在企业微信管理后台创建智能机器人，获取 Bot ID 和 Secret'}</span>
        </div>
        {/* 用户昵称映射 */}
        <div className="settings-field">
          <label className="settings-field-label">{t('settings.bridge.userMap') || '用户昵称映射'}</label>
          <span className="settings-field-hint">{t('settings.bridge.userMapHint') || '配置企业微信用户的 userid 对应的显示昵称'}</span>
          {/* 已有映射列表 */}
          {Object.keys(wcUserMap).length > 0 && (
            <div className="bridge-usermap-list">
              {Object.entries(wcUserMap).map(([uid, name]) => (
                <div key={uid} className="bridge-usermap-row">
                  <span className="bridge-usermap-id">{uid}</span>
                  <span className="bridge-usermap-arrow">→</span>
                  <span className="bridge-usermap-name">{name}</span>
                  <button
                    className="bridge-usermap-remove"
                    onClick={async () => {
                      const next = { ...wcUserMap };
                      delete next[uid];
                      setWcUserMap(next);
                      await saveBridgeConfig('workwechat', null, undefined, undefined, undefined, next);
                    }}
                    title="删除"
                  >✕</button>
                </div>
              ))}
            </div>
          )}
          {/* 添加新映射 */}
          <div className="bridge-usermap-add-row">
            <input
              className="settings-input bridge-usermap-input"
              type="text"
              placeholder="User ID"
              value={wcNewUserId}
              onChange={(e) => setWcNewUserId(e.target.value)}
            />
            <input
              className="settings-input bridge-usermap-input"
              type="text"
              placeholder="昵称"
              value={wcNewUserName}
              onChange={(e) => setWcNewUserName(e.target.value)}
            />
            <button
              className="bridge-test-btn"
              onClick={async () => {
                if (!wcNewUserId.trim() || !wcNewUserName.trim()) {
                  showToast('请输入 User ID 和昵称', 'error');
                  return;
                }
                const next = { ...wcUserMap, [wcNewUserId.trim()]: wcNewUserName.trim() };
                setWcUserMap(next);
                setWcNewUserId('');
                setWcNewUserName('');
                await saveBridgeConfig('workwechat', null, undefined, undefined, undefined, next);
                showToast(t('settings.saved'), 'success');
              }}
            >
              {t('settings.bridge.addUserMap') || '添加'}
            </button>
          </div>
        </div>
        <OwnerSelect
          platform_="workwechat"
          users={status?.knownUsers?.workwechat || []}
          currentOwner={status?.owner?.workwechat}
          onChange={(userId) => setOwner('workwechat', userId)}
        />
      </section>

      {/* WhatsApp */}
      <section className="settings-section">
        <h2 className="settings-section-title">WhatsApp</h2>
        <div className="bridge-platform-header">
          <BridgeStatusDot status={waInfo.status} />
          <BridgeStatusText status={waInfo.status} error={waInfo.error} />
          <Toggle
            on={!!waInfo.enabled}
            onChange={async (on) => {
              await saveBridgeConfig('whatsapp', null, on);
            }}
          />
        </div>
        <div className="settings-field">
          <span className="settings-field-hint">{t('settings.bridge.whatsappHint')}</span>
        </div>
        <OwnerSelect
          platform_="whatsapp"
          users={status?.knownUsers?.whatsapp || []}
          currentOwner={status?.owner?.whatsapp}
          onChange={(userId) => setOwner('whatsapp', userId)}
        />
      </section>

      {/* 只读模式 */}
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.bridge.readOnly')}</h2>
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
                showToast(t('settings.saved'), 'success');
                await loadStatus();
              } catch {
                showToast(t('settings.saveFailed'), 'error');
              }
            }}
          />
        </div>
      </section>
    </div>
  );
}

function BridgeStatusDot({ status }: { status?: string }) {
  let cls = 'bridge-status-dot';
  if (status === 'connected') cls += ' bridge-dot-ok';
  else if (status === 'error') cls += ' bridge-dot-err';
  else cls += ' bridge-dot-off';
  return <span className={cls} />;
}

function BridgeStatusText({ status, error }: { status?: string; error?: string }) {
  let text = t('settings.bridge.disconnected');
  if (status === 'connected') text = t('settings.bridge.connected');
  else if (status === 'error') text = t('settings.bridge.error') + (error ? `: ${error}` : '');
  return <span className="bridge-status-text">{text}</span>;
}

function OwnerSelect({ platform_, users, currentOwner, onChange }: {
  platform_: string; users: any[]; currentOwner?: string; onChange: (userId: string) => void;
}) {
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);

  const handleChange = (value: string) => {
    if (!value) {
      onChange(value);
      return;
    }
    setPendingUserId(value);
  };

  const confirm = () => {
    if (pendingUserId !== null) {
      onChange(pendingUserId);
      setPendingUserId(null);
    }
  };

  const cancel = () => setPendingUserId(null);

  return (
    <div className="settings-field bridge-owner-field">
      <label className="settings-field-label bridge-owner-label">{t('settings.bridge.ownerSelect')}</label>
      <p className="bridge-owner-warning">{t('settings.bridge.ownerWarning')}</p>
      <select
        className="settings-input bridge-owner-select"
        value={currentOwner || ''}
        onChange={(e) => handleChange(e.target.value)}
        disabled={users.length === 0}
      >
        <option value="">{users.length > 0 ? '—' : t('settings.bridge.ownerNone')}</option>
        {users.map((u: any) => (
          <option key={u.userId} value={u.userId}>{u.name || u.userId}</option>
        ))}
      </select>

      {pendingUserId !== null && (
        <div className="memory-confirm-overlay visible" onClick={(e) => { if (e.target === e.currentTarget) cancel(); }}>
          <div className="memory-confirm-card">
            <p className="memory-confirm-text">
              {t('settings.bridge.ownerConfirmText')}
            </p>
            <div className="memory-confirm-actions">
              <button className="memory-confirm-cancel" onClick={cancel}>
                {t('settings.bridge.ownerConfirmCancel')}
              </button>
              <button className="memory-confirm-primary" onClick={confirm}>
                {t('settings.bridge.ownerConfirmSave')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
