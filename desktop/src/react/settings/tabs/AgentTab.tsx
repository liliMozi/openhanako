import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch, hanaUrl, yuanFallbackAvatar } from '../api';
import { t, autoSaveConfig, savePins } from '../helpers';
import { SelectWidget } from '../widgets/SelectWidget';
import { browseAgent, switchToAgent, loadSettingsConfig, loadAgents } from '../actions';

import kongBannerUrl from '../../../assets/kong-banner.jpg';

const platform = (window as any).platform;

interface ExpCategory { name: string; entries: string[]; }

function parseExperience(raw: string): ExpCategory[] {
  if (!raw?.trim()) return [];
  const cats: ExpCategory[] = [];
  let cur: ExpCategory | null = null;
  for (const line of raw.split('\n')) {
    const m = line.match(/^#\s+(.+)/);
    if (m) {
      cur = { name: m[1].trim(), entries: [] };
      cats.push(cur);
    } else if (cur) {
      const entry = line.replace(/^\d+\.\s*/, '').trim();
      if (entry) cur.entries.push(entry);
    }
  }
  return cats;
}

function serializeExperience(cats: ExpCategory[]): string {
  return cats
    .filter(c => c.entries.length > 0)
    .map(c => `# ${c.name}\n${c.entries.map((e, i) => `${i + 1}. ${e}`).join('\n')}`)
    .join('\n\n') + (cats.length ? '\n' : '');
}

export function AgentTab() {
  const store = useSettingsStore();
  const {
    agents, currentAgentId, settingsConfig, currentPins,
    pendingFavorites, pendingDefaultModel, showToast,
    globalModelsConfig,
  } = store;

  // 记忆系统需要 utility 模型才能工作
  const hasUtilityModel = !!(globalModelsConfig?.models?.utility && globalModelsConfig?.models?.utility_large);
  const settingsAgentId = store.getSettingsAgentId();

  const [agentName, setAgentName] = useState('');
  const [identity, setIdentity] = useState('');
  const [ishiki, setIshiki] = useState('');
  const [pinInput, setPinInput] = useState('');
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

  // Agent 对话模型
  const currentModel = settingsConfig?.models?.chat || pendingDefaultModel || '';
  const modelOptions = [...pendingFavorites].map(mid => ({ value: mid, label: mid }));
  if (currentModel && !pendingFavorites.has(currentModel)) {
    modelOptions.unshift({ value: currentModel, label: currentModel });
  }

  const addPin = () => {
    const val = pinInput.trim();
    if (!val) return;
    const newPins = [...currentPins, val];
    useSettingsStore.setState({ currentPins: newPins });
    setPinInput('');
    savePins();
  };

  const deletePin = (index: number) => {
    const newPins = [...currentPins];
    newPins.splice(index, 1);
    useSettingsStore.setState({ currentPins: newPins });
    savePins();
  };

  const saveAgent = async () => {
    try {
      const agentId = store.getSettingsAgentId()!;
      const agentBase = `/api/agents/${agentId}`;
      const isActive = agentId === currentAgentId;

      const configPartial: Record<string, any> = {};
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
      if (isActive && configPartial?.agent?.name) {
        store.set({ agentName: configPartial.agent.name });
        platform?.settingsChanged?.('agent-updated', {
          agentName: configPartial.agent.name,
          agentId,
        });
      }
      await loadSettingsConfig();
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  return (
    <div className="settings-tab-content active" data-tab="agent">
      {/* Agent 卡片堆叠 */}
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.agent.title')}</h2>
        <AgentCardStack
          agents={agents}
          selectedId={settingsAgentId}
          currentAgentId={currentAgentId}
          onSelect={(id) => browseAgent(id)}
          onAvatarClick={() => {
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
          onAvatarRemove={async () => {
            const agentId = store.getSettingsAgentId();
            if (!agentId) return;
            try {
              await hanaFetch(`/api/agents/${agentId}/avatar`, { method: 'DELETE' });
              await loadAgents();
              if (agentId === currentAgentId) {
                platform?.settingsChanged?.('agent-updated', { agentId });
              }
              store.showToast(t('settings.agent.avatarRemoved'), 'success');
            } catch (err: any) {
              store.showToast(err.message, 'error');
            }
          }}
        >
          <div className="agent-stack-actions">
            {isViewingOther && (
              <button
                className="settings-btn-primary"
                onClick={() => switchToAgent(settingsAgentId!)}
              >
                {t('settings.agent.setActive')}
              </button>
            )}
            <button
              className="agent-add-btn"
              title={t('settings.agent.addAgent')}
              onClick={() => window.dispatchEvent(new Event('hana-show-agent-create'))}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            {agents.length >= 2 && isViewingOther && (
              <button
                className="agent-delete-btn"
                title={t('settings.agent.deleteBtn')}
                onClick={() => window.dispatchEvent(new Event('hana-show-agent-delete'))}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            )}
          </div>
        </AgentCardStack>

        <div className="settings-field settings-field-center">
          <span className="settings-field-hint">{t('settings.agent.agentNameHint')}</span>
          <input
            className="settings-input"
            type="text"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
          />
        </div>
      </section>

      {/* 关于 Ta */}
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.about.title')}</h2>
        <div className="settings-field">
          <label className="settings-field-label">{t('settings.agent.yuan')}</label>
          <span className="settings-field-hint">{t('settings.agent.yuanHint')}</span>
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
        <div className="settings-field">
          <label className="settings-field-label">{t('settings.agent.identity')}</label>
          <textarea
            className="settings-textarea"
            rows={3}
            spellCheck={false}
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
          />
          <span className="settings-field-hint">{t('settings.agent.identityHint')}</span>
        </div>
        <div className="settings-field">
          <label className="settings-field-label">{t('settings.agent.ishiki')}</label>
          <textarea
            className="settings-textarea"
            rows={10}
            spellCheck={false}
            value={ishiki}
            onChange={(e) => setIshiki(e.target.value)}
          />
          <span className="settings-field-hint">{t('settings.agent.ishikiHint')}</span>
        </div>
        <div className="settings-field">
          <label className="settings-field-label">{t('settings.agent.chatModel')}</label>
          <SelectWidget
            options={modelOptions}
            value={currentModel}
            onChange={async (modelId) => {
              store.set({ pendingDefaultModel: modelId });
              const partial: Record<string, any> = { models: { chat: modelId } };
              const providers = settingsConfig?.providers || {};
              for (const [name, p] of Object.entries(providers) as [string, any][]) {
                if ((p.models || []).includes(modelId)) {
                  partial.api = { provider: name };
                  break;
                }
              }
              await autoSaveConfig(partial, { refreshModels: true });
            }}
            placeholder={t('settings.api.selectModel')}
          />
          <span className="settings-field-hint">{t('settings.agent.chatModelHint')}</span>
        </div>
      </section>

      {/* ── 记忆 ── */}
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.memory.sectionTitle')}</h2>

        {/* 记忆开关 */}
        <div className="settings-subsection">
          <div className="settings-section-header">
            <h3 className="settings-subsection-title">{t('settings.memory.title')}</h3>
            <button
              className={`hana-toggle${hasUtilityModel && settingsConfig?.memory?.enabled !== false ? ' on' : ''}${!hasUtilityModel ? ' disabled' : ''}`}
              onClick={() => hasUtilityModel && autoSaveConfig({ memory: { enabled: settingsConfig?.memory?.enabled === false } })}
              disabled={!hasUtilityModel}
              title={!hasUtilityModel ? t('settings.memory.needsUtilityModel') : undefined}
            />
          </div>
          {!hasUtilityModel && (
            <p className="settings-hint" style={{ opacity: 0.6, marginTop: 4 }}>{t('settings.memory.needsUtilityModel')}</p>
          )}
        </div>

        <div className={!hasUtilityModel || settingsConfig?.memory?.enabled === false ? 'settings-disabled' : ''}>

        {/* 置顶记忆 */}
        <div className="settings-subsection">
          <div className="settings-subsection-header">
            <h3 className="settings-subsection-title">{t('settings.pins.title')}</h3>
            <span className="settings-subsection-hint">{t('settings.pins.hint')}</span>
          </div>
          <div className="pin-list">
            {currentPins.length === 0 ? (
              <div className="pin-empty">{t('settings.pins.empty')}</div>
            ) : (
              currentPins.map((pin, i) => (
                <PinItem key={pin} text={pin} index={i} onDelete={deletePin} />
              ))
            )}
          </div>
          <div className="pin-add-row">
            <input
              className="settings-input pin-add-input"
              type="text"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPin(); } }}
              placeholder={t('settings.pins.addPlaceholder')}
            />
            <button className="pin-add-btn" onClick={addPin}>+</button>
          </div>
        </div>

        {/* 当下记忆 */}
        <div className="settings-subsection">
          <div className="settings-subsection-header">
            <h3 className="settings-subsection-title">{t('settings.memory.compiled')}</h3>
            <span className="settings-subsection-hint">{t('settings.memory.compiledHint')}</span>
          </div>
          <button
            className="memory-action-btn compiled-view-btn"
            onClick={() => window.dispatchEvent(new Event('hana-view-compiled-memory'))}
          >
            {t('settings.memory.compiledView')}
          </button>
        </div>

        {/* 所有记忆 */}
        <div className="settings-subsection">
          <h3 className="settings-subsection-title">{t('settings.memory.allMemories')}</h3>
          <div className="memory-actions-row memory-actions-spaced">
            <button
              className="memory-action-btn"
              onClick={() => window.dispatchEvent(new Event('hana-view-memories'))}
            >
              {t('settings.memory.actions.view')}
            </button>
            <button
              className="memory-action-btn danger"
              onClick={() => window.dispatchEvent(new Event('hana-show-clear-confirm'))}
            >
              {t('settings.memory.actions.clear')}
            </button>
            <MemoryMoreDropdown isViewingOther={isViewingOther} />
          </div>
        </div>

        </div>{/* settings-disabled wrapper */}
      </section>

      {/* 经验 */}
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.experience.title')}</h2>
        <p className="settings-hint">{t('settings.experience.hint')}</p>
        {expCategories.length === 0 ? (
          <div className="exp-empty">{t('settings.experience.empty')}</div>
        ) : (
          <div className="exp-list">
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

      <div className="settings-section-footer">
        <button className="settings-save-btn-sm" onClick={saveAgent}>
          {t('settings.save')}
        </button>
      </div>
    </div>
  );
}

// ── Experience ──

async function putExperience(store: any, cats: ExpCategory[]) {
  try {
    const agentId = store.getSettingsAgentId();
    const content = serializeExperience(cats);
    const res = await hanaFetch(`/api/agents/${agentId}/experience`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
  } catch (err: any) {
    store.showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
  }
}

function ExperienceBlock({ category, onSave, onDelete }: {
  category: ExpCategory;
  onSave: (updated: ExpCategory) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const startEdit = () => {
    setEditVal(category.entries.map((e, i) => `${i + 1}. ${e}`).join('\n'));
    setEditing(true);
  };

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [editing]);

  const saveEdit = () => {
    const entries = editVal
      .split('\n')
      .map(l => l.replace(/^\d+\.\s*/, '').trim())
      .filter(Boolean);
    onSave({ name: category.name, entries });
    setEditing(false);
  };

  return (
    <div className="exp-block">
      <div className="exp-block-header">
        <span className="exp-block-title">{category.name}</span>
        <div className="exp-block-actions">
          <button
            className="exp-block-action"
            title="编辑"
            onClick={startEdit}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
          <button
            className="exp-block-action delete"
            title="删除分类"
            onClick={onDelete}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
      {editing ? (
        <textarea
          ref={textareaRef}
          className="exp-block-editor"
          value={editVal}
          onChange={(e) => setEditVal(e.target.value)}
          onBlur={saveEdit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setEditing(false); }
          }}
          spellCheck={false}
        />
      ) : (
        <div className="exp-block-body">
          {category.entries.map((entry, i) => (
            <div key={i} className="exp-entry">
              <span className="exp-entry-num">{i + 1}.</span>
              <span className="exp-entry-text">{entry}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──

function PinItem({ text, index, onDelete }: { text: string; index: number; onDelete: (i: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState(text);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = () => {
    const val = editVal.trim();
    const pins = [...useSettingsStore.getState().currentPins];
    if (val && val !== text) {
      pins[index] = val;
      useSettingsStore.setState({ currentPins: pins });
      savePins();
    } else if (!val) {
      pins.splice(index, 1);
      useSettingsStore.setState({ currentPins: pins });
      savePins();
    }
    setEditing(false);
  };

  return (
    <div className="pin-item">
      {editing ? (
        <input
          ref={inputRef}
          className="settings-input pin-edit-input"
          value={editVal}
          onChange={(e) => setEditVal(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); inputRef.current?.blur(); }
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <span className="pin-item-text" title={text} onClick={() => { setEditVal(text); setEditing(true); }}>
          {text}
        </span>
      )}
      <div className="pin-item-actions">
        <button className="pin-item-action delete" title={t('settings.pins.delete')} onClick={() => onDelete(index)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function YuanSelector({ currentYuan, onChange }: { currentYuan: string; onChange: (key: string) => void }) {
  const types = t('yuan.types') || {};
  const entries = Object.entries(types) as [string, any][];
  const hIdx = entries.findIndex(([k]) => k === 'hanako');
  if (hIdx >= 0 && entries.length >= 3) {
    const [h] = entries.splice(hIdx, 1);
    entries.splice(1, 0, h);
  }

  const chips = entries.filter(([k]) => k !== 'kong');
  const kongMeta = (types as any).kong;

  return (
    <div className="yuan-selector">
      <div className="yuan-chips">
        {chips.map(([key, meta]) => (
          <button
            key={key}
            className={`yuan-chip${key === currentYuan ? ' selected' : ''}`}
            type="button"
            onClick={() => { if (key !== currentYuan) onChange(key); }}
          >
            <img
              className="yuan-chip-avatar"
              src={`assets/${meta.avatar || 'Hanako.png'}`}
              draggable={false}
            />
            <div className="yuan-chip-info">
              <span className="yuan-chip-name">{key}</span>
              <span className="yuan-chip-desc">{meta.label || ''}</span>
            </div>
          </button>
        ))}
      </div>
      {kongMeta && (
        <button
          className={`yuan-kong-banner${currentYuan === 'kong' ? ' selected' : ''}`}
          type="button"
          style={{ backgroundImage: `url(${kongBannerUrl})` }}
          onClick={() => { if (currentYuan !== 'kong') onChange('kong'); }}
        >
          <span className="yuan-kong-name">空</span>
          <span className="yuan-kong-desc">{kongMeta.label || ''}</span>
        </button>
      )}
    </div>
  );
}

function AgentCardStack({ agents, selectedId, currentAgentId, onSelect, onAvatarClick, onAvatarRemove, children }: {
  agents: any[];
  selectedId: string | null;
  currentAgentId: string | null;
  onSelect: (id: string) => void;
  onAvatarClick: () => void;
  onAvatarRemove: () => void;
  children?: React.ReactNode;
}) {
  const cardsRef = useRef<HTMLDivElement>(null);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  const n = agents.length;
  const stepTight = n > 1 ? Math.min(4, 16 / (n - 1)) : 0;
  const spreadStep = 62;
  const spreadOffset = -(n - 1) * spreadStep / 2;
  const spreadWidth = Math.max(240, (n - 1) * spreadStep + 72);
  const ts = Date.now();

  // 原生 DOM 事件挂载拖拽（完全绕过 React 合成事件）
  useEffect(() => {
    const container = cardsRef.current;
    if (!container) return;

    const handlers: Array<[HTMLElement, (e: PointerEvent) => void]> = [];

    const cards = [...container.children] as HTMLElement[];
    cards.forEach((card, dragIdx) => {
      const handler = (e: PointerEvent) => {
        if (e.button !== 0) return;
        if (!container.matches(':hover')) return;

        e.preventDefault();
        card.setPointerCapture(e.pointerId);

        const startX = e.clientX;
        const startY = e.clientY;
        let moved = false;
        let dropIdx = dragIdx;

        const allCards = [...container.children] as HTMLElement[];
        const positions = allCards.map(c => parseFloat(c.style.getPropertyValue('--tx-spread')) || 0);
        const origTx = positions[dragIdx];

        const onMove = (ev: PointerEvent) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;

          if (!moved) {
            moved = true;
            card.classList.add('dragging');
            card.dataset.wasDragged = '1';
          }

          card.style.transform = `rotate(0deg) translateX(${origTx + dx}px) translateY(-4px)`;

          const currentPos = origTx + dx;
          let newIdx = dragIdx;
          for (let j = 0; j < positions.length; j++) {
            if (j === dragIdx) continue;
            if (dragIdx < j && currentPos > positions[j] - 15) newIdx = j;
            if (dragIdx > j && currentPos < positions[j] + 15) newIdx = Math.min(newIdx, j);
          }

          allCards.forEach((c, ci) => {
            if (c === card) return;
            if (ci >= Math.min(dragIdx, newIdx) && ci <= Math.max(dragIdx, newIdx) && newIdx !== dragIdx) {
              const shift = dragIdx < newIdx ? -spreadStep : spreadStep;
              c.style.transform = `rotate(0deg) translateX(${positions[ci] + shift}px)`;
            } else {
              c.style.transform = `rotate(0deg) translateX(${positions[ci]}px)`;
            }
            c.style.transition = 'transform 0.2s var(--ease-out)';
          });

          dropIdx = newIdx;
        };

        const onUp = () => {
          card.removeEventListener('pointermove', onMove);
          card.removeEventListener('pointerup', onUp);
          card.classList.remove('dragging');

          allCards.forEach(c => { c.style.transform = ''; c.style.transition = ''; });

          if (!moved) return;

          if (dropIdx !== dragIdx) {
            const currentAgents = agentsRef.current;
            const reordered = [...currentAgents];
            const [movedAgent] = reordered.splice(dragIdx, 1);
            reordered.splice(dropIdx, 0, movedAgent);
            useSettingsStore.setState({ agents: reordered });
            hanaFetch('/api/agents/order', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ order: reordered.map(a => a.id) }),
            }).catch(err => {
              console.error('[agent-reorder] failed:', err);
              loadAgents();
            });
          }
        };

        card.addEventListener('pointermove', onMove);
        card.addEventListener('pointerup', onUp);
      };

      card.addEventListener('pointerdown', handler);
      handlers.push([card, handler]);
    });

    return () => {
      handlers.forEach(([el, fn]) => el.removeEventListener('pointerdown', fn));
    };
  }, [agents, spreadStep]);

  return (
    <div
      className="agent-card-stack"
      style={{ '--cards-spread-width': spreadWidth } as React.CSSProperties}
    >
      <div className="agent-cards" ref={cardsRef}>
        {agents.map((agent, i) => {
          const rotTight = i * stepTight;
          const txSpread = spreadOffset + i * spreadStep;
          const z = n - i;
          const isSelected = agent.id === selectedId;

          return (
            <div
              key={agent.id}
              className={`agent-card${isSelected ? ' selected' : ''}`}
              data-agent-id={agent.id}
              data-index={i}
              style={{
                '--rot-tight': `${rotTight}deg`,
                '--tx-spread': `${txSpread}px`,
                '--z': z,
                zIndex: z,
              } as React.CSSProperties}
              onClick={(e) => {
                const card = e.currentTarget as HTMLElement;
                if (card.dataset.wasDragged) { delete card.dataset.wasDragged; return; }
                if (isSelected) onAvatarClick();
                else onSelect(agent.id);
              }}
            >
              <div className="agent-card-inner">
                <img
                  className="agent-card-avatar"
                  draggable={false}
                  src={hanaUrl(`/api/agents/${agent.id}/avatar?t=${ts}`)}
                  onError={(e) => {
                    const img = e.target as HTMLImageElement;
                    img.onerror = null;
                    img.src = yuanFallbackAvatar(agent.yuan);
                  }}
                />
                {isSelected && (
                  <div className="agent-card-overlay">
                    <span>{t('settings.agent.changeAvatar')}</span>
                    <button
                      className="agent-avatar-remove-btn"
                      title={t('settings.agent.removeAvatar')}
                      onClick={(e) => { e.stopPropagation(); onAvatarRemove(); }}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
              {agent.id === currentAgentId && <div className="agent-card-badge" />}
              <span className="agent-card-name">{agent.name}</span>
            </div>
          );
        })}
      </div>
      {children}
    </div>
  );
}

function MemoryMoreDropdown({ isViewingOther }: { isViewingOther: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const store = useSettingsStore();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [open]);

  const exportMemories = async () => {
    setOpen(false);
    try {
      const aid = store.getSettingsAgentId();
      const res = await hanaFetch(`/api/memories/export?agentId=${aid}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `hana-memories-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      store.showToast(t('settings.memory.actions.exportSuccess'), 'success');
    } catch (err: any) {
      store.showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  const importMemories = async () => {
    setOpen(false);
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const entries = json.facts || json.memories;
        if (!Array.isArray(entries) || entries.length === 0) {
          store.showToast(t('settings.memory.actions.invalidFile'), 'error');
          return;
        }
        store.showToast(t('settings.memory.actions.importing'), 'success');
        const aid = store.getSettingsAgentId();
        const res = await hanaFetch(`/api/memories/import?agentId=${aid}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ facts: entries }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const msg = t('settings.memory.actions.importSuccess').replace('{count}', data.imported);
        store.showToast(msg, 'success');
      } catch (err: any) {
        store.showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
      }
    });
    input.click();
  };

  return (
    <div className={`memory-action-dropdown${open ? ' open' : ''}`} ref={ref}>
      <button className="memory-action-btn secondary" onClick={() => setOpen(!open)}>
        <span>{t('settings.memory.actions.more')}</span>
        <svg className="memory-more-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <div className="memory-more-popup">
        <button className="memory-more-option" onClick={exportMemories}>
          {t('settings.memory.actions.export')}
        </button>
        <button
          className="memory-more-option"
          onClick={importMemories}
          disabled={isViewingOther}
          title={isViewingOther ? t('settings.memory.activeOnly') : ''}
        >
          {t('settings.memory.actions.import')}
        </button>
      </div>
    </div>
  );
}
