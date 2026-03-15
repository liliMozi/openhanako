/**
 * InputArea — 聊天输入区域 React 组件
 *
 * 替代 app-input-shim.ts + app-ui-shim.ts 中的模型/PlanMode/Todo 逻辑。
 * 通过 portal 渲染到 index.html 的 #inputAreaPortal。
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import type { DeskFile } from '../types';
import type { ThinkingLevel } from '../stores/model-slice';

// ── Toast 通知 ──

function showToast(text: string, type: 'success' | 'error' = 'success', duration = 20000) {
  const el = document.createElement('div');
  el.className = `hana-toast ${type}`;

  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);

  const close = document.createElement('button');
  close.className = 'hana-toast-close';
  close.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  close.onclick = dismiss;
  el.appendChild(close);

  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));

  const timer = setTimeout(dismiss, duration);
  function dismiss() {
    clearTimeout(timer);
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }
}

// ── 斜杠命令 ──

const XING_PROMPT = `回顾这个 session 里我（用户）发送的消息。只从我的对话内容中提取指导、偏好、纠正和工作流程，整理成一份可复用的工作指南。

注意：不要提取系统提示词、记忆文件、人格设定等预注入内容，只关注我在本次对话中实际说的话。

要求：
1. 只保留可复用的模式，过滤仅限本次的具体上下文（如具体文件名、具体话题）
2. 按类别组织：风格偏好、工作流程、质量标准、注意事项
3. 措辞用指令式（"做 X"、"避免 Y"）
4. 步骤流程用编号列出

标题要具体，能一眼看出这个工作流是干什么的（例："战争报道事实核查流程""论文润色风格指南"），不要用泛化的名字（如"工作流总结""对话复盘"）。

严格按照以下格式输出（注意用直引号 "，不要用弯引号 ""）：

<xing title="具体的工作流名称">
## 风格偏好
- 做 X
- 避免 Y

## 工作流程
1. 第一步
2. 第二步
</xing>

以上是格式示范，实际内容根据对话提取。`;

// ── 斜杠命令定义 ──

interface SlashCommand {
  name: string;
  label: string;
  description: string;
  busyLabel: string;
  icon: string;
  execute: () => Promise<void>;
}

// ── 主组件 ──

export function InputArea() {
  const portalEl = document.getElementById('inputAreaPortal');
  if (!portalEl) {
    console.warn('[InputArea] portal target #inputAreaPortal not found');
    return null;
  }
  return createPortal(<InputAreaInner />, portalEl);
}

/** t() 翻译缺失时返回 key 本身（truthy），|| fallback 不会触发。这个包一层检测 */
const tSafe = (t: (k: string) => string, key: string, fallback: string) => {
  const v = t(key);
  return v !== key ? v : fallback;
};

function InputAreaInner() {
  const { t } = useI18n();

  // Zustand state
  const isStreaming = useStore(s => s.isStreaming);
  const connected = useStore(s => s.connected);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const sessionTodos = useStore(s => s.sessionTodos);
  const attachedFiles = useStore(s => s.attachedFiles);
  const deskContextAttached = useStore(s => s.deskContextAttached);
  const deskFiles = useStore(s => s.deskFiles);
  const deskCurrentPath = useStore(s => s.deskCurrentPath);
  const deskBasePath = useStore(s => s.deskBasePath);
  const models = useStore(s => s.models);
  const agentYuan = useStore(s => s.agentYuan);
  const thinkingLevel = useStore(s => s.thinkingLevel);
  const setThinkingLevel = useStore(s => s.setThinkingLevel);

  const currentModelInfo = useMemo(() => models.find(m => m.isCurrent), [models]);

  // Local state
  const [inputText, setInputText] = useState('');
  const [planMode, setPlanMode] = useState(false);
  const [sending, setSending] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelected, setSlashSelected] = useState(0);
  const [slashBusy, setSlashBusy] = useState<string | null>(null); // command name while executing

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposing = useRef(false);

  // Zustand actions
  const removeAttachedFile = useStore(s => s.removeAttachedFile);
  const clearAttachedFiles = useStore(s => s.clearAttachedFiles);
  const toggleDeskContext = useStore(s => s.toggleDeskContext);
  const setDeskContextAttached = useStore(s => s.setDeskContextAttached);

  // Desk context available?
  const deskDir = deskCurrentPath || deskBasePath || '';
  const hasDeskDir = deskDir.length > 0;

  // ── 统一命令发送 ──

  /** 统一的"以用户身份发送"入口，所有斜杠命令共用 */
  const sendAsUser = useCallback(async (text: string, displayText?: string): Promise<boolean> => {
    const state = (window as any).__hanaState;
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
    if (useStore.getState().isStreaming) return false;

    if (pendingNewSession) {
      const _sb = () => (window as any).HanaModules.sidebar;
      const ok = await _sb().ensureSession();
      if (!ok) return false;
      _sb().loadSessions();
    }

    const _cr = () => (window as any).HanaModules.chatRender;
    _cr().addUserMessage(displayText ?? text);
    state.ws.send(JSON.stringify({ type: 'prompt', text }));
    return true;
  }, [pendingNewSession]);

  // ── 斜杠命令 ──

  const executeDiary = useCallback(async () => {
    setSlashBusy('diary');
    setInputText('');
    setSlashMenuOpen(false);

    try {
      const res = await hanaFetch('/api/diary/write', { method: 'POST' });
      const data = await res.json();

      if (!res.ok || data.error) {
        showToast(tSafe(t, 'slash.diaryFailed', '日记写入失败'), 'error');
        return;
      }

      showToast(tSafe(t, 'slash.diaryDone', '日记已保存'), 'success');
    } catch (err) {
      showToast(tSafe(t, 'slash.diaryFailed', '日记写入失败'), 'error');
    } finally {
      setSlashBusy(null);
    }
  }, [t]);

  const executeXing = useCallback(async () => {
    setInputText('');
    setSlashMenuOpen(false);
    await sendAsUser(XING_PROMPT);
  }, [sendAsUser]);

  const slashCommands: SlashCommand[] = useMemo(() => [
    {
      name: 'diary',
      label: '/diary',
      description: tSafe(t, 'slash.diary', '写今日日记'),
      busyLabel: tSafe(t, 'slash.diaryBusy', '正在写日记...'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
      execute: executeDiary,
    },
    {
      name: 'xing',
      label: '/xing',
      description: tSafe(t, 'slash.xing', '反省当前对话'),
      busyLabel: '',
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
      execute: executeXing,
    },
  ], [executeDiary, executeXing, t]);

  // 过滤匹配的命令
  const filteredCommands = useMemo(() => {
    if (!inputText.startsWith('/')) return slashCommands;
    const query = inputText.slice(1).toLowerCase();
    return slashCommands.filter(c => c.name.startsWith(query));
  }, [inputText, slashCommands]);

  // 输入 / 时打开菜单
  const handleInputChange = useCallback((value: string) => {
    setInputText(value);
    if (value.startsWith('/') && value.length <= 20) {
      setSlashMenuOpen(true);
      setSlashSelected(0);
    } else {
      setSlashMenuOpen(false);
    }
  }, []);

  // Can send?
  const hasContent = inputText.trim().length > 0 || attachedFiles.length > 0 || deskContextAttached;
  const canSend = hasContent && connected && !isStreaming;

  // ── Auto resize ──
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [inputText]);

  // ── Placeholder from yuan ──
  const placeholder = (() => {
    const yuanPh = t(`yuan.placeholder.${agentYuan}`);
    return (yuanPh && !yuanPh.startsWith('yuan.')) ? yuanPh : t('input.placeholder');
  })();


  // ── Load plan mode + thinking level on mount ──
  useEffect(() => {
    hanaFetch('/api/plan-mode')
      .then(r => r.json())
      .then(d => setPlanMode(d.enabled ?? false))
      .catch(() => {});

    hanaFetch('/api/config')
      .then(r => r.json())
      .then(d => { if (d.thinking_level) setThinkingLevel(d.thinking_level as ThinkingLevel); })
      .catch(() => {});

    // Listen for WS plan_mode updates
    const handler = (e: Event) => {
      setPlanMode((e as CustomEvent).detail?.enabled ?? false);
    };
    window.addEventListener('hana-plan-mode', handler);
    return () => window.removeEventListener('hana-plan-mode', handler);
  }, []);

  // ── Send message ──
  const handleSend = useCallback(async () => {
    const text = inputText.trim();

    // 斜杠命令拦截
    if (text.startsWith('/') && slashMenuOpen && filteredCommands.length > 0) {
      const cmd = filteredCommands[slashSelected] || filteredCommands[0];
      if (cmd) {
        cmd.execute();
        return;
      }
    }

    const hasFiles = attachedFiles.length > 0;
    if ((!text && !hasFiles && !deskContextAttached) || !connected) return;
    if (isStreaming) return; // streaming 时由 handleSteer 处理
    if (sending) return;
    setSending(true);

    try {
      const state = window.__hanaState;
      if (pendingNewSession) {
        const _sb = () => window.HanaModules.sidebar;
        const ok = await _sb().ensureSession();
        if (!ok) return;
        _sb().loadSessions();
      }

      let finalText = text;
      if (hasFiles) {
        const fileBlock = attachedFiles
          .map(f => f.isDirectory ? `[目录] ${f.path}` : `[附件] ${f.path}`)
          .join('\n');
        finalText = text ? `${text}\n\n${fileBlock}` : fileBlock;
      }

      let deskContextForRender: { dir: string; fileCount: number } | null = null;
      if (deskContextAttached && deskDir && deskFiles.length > 0) {
        let filesToShow: DeskFile[] = deskFiles;
        let truncNote = '';
        if (filesToShow.length > 50) {
          filesToShow = filesToShow.slice(0, 50);
          truncNote = `\n... 共 ${deskFiles.length} 个项目，已显示前 50 个`;
        }
        const listing = filesToShow
          .map(f => f.isDir ? `  📁 ${f.name}/` : `  ${f.name}`)
          .join('\n');
        const deskBlock = `[当前书桌目录] ${deskDir}\n${listing}${truncNote}`;
        finalText = finalText ? `${finalText}\n\n${deskBlock}` : deskBlock;
        deskContextForRender = { dir: deskDir, fileCount: deskFiles.length };
      }

      if (deskContextAttached) {
        setDeskContextAttached(false);
      }

      const filesToRender = hasFiles ? [...attachedFiles] : null;
      const _cr = () => window.HanaModules.chatRender;
      _cr().addUserMessage(text, filesToRender, deskContextForRender);

      setInputText('');
      clearAttachedFiles();

      state.ws?.send(JSON.stringify({ type: 'prompt', text: finalText }));
    } finally {
      setSending(false);
    }
  }, [inputText, attachedFiles, deskContextAttached, connected, isStreaming, sending, pendingNewSession, deskDir, deskFiles, clearAttachedFiles, setDeskContextAttached, slashMenuOpen, filteredCommands, slashSelected]);

  // ── Steer (插话) ──
  const handleSteer = useCallback(() => {
    const text = inputText.trim();
    if (!text || !isStreaming) return;
    const state = window.__hanaState;
    if (!state.ws) return;

    // 断开当前 assistant 消息组（不封存工具），让后续回复出现在 steer 消息下方
    window.HanaModules.chatRender.breakAssistantGroup();
    window.HanaModules.chatRender.addUserMessage(text, null, null);

    setInputText('');
    state.ws.send(JSON.stringify({ type: 'steer', text }));
  }, [inputText, isStreaming]);

  // ── Stop generation ──
  const handleStop = useCallback(() => {
    const state = window.__hanaState;
    if (!isStreaming || !state.ws) return;
    state.ws.send(JSON.stringify({ type: 'abort' }));
  }, [isStreaming]);

  // ── Key handler ──
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // 斜杠菜单导航
    if (slashMenuOpen && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashSelected(i => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashSelected(i => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const cmd = filteredCommands[slashSelected];
        if (cmd) setInputText('/' + cmd.name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashMenuOpen(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !isComposing.current) {
      e.preventDefault();
      if (isStreaming && inputText.trim()) {
        handleSteer();
      } else {
        handleSend();
      }
    }
  }, [handleSend, handleSteer, isStreaming, inputText, slashMenuOpen, filteredCommands, slashSelected]);

  return (
    <>
      <TodoDisplay todos={sessionTodos} />

      {attachedFiles.length > 0 && (
        <AttachedFilesBar
          files={attachedFiles}
          onRemove={removeAttachedFile}
        />
      )}

      {slashMenuOpen && filteredCommands.length > 0 && (
        <SlashCommandMenu
          commands={filteredCommands}
          selected={slashSelected}
          busy={slashBusy}
          onSelect={(cmd) => cmd.execute()}
          onHover={(i) => setSlashSelected(i)}
        />
      )}

      {slashBusy && (
        <div className="slash-busy-bar">
          <span className="slash-busy-dot" />
          <span>{slashCommands.find(c => c.name === slashBusy)?.busyLabel || '执行中...'}</span>
        </div>
      )}

      <div className="input-wrapper">
        <textarea
          ref={textareaRef}
          id="inputBox"
          className="input-box"
          placeholder={placeholder}
          rows={1}
          spellCheck={false}
          value={inputText}
          onChange={e => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => { isComposing.current = true; }}
          onCompositionEnd={() => { isComposing.current = false; }}
        />

        <div className="input-bottom-bar">
          <div className="input-actions">
            <PlanModeButton enabled={planMode} onToggle={setPlanMode} />
            <DeskContextButton
              active={deskContextAttached}
              disabled={!hasDeskDir}
              onToggle={toggleDeskContext}
            />
          </div>
          <div className="input-controls">
            {currentModelInfo?.reasoning !== false && (
              <ThinkingLevelButton
                level={thinkingLevel}
                onChange={setThinkingLevel}
                modelXhigh={currentModelInfo?.xhigh ?? false}
              />
            )}
            <ModelSelector models={models} />
            <SendButton
              isStreaming={isStreaming}
              hasInput={!!inputText.trim()}
              disabled={isStreaming ? false : !canSend}
              onSend={handleSend}
              onSteer={handleSteer}
              onStop={handleStop}
            />
          </div>
        </div>
      </div>
    </>
  );
}

// ── Todo Display ──

function TodoDisplay({ todos }: { todos: Array<{ text: string; done: boolean }> }) {
  const [open, setOpen] = useState(false);

  if (!todos || todos.length === 0) return null;

  const done = todos.filter(td => td.done).length;

  return (
    <div className="input-top-bar">
      <div className={'todo-display has-todos' + (open ? ' open' : '')}>
        <button className="todo-trigger" onClick={() => setOpen(!open)}>
          <span className="todo-trigger-icon">☑</span>
          <span className="todo-trigger-label">To Do</span>
          <span className="todo-trigger-count">{done}/{todos.length}</span>
        </button>
        {open && (
          <div className="todo-list">
            {todos.map((td, i) => (
              <div key={i} className={'todo-item' + (td.done ? ' done' : '')}>
                <span className="todo-check">{td.done ? '✓' : '○'}</span> {td.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Attached Files ──

function AttachedFilesBar({ files, onRemove }: {
  files: Array<{ path: string; name: string; isDirectory?: boolean }>;
  onRemove: (index: number) => void;
}) {
  const { SVG_ICONS } = (window as any).HanaModules?.icons ?? {};

  return (
    <div className="attached-files">
      {files.map((f, i) => (
        <span key={f.path} className="file-tag">
          <span className="file-tag-name">
            <span
              className="file-tag-icon"
              dangerouslySetInnerHTML={{ __html: f.isDirectory ? SVG_ICONS?.folder : SVG_ICONS?.clip }}
            />
            {f.name}
          </span>
          <button className="file-tag-remove" onClick={() => onRemove(i)}>✕</button>
        </span>
      ))}
    </div>
  );
}

// ── Plan Mode Button ──

function PlanModeButton({ enabled, onToggle }: {
  enabled: boolean;
  onToggle: (v: boolean) => void;
}) {
  const { t } = useI18n();

  const handleClick = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/plan-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      });
      const data = await res.json();
      onToggle(data.enabled);
    } catch (err) {
      console.error('[plan-mode] toggle failed:', err);
    }
  }, [enabled, onToggle]);

  return (
    <button
      className={'plan-mode-btn' + (!enabled ? ' active' : '')}
      title={t('input.planMode') || '操作电脑'}
      onClick={handleClick}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
      </svg>
      <span className="plan-mode-label">{t('input.planMode') || '操作电脑'}</span>
    </button>
  );
}

// ── Desk Context Button ──

function DeskContextButton({ active, disabled, onToggle }: {
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();

  return (
    <button
      className={'desk-context-btn' + (active ? ' active' : '')}
      title={t('input.deskContext') || '看着书桌说'}
      disabled={disabled}
      onClick={onToggle}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
      </svg>
      <span className="desk-context-label">{t('input.deskContext') || '看着书桌说'}</span>
    </button>
  );
}

// ── Thinking Level Button ──

const ALL_THINKING_LEVELS: ThinkingLevel[] = ['off', 'auto', 'xhigh'];

function ThinkingLevelButton({ level, onChange, modelXhigh }: {
  level: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  modelXhigh: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const availableLevels = useMemo(() => {
    return ALL_THINKING_LEVELS.filter(lv => lv !== 'xhigh' || modelXhigh);
  }, [modelXhigh]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [open]);

  const selectLevel = useCallback(async (next: ThinkingLevel) => {
    onChange(next);
    setOpen(false);
    try {
      await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thinking_level: next }),
      });
    } catch (err) {
      console.error('[thinking-level] save failed:', err);
    }
  }, [onChange]);

  const tLevel = (key: string, fallback: string) => {
    const v = t(key);
    return v !== key ? v : fallback;
  };

  const isOff = level === 'off';

  return (
    <div className={'thinking-selector' + (open ? ' open' : '')} ref={ref}>
      <button
        className={`thinking-pill${isOff ? '' : ' active'}`}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18h6" /><path d="M10 22h4" />
          <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0018 8 6 6 0 006 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5" />
          {isOff && <line x1="4" y1="4" x2="20" y2="20" strokeWidth="1.5" />}
        </svg>
      </button>
      {open && (
        <div className="thinking-dropdown">
          {availableLevels.map(lv => (
            <button
              key={lv}
              className={'thinking-option' + (lv === level ? ' active' : '')}
              onClick={() => selectLevel(lv)}
            >
              <span className="thinking-option-name">{tLevel(`input.thinkingLevel.${lv}`, lv)}</span>
              <span className="thinking-option-desc">{tLevel(`input.thinkingDesc.${lv}`, '')}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Model Selector ──

function ModelSelector({ models }: { models: Array<{ id: string; name: string; isCurrent?: boolean }> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = models.find(m => m.isCurrent);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [open]);

  const switchModel = useCallback(async (modelId: string) => {
    try {
      await hanaFetch('/api/models/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      });
      // Reload models
      const favRes = await hanaFetch('/api/models/favorites');
      const favData = await favRes.json();
      const state = window.__hanaState;
      state.models = favData.models || [];
      state.currentModel = favData.current;
    } catch (err) {
      console.error('[model] switch failed:', err);
    }
    setOpen(false);
  }, []);

  return (
    <div className={'model-selector' + (open ? ' open' : '')} ref={ref}>
      <button className="model-pill" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        <span>{current?.name || t('model.unknown') || '...'}</span>
        <span className="model-arrow">▾</span>
      </button>
      {open && (
        <div className="model-dropdown">
          {models.map(m => (
            <button
              key={m.id}
              className={'model-option' + (m.isCurrent ? ' active' : '')}
              onClick={() => switchModel(m.id)}
            >
              {m.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Slash Command Menu ──

function SlashCommandMenu({ commands, selected, busy, onSelect, onHover }: {
  commands: SlashCommand[];
  selected: number;
  busy: string | null;
  onSelect: (cmd: SlashCommand) => void;
  onHover: (i: number) => void;
}) {
  return (
    <div className="slash-menu">
      {commands.map((cmd, i) => (
        <button
          key={cmd.name}
          className={'slash-menu-item' + (i === selected ? ' selected' : '') + (busy === cmd.name ? ' busy' : '')}
          onMouseEnter={() => onHover(i)}
          onClick={() => !busy && onSelect(cmd)}
          disabled={!!busy}
        >
          <span className="slash-menu-icon" dangerouslySetInnerHTML={{ __html: cmd.icon }} />
          <span className="slash-menu-label">{cmd.label}</span>
          <span className="slash-menu-desc">{cmd.description}</span>
        </button>
      ))}
    </div>
  );
}

// ── Send Button ──

function SendButton({ isStreaming, hasInput, disabled, onSend, onSteer, onStop }: {
  isStreaming: boolean;
  hasInput: boolean;
  disabled: boolean;
  onSend: () => void;
  onSteer: () => void;
  onStop: () => void;
}) {
  const { t } = useI18n();

  // 三态：发送 / 插话 / 停止
  const mode = isStreaming ? (hasInput ? 'steer' : 'stop') : 'send';

  return (
    <button
      className={'send-btn' + (mode === 'steer' ? ' is-steer' : mode === 'stop' ? ' is-streaming' : '')}
      disabled={disabled}
      onClick={mode === 'steer' ? onSteer : mode === 'stop' ? onStop : onSend}
    >
      {mode === 'send' && (
        <span className="send-label">
          <svg className="send-enter-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 01-4 4H4" />
          </svg>
          <span className="send-label-text">{t('chat.send') || '发送'}</span>
        </span>
      )}
      {mode === 'steer' && (
        <span className="send-label">
          <svg className="send-enter-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span className="send-label-text">{t('chat.steer') || '插话'}</span>
        </span>
      )}
      {mode === 'stop' && (
        <span className="send-label">
          <svg className="stop-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
          <span className="send-label-text">{t('chat.stop') || '停止'}</span>
        </span>
      )}
    </button>
  );
}
