import { useState, useEffect, useMemo } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t, autoSaveConfig } from '../helpers';
import { SelectWidget } from '../widgets/SelectWidget';
import { browseAgent, switchToAgent, loadSettingsConfig, loadAgents } from '../actions';
import { AgentCardStack } from './agent/AgentCardStack';
import { YuanSelector } from './agent/YuanSelector';
import { MemorySection } from './agent/AgentMemory';
import { AgentToolsSection } from './agent/AgentToolsSection';
import styles from '../Settings.module.css';
import {
  type ExpCategory, parseExperience,
  ExperienceBlock, putExperience,
} from './agent/AgentExperience';

const platform = window.platform;

export function AgentTab() {
  const store = useSettingsStore();
  const {
    agents, currentAgentId, settingsConfig, currentPins,
    showToast,
    globalModelsConfig,
  } = store;

  const hasUtilityModel = !!(globalModelsConfig?.models?.utility && globalModelsConfig?.models?.utility_large);
  const settingsAgentId = store.getSettingsAgentId();

  const [agentName, setAgentName] = useState('');
  const [identity, setIdentity] = useState('');
  const [ishiki, setIshiki] = useState('');
  const [expCategories, setExpCategories] = useState<ExpCategory[]>([]);

  useEffect(() => {
    if (settingsConfig) {
      setAgentName(settingsConfig.agent?.name || '');
      setIdentity(settingsConfig._identity || '');
      setIshiki(settingsConfig._ishiki || '');
      setExpCategories(parseExperience(settingsConfig._experience || ''));
    }
  }, [settingsConfig]);

  const isViewingOther = settingsAgentId !== currentAgentId;
  const currentYuan = settingsConfig?.agent?.yuan || 'hanako';

  const chatRaw = settingsConfig?.models?.chat;
  const currentModel = typeof chatRaw === 'object' && chatRaw?.id ? chatRaw.id : (chatRaw || '');

  // 从唯一信源 /api/models 获取模型列表（和聊天页一致）
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string; provider: string }>>([]);
  useEffect(() => {
    hanaFetch('/api/models').then(r => r.json()).then(data => {
      setAvailableModels(data.models || []);
    }).catch(() => {});
  }, [settingsConfig]); // settingsConfig 变化时刷新

  const modelOptions = useMemo(() => {
    const opts = availableModels.map(m => ({ value: m.id, label: m.name || m.id, group: m.provider }));
    if (currentModel && !availableModels.some(m => m.id === currentModel)) {
      opts.unshift({ value: currentModel, label: currentModel, group: '' });
    }
    return opts;
  }, [availableModels, currentModel]);

  const memoryEnabled = settingsConfig?.memory?.enabled !== false;

  const saveAgent = async () => {
    try {
      const agentId = store.getSettingsAgentId()!;
      const agentBase = `/api/agents/${agentId}`;
      const isActive = agentId === currentAgentId;

      const configPartial: Record<string, unknown> = {};
      if (agentName && agentName !== (settingsConfig?.agent?.name || '')) {
        configPartial.agent = { name: agentName };
      }

      const identityChanged = identity !== (settingsConfig?._identity || '');
      const ishikiChanged = ishiki !== (settingsConfig?._ishiki || '');

      if (!Object.keys(configPartial).length && !identityChanged && !ishikiChanged) {
        showToast(t('settings.noChanges'), 'success');
        return;
      }

      const requests: Promise<Response>[] = [];
      if (Object.keys(configPartial).length) {
        requests.push(hanaFetch(`${agentBase}/config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(configPartial),
        }));
      }
      if (identityChanged) {
        requests.push(hanaFetch(`${agentBase}/identity`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: identity }),
        }));
      }
      if (ishikiChanged) {
        requests.push(hanaFetch(`${agentBase}/ishiki`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: ishiki }),
        }));
      }

      const results = await Promise.all(requests);
      for (const res of results) {
        const data = await res.json();
        if (data.error) throw new Error(data.error);
      }

      showToast(t('settings.saved'), 'success');
      if (isActive && (configPartial as { agent?: { name: string } })?.agent?.name) {
        store.set({ agentName: (configPartial as { agent: { name: string } }).agent.name });
        platform?.settingsChanged?.('agent-updated', {
          agentName: (configPartial as { agent: { name: string } }).agent.name,
          agentId,
        });
      }
      await loadSettingsConfig();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    }
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="agent">
      {/* Agent 卡片堆叠 */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.agent.title')}</h2>
        <AgentCardStack
          agents={agents}
          selectedId={settingsAgentId}
          currentAgentId={currentAgentId}
          onSelect={(id) => browseAgent(id)}
          onAvatarClick={() => {
            // eslint-disable-next-line no-restricted-syntax -- ephemeral file picker, not part of React tree
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/png,image/jpeg,image/webp';
            input.addEventListener('change', () => {
              if (input.files?.[0]) {
                window.dispatchEvent(new CustomEvent('hana-open-cropper', {
                  detail: { role: 'agent', file: input.files[0] },
                }));
              }
            });
            input.click();
          }}
          onSetActive={(id) => switchToAgent(id)}
          onDelete={() => window.dispatchEvent(new Event('hana-show-agent-delete'))}
          onAdd={() => window.dispatchEvent(new Event('hana-show-agent-create'))}
        />

        <div className={`${styles['settings-field']} ${styles['settings-field-center']}`}>
          <input
            className={styles['agent-name-input']}
            type="text"
            value={agentName}
            placeholder={t('settings.agent.agentNameHint')}
            onChange={(e) => setAgentName(e.target.value)}
          />
        </div>
        <div className={`${styles['settings-field']} ${styles['settings-field-center']}`}>
          <div className={styles['model-capsule']}>
            <span className={styles['model-capsule-label']}>{t('settings.agent.chatModel')}</span>
            <SelectWidget
              options={modelOptions}
              value={currentModel}
              onChange={async (modelId) => {
                const match = availableModels.find(m => m.id === modelId);
                const partial: Record<string, unknown> = {
                  models: { chat: { id: modelId, provider: match?.provider || '' } },
                };
                await autoSaveConfig(partial, { refreshModels: true });
              }}
              placeholder={t('settings.api.selectModel')}
            />
          </div>
          <span className={styles['settings-field-hint']}>{t('settings.agent.chatModelHint')}</span>
        </div>
        {/* 图片模型选择器暂时隐藏，后续重新设计 */}
      </section>

      {/* 关于 Ta */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.about.title')}</h2>
        <div className={`${styles['settings-field']} ${styles['settings-field-center']}`}>
          <span className={styles['settings-field-hint']}>{t('settings.agent.yuanHint')}</span>
          <YuanSelector
            currentYuan={currentYuan}
            onChange={async (key) => {
              const agentId = store.getSettingsAgentId()!;
              try {
                await hanaFetch(`/api/agents/${agentId}/config`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ agent: { yuan: key } }),
                });
                if (agentId === currentAgentId) store.set({ agentYuan: key });
                platform?.settingsChanged?.('agent-updated', { agentId, yuan: key });
                await loadSettingsConfig();
                await loadAgents();
              } catch (err) {
                console.error('[yuan] switch failed:', err);
              }
            }}
          />
        </div>
        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{t('settings.agent.identity')}</label>
          <textarea
            className={styles['settings-textarea']}
            rows={3}
            spellCheck={false}
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
          />
          <span className={styles['settings-field-hint']}>{t('settings.agent.identityHint')}</span>
        </div>
        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{t('settings.agent.ishiki')}</label>
          <textarea
            className={styles['settings-textarea']}
            rows={10}
            spellCheck={false}
            value={ishiki}
            onChange={(e) => setIshiki(e.target.value)}
          />
          <span className={styles['settings-field-hint']}>{t('settings.agent.ishikiHint')}</span>
        </div>
        <div className={styles['settings-field']} style={{ display: 'flex', justifyContent: 'center' }}>
          <button className={styles['settings-save-btn-sm']} onClick={saveAgent}>
            {t('settings.save')}
          </button>
        </div>
      </section>

      <MemorySection
        hasUtilityModel={hasUtilityModel}
        memoryEnabled={memoryEnabled}
        isViewingOther={isViewingOther}
        currentPins={currentPins}
      />

      {/* 经验 */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.experience.title')}</h2>
        <p className={styles['settings-hint']}>{t('settings.experience.hint')}</p>
        {expCategories.length === 0 ? (
          <div className={styles['exp-empty']}>{t('settings.experience.empty')}</div>
        ) : (
          <div className={styles['exp-list']}>
            {expCategories.map((cat) => (
              <ExperienceBlock
                key={cat.name}
                category={cat}
                onSave={(updated) => {
                  const next = expCategories.map(c => c.name === cat.name ? updated : c);
                  setExpCategories(next);
                  putExperience(store, next);
                }}
                onDelete={() => {
                  const next = expCategories.filter(c => c.name !== cat.name);
                  setExpCategories(next);
                  putExperience(store, next);
                }}
              />
            ))}
          </div>
        )}
      </section>

      {/* 默认关闭 update_settings 和 dm，与后端 DEFAULT_DISABLED_TOOL_NAMES 保持同步 */}
      <AgentToolsSection
        availableTools={settingsConfig?.availableTools || []}
        disabled={settingsConfig?.tools?.disabled ?? ["update_settings", "dm"]}
      />

    </div>
  );
}
