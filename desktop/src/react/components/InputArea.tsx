/**
 * InputArea — 聊天输入区域 React 组件
 *
 * 子组件拆分到 ./input/ 目录。
 * 斜杠命令逻辑在 ./input/slash-commands.ts。
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useStore } from '../stores';
import { isImageFile } from '../utils/format';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import { ensureSession, loadSessions } from '../stores/session-actions';
import { getWebSocket } from '../services/websocket';
import type { ThinkingLevel } from '../stores/model-slice';
import { TodoDisplay } from './input/TodoDisplay';
import { AttachedFilesBar } from './input/AttachedFilesBar';
import { PlanModeButton } from './input/PlanModeButton';
import { DocContextButton } from './input/DocContextButton';
import { ContextRing } from './input/ContextRing';
import { ThinkingLevelButton } from './input/ThinkingLevelButton';
import { ModelSelector } from './input/ModelSelector';
import { SlashCommandMenu } from './input/SlashCommandMenu';
import { SendButton } from './input/SendButton';
import { QuotedSelectionCard } from './input/QuotedSelectionCard';
import {
  XING_PROMPT, executeDiary, executeCompact, buildSlashCommands,
  type SlashCommand,
} from './input/slash-commands';
import styles from './input/InputArea.module.css';

export type { SlashCommand };

// ── 主组件 ──

export function InputArea() {
  return <InputAreaInner />;
}

function InputAreaInner() {
  const { t } = useI18n();

  // Zustand state
  const isStreaming = useStore(s => s.isStreaming);
  const connected = useStore(s => s.connected);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const todosBySession = useStore(s => s.todosBySession);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const sessionTodos = (todosBySession && currentSessionPath && todosBySession[currentSessionPath]) || [];
  const attachedFiles = useStore(s => s.attachedFiles);
  const docContextAttached = useStore(s => s.docContextAttached);
  const quotedSelection = useStore(s => s.quotedSelection);
  const artifacts = useStore(s => s.artifacts);
  const activeTabId = useStore(s => s.activeTabId);
  const previewOpen = useStore(s => s.previewOpen);
  const models = useStore(s => s.models);
  const agentYuan = useStore(s => s.agentYuan);
  const thinkingLevel = useStore(s => s.thinkingLevel);
  const setThinkingLevel = useStore(s => s.setThinkingLevel);

  const currentModelInfo = useMemo(() => models.find(m => m.isCurrent), [models]);
  const supportsVision = currentModelInfo?.vision !== false;
  const chatSessions = useStore(s => s.chatSessions);
  const sessionHasMessages = !!(currentSessionPath && chatSessions[currentSessionPath]?.items?.length);

  // Local state
  const [inputText, setInputText] = useState('');
  const [planMode, setPlanMode] = useState(false);
  const [sending, setSending] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelected, setSlashSelected] = useState(0);
  const [slashBusy, setSlashBusy] = useState<string | null>(null);
  const [slashResult, setSlashResult] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposing = useRef(false);

  // Focus trigger from store
  const inputFocusTrigger = useStore(s => s.inputFocusTrigger);
  useEffect(() => {
    if (inputFocusTrigger > 0) textareaRef.current?.focus();
  }, [inputFocusTrigger]);

  // Zustand actions
  const addAttachedFile = useStore(s => s.addAttachedFile);
  const removeAttachedFile = useStore(s => s.removeAttachedFile);
  const clearAttachedFiles = useStore(s => s.clearAttachedFiles);
  const toggleDocContext = useStore(s => s.toggleDocContext);
  const setDocContextAttached = useStore(s => s.setDocContextAttached);

  // Doc context
  const currentDoc = useMemo(() => {
    if (!previewOpen || !activeTabId) return null;
    const art = artifacts.find(a => a.id === activeTabId);
    if (!art?.filePath) return null;
    return { path: art.filePath, name: art.title || art.filePath.split('/').pop() || '' };
  }, [previewOpen, activeTabId, artifacts]);
  const hasDoc = !!currentDoc;

  // ── 统一命令发送 ──

  const sendAsUser = useCallback(async (text: string, displayText?: string): Promise<boolean> => {
    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (useStore.getState().isStreaming) return false;

    if (pendingNewSession) {
      const ok = await ensureSession();
      if (!ok) return false;
      loadSessions();
    }

    const sessionPath = useStore.getState().currentSessionPath;
    if (sessionPath) {
      const { renderMarkdown } = await import('../utils/markdown');
      const msgText = displayText ?? text;
      useStore.getState().appendItem(sessionPath, {
        type: 'message',
        data: { id: `user-${Date.now()}`, role: 'user', text: msgText, textHtml: renderMarkdown(msgText) },
      });
      useStore.setState({ welcomeVisible: false });
    }
    ws.send(JSON.stringify({ type: 'prompt', text, sessionPath: useStore.getState().currentSessionPath }));
    return true;
  }, [pendingNewSession]);

  // ── 斜杠命令 ──

  const showSlashResult = useCallback((text: string, type: 'success' | 'error') => {
    setSlashBusy(null);
    setSlashResult({ text, type });
    setTimeout(() => setSlashResult(null), 3000);
  }, []);

  const diaryFn = useCallback(
    executeDiary(t, showSlashResult, setSlashBusy, setInputText, setSlashMenuOpen),
    [t, showSlashResult],
  );
  const xingFn = useCallback(async () => {
    setInputText('');
    setSlashMenuOpen(false);
    await sendAsUser(XING_PROMPT);
  }, [sendAsUser]);
  const compactFn = useCallback(
    executeCompact(setSlashBusy, setInputText, setSlashMenuOpen),
    [],
  );

  const slashCommands = useMemo(
    () => buildSlashCommands(t, diaryFn, xingFn, compactFn),
    [diaryFn, xingFn, compactFn, t],
  );

  const filteredCommands = useMemo(() => {
    if (!inputText.startsWith('/')) return slashCommands;
    const query = inputText.slice(1).toLowerCase();
    return slashCommands.filter(c => c.name.startsWith(query));
  }, [inputText, slashCommands]);

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
  const hasContent = inputText.trim().length > 0 || attachedFiles.length > 0 || docContextAttached || !!quotedSelection;
  const canSend = hasContent && connected && !isStreaming;

  // ── Auto resize ──
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [inputText]);

  // ── Placeholder ──
  const placeholder = (() => {
    const yuanPh = t(`yuan.placeholder.${agentYuan}`);
    return (yuanPh && !yuanPh.startsWith('yuan.')) ? yuanPh : t('input.placeholder');
  })();

  // ── Paste image ──
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (!item.type.startsWith('image/')) continue;
      if (!supportsVision) { e.preventDefault(); return; }
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (!match) return;
        const [, mimeType, base64Data] = match;
        const ext = mimeType.split('/')[1] || 'png';
        addAttachedFile({
          path: `clipboard-${Date.now()}.${ext}`,
          name: `${t('input.pastedImage')}.${ext}`,
          base64Data,
          mimeType,
        });
      };
      reader.readAsDataURL(file);
      break;
    }
  }, [addAttachedFile, t, supportsVision]);

  // ── Load thinking level on mount + listen for plan mode sync ──
  useEffect(() => {
    hanaFetch('/api/config')
      .then(r => r.json())
      .then(d => { if (d.thinking_level) setThinkingLevel(d.thinking_level as ThinkingLevel); })
      .catch((err: unknown) => console.warn('[InputArea] load config failed', err));

    const handler = (e: Event) => {
      setPlanMode((e as CustomEvent).detail?.enabled ?? false);
    };
    window.addEventListener('hana-plan-mode', handler);
    return () => window.removeEventListener('hana-plan-mode', handler);
  }, [setThinkingLevel]);

  // ── Send message ──
  const handleSend = useCallback(async () => {
    const text = inputText.trim();

    // 斜杠命令拦截
    if (text.startsWith('/') && slashMenuOpen && filteredCommands.length > 0) {
      const cmd = filteredCommands[slashSelected] || filteredCommands[0];
      if (cmd) { cmd.execute(); return; }
    }

    const hasFiles = attachedFiles.length > 0;
    if ((!text && !hasFiles && !docContextAttached && !useStore.getState().quotedSelection) || !connected) return;
    if (isStreaming) return;
    if (sending) return;
    setSending(true);

    try {
      if (pendingNewSession) {
        const ok = await ensureSession();
        if (!ok) return;
        loadSessions();
      }

      // 分离图片和非图片附件（模型不支持 vision 时，图片降级为普通附件路径）
      const imageFiles = hasFiles && supportsVision ? attachedFiles.filter(f => !f.isDirectory && isImageFile(f.name)) : [];
      const otherFiles = hasFiles ? attachedFiles.filter(f => f.isDirectory || !isImageFile(f.name) || !supportsVision) : [];

      let finalText = text;
      if (otherFiles.length > 0) {
        const fileBlock = otherFiles.map(f => f.isDirectory ? `[目录] ${f.path}` : `[附件] ${f.path}`).join('\n');
        finalText = text ? `${text}\n\n${fileBlock}` : fileBlock;
      }

      // 图片读 base64
      const hana = window.hana;
      const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
      const imageBase64Map = new Map<string, { base64Data: string; mimeType: string }>();
      for (const img of imageFiles) {
        try {
          if (img.base64Data && img.mimeType) {
            images.push({ type: 'image', data: img.base64Data, mimeType: img.mimeType });
          } else if (hana?.readFileBase64) {
            const base64 = await hana.readFileBase64(img.path);
            if (base64) {
              const ext = img.name.toLowerCase().replace(/^.*\./, '');
              const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
              const mimeType = mimeMap[ext] || 'image/png';
              imageBase64Map.set(img.path, { base64Data: base64, mimeType });
              images.push({ type: 'image', data: base64, mimeType });
            }
          }
        } catch {
          finalText = finalText ? `${finalText}\n\n[附件] ${img.path}` : `[附件] ${img.path}`;
        }
      }

      // 文档上下文
      let docForRender: { path: string; name: string } | null = null;
      if (docContextAttached && currentDoc) {
        finalText = finalText ? `${finalText}\n\n[参考文档] ${currentDoc.path}` : `[参考文档] ${currentDoc.path}`;
        docForRender = currentDoc;
      }
      if (docContextAttached) setDocContextAttached(false);

      // 引用片段
      const qs = useStore.getState().quotedSelection;
      if (qs) {
        let quoteStr: string;
        if (qs.sourceFilePath && qs.lineStart != null && qs.lineEnd != null) {
          quoteStr = `[引用片段] ${qs.sourceTitle}（第${qs.lineStart}-${qs.lineEnd}行，共${qs.charCount}字）路径: ${qs.sourceFilePath}`;
        } else {
          quoteStr = `[引用片段] ${qs.text}`;
        }
        finalText = finalText ? `${finalText}\n\n${quoteStr}` : quoteStr;
      }

      const allFiles = [...(hasFiles ? attachedFiles : [])];
      if (docForRender) allFiles.push({ path: docForRender.path, name: docForRender.name });

      // 写入 store
      const sessionPath = useStore.getState().currentSessionPath;
      if (sessionPath) {
        const { renderMarkdown } = await import('../utils/markdown');
        useStore.getState().appendItem(sessionPath, {
          type: 'message',
          data: {
            id: `user-${Date.now()}`, role: 'user', text,
            textHtml: renderMarkdown(text),
            quotedText: qs?.text,
            attachments: allFiles.length > 0 ? allFiles.map(f => {
              const cached = imageBase64Map.get(f.path);
              return {
                path: f.path, name: f.name, isDir: false,
                base64Data: f.base64Data || cached?.base64Data || undefined,
                mimeType: f.mimeType || cached?.mimeType || undefined,
              };
            }) : undefined,
          },
        });
        useStore.setState({ welcomeVisible: false });
      }

      setInputText('');
      clearAttachedFiles();
      const qs2 = useStore.getState().quotedSelection;
      if (qs2) useStore.getState().clearQuotedSelection();

      const ws = getWebSocket();
      const wsMsg: Record<string, unknown> = { type: 'prompt', text: finalText, sessionPath: useStore.getState().currentSessionPath };
      if (images.length > 0) wsMsg.images = images;
      ws?.send(JSON.stringify(wsMsg));
    } finally {
      setSending(false);
    }
  }, [inputText, attachedFiles, docContextAttached, connected, isStreaming, sending, pendingNewSession, currentDoc, clearAttachedFiles, setDocContextAttached, slashMenuOpen, filteredCommands, slashSelected]);

  // ── Steer ──
  const handleSteer = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !isStreaming) return;
    const ws = getWebSocket();
    if (!ws) return;
    const sessionPath = useStore.getState().currentSessionPath;
    if (sessionPath) {
      const { renderMarkdown } = await import('../utils/markdown');
      useStore.getState().appendItem(sessionPath, {
        type: 'message',
        data: { id: `user-${Date.now()}`, role: 'user', text, textHtml: renderMarkdown(text) },
      });
    }
    setInputText('');
    ws.send(JSON.stringify({ type: 'steer', text, sessionPath: useStore.getState().currentSessionPath }));
  }, [inputText, isStreaming]);

  // ── Stop ──
  const handleStop = useCallback(() => {
    const ws = getWebSocket();
    if (!isStreaming || !ws) return;
    ws.send(JSON.stringify({ type: 'abort', sessionPath: useStore.getState().currentSessionPath }));
  }, [isStreaming]);

  // ── Key handler ──
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (slashMenuOpen && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSelected(i => (i + 1) % filteredCommands.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSelected(i => (i - 1 + filteredCommands.length) % filteredCommands.length); return; }
      if (e.key === 'Tab') { e.preventDefault(); const cmd = filteredCommands[slashSelected]; if (cmd) setInputText('/' + cmd.name); return; }
      if (e.key === 'Escape') { e.preventDefault(); setSlashMenuOpen(false); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !isComposing.current) {
      e.preventDefault();
      if (isStreaming && inputText.trim()) handleSteer(); else handleSend();
    }
  }, [handleSend, handleSteer, isStreaming, inputText, slashMenuOpen, filteredCommands, slashSelected]);

  return (
    <>
      {slashBusy && (
        <div className={styles['slash-busy-bar']}>
          <span className={styles['slash-busy-dot']} />
          <span>{slashCommands.find(c => c.name === slashBusy)?.busyLabel || t('common.executing')}</span>
        </div>
      )}
      {!slashBusy && slashResult && (
        <div className={`${styles['slash-busy-bar']}${slashResult.type === 'error' ? ` ${styles['slash-result-error']}` : ''}`}><span>{slashResult.text}</span></div>
      )}
      {(attachedFiles.length > 0 || quotedSelection || sessionTodos.length > 0) && (
        <div className={styles['input-context-row']}>
          <div className={styles['input-context-left']}>
            {attachedFiles.length > 0 && <AttachedFilesBar files={attachedFiles} onRemove={removeAttachedFile} />}
            <QuotedSelectionCard />
          </div>
          <TodoDisplay todos={sessionTodos} />
        </div>
      )}
      {slashMenuOpen && filteredCommands.length > 0 && (
        <SlashCommandMenu commands={filteredCommands} selected={slashSelected} busy={slashBusy}
          onSelect={(cmd) => cmd.execute()} onHover={(i) => setSlashSelected(i)} />
      )}
      <div className={styles['input-wrapper']}>
        <textarea ref={textareaRef} id="inputBox" className={styles['input-box']} placeholder={placeholder}
          rows={1} spellCheck={false} value={inputText}
          onChange={e => handleInputChange(e.target.value)} onKeyDown={handleKeyDown} onPaste={handlePaste}
          onCompositionStart={() => { isComposing.current = true; }}
          onCompositionEnd={() => { isComposing.current = false; }} />
        <div className={styles['input-bottom-bar']}>
          <div className={styles['input-actions']}>
            <PlanModeButton enabled={planMode} onToggle={setPlanMode} />
            <DocContextButton active={docContextAttached} disabled={!hasDoc} onToggle={toggleDocContext} />
            <ContextRing />
          </div>
          <div className={styles['input-controls']}>
            {currentModelInfo?.reasoning !== false && (
              <ThinkingLevelButton level={thinkingLevel} onChange={setThinkingLevel} modelXhigh={currentModelInfo?.xhigh ?? false} />
            )}
            <ModelSelector models={models} disabled={sessionHasMessages} />
            <SendButton isStreaming={isStreaming} hasInput={!!inputText.trim()}
              disabled={isStreaming ? false : !canSend} onSend={handleSend} onSteer={handleSteer} onStop={handleStop} />
          </div>
        </div>
      </div>
    </>
  );
}
