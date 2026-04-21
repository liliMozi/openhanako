/**
 * InputArea — 聊天输入区域 React 组件
 *
 * 子组件拆分到 ./input/ 目录。
 * 斜杠命令逻辑在 ./input/slash-commands.ts。
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { useStore } from '../stores';
import { selectArtifacts, selectActiveTabId } from '../stores/artifact-slice';
import { isImageFile } from '../utils/format';
import { fetchConfig } from '../hooks/use-config';
import { useI18n } from '../hooks/use-i18n';
import { ensureSession, loadSessions } from '../stores/session-actions';
import { loadDeskFiles, toggleJianSidebar } from '../stores/desk-actions';
import { getWebSocket } from '../services/websocket';
import type { ThinkingLevel } from '../stores/model-slice';
import { SlashCommandMenu } from './input/SlashCommandMenu';
import { InputStatusBars } from './input/InputStatusBars';
import { InputContextRow } from './input/InputContextRow';
import { InputControlBar } from './input/InputControlBar';
import { SkillBadge } from './input/extensions/skill-badge';
import { serializeEditor } from '../utils/editor-serializer';
import { useSkillSlashItems } from '../hooks/use-slash-items';
import {
  XING_PROMPT, executeDiary, executeCompact, buildSlashCommands, getSlashMatches,
  resolveSlashSubmitSelection,
  type SlashItem,
} from './input/slash-commands';
import { attachFilesFromPaths } from '../MainContent';
import styles from './input/InputArea.module.css';
import type { TodoItem } from '../types';

const EMPTY_TODOS: TodoItem[] = [];

export type { SlashItem };

// ── 主组件 ──

export function InputArea() {
  return <InputAreaInner />;
}

function InputAreaInner() {
  const { t } = useI18n();

  // Zustand state
  const isStreaming = useStore(s => s.streamingSessions.includes(s.currentSessionPath || ''));
  const connected = useStore(s => s.connected);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const compacting = useStore(s => currentSessionPath ? s.compactingSessions.includes(currentSessionPath) : false);
  const inlineError = useStore(s => s.inlineErrors[s.currentSessionPath || ''] ?? null);
  const sessionTodos = useStore(s => (s.currentSessionPath && s.todosBySession[s.currentSessionPath]) || EMPTY_TODOS);
  const attachedFiles = useStore(s => s.attachedFiles);
  const docContextAttached = useStore(s => s.docContextAttached);
  const quotedSelection = useStore(s => s.quotedSelection);
  const artifacts = useStore(selectArtifacts);
  const activeTabId = useStore(selectActiveTabId);
  const previewOpen = useStore(s => s.previewOpen);
  const models = useStore(s => s.models);
  const agentYuan = useStore(s => s.agentYuan);
  const thinkingLevel = useStore(s => s.thinkingLevel);
  const setThinkingLevel = useStore(s => s.setThinkingLevel);

  const globalModelInfo = useMemo(() => models.find(m => m.isCurrent), [models]);
  const sessionModel = useStore(s => s.currentSessionPath ? s.sessionModelsByPath[s.currentSessionPath] : undefined);
  const currentModelInfo = sessionModel || globalModelInfo;
  const supportsVision = currentModelInfo?.vision !== false;
  const modelSwitching = useStore(s => s.modelSwitching);
  const sessionHasMessages = useStore(s => !!(s.currentSessionPath && s.chatSessions[s.currentSessionPath]?.items?.length));

  // Local state
  const [planMode, setPlanMode] = useState(false);
  const [sending, setSending] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelected, setSlashSelected] = useState(0);
  const [slashBusy, setSlashBusy] = useState<string | null>(null);
  const [slashResult, setSlashResult] = useState<{ text: string; type: 'success' | 'error'; deskDir?: string } | null>(null);

  const isComposing = useRef(false);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const slashBtnRef = useRef<HTMLButtonElement>(null);
  const slashDismissedTextRef = useRef<string | null>(null);
  const [inputText, setInputText] = useState('');

  // ── 全局 inline notice（截图等非斜杠命令的轻提示）──
  useEffect(() => {
    const handler = (e: Event) => {
      const { text, type, deskDir } = (e as CustomEvent).detail;
      setSlashResult({ text, type, deskDir });
      setTimeout(() => setSlashResult(null), 3000);
    };
    window.addEventListener('hana-inline-notice', handler);
    return () => window.removeEventListener('hana-inline-notice', handler);
  }, []);

  // ── Placeholder ──
  const placeholder = (() => {
    const yuanPh = t(`yuan.placeholder.${agentYuan}`);
    return (yuanPh && !yuanPh.startsWith('yuan.')) ? yuanPh : t('input.placeholder');
  })();

  // ── TipTap editor ──
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        dropcursor: false,
        gapcursor: false,
      }),
      Placeholder.configure({ placeholder }),
      SkillBadge,
    ],
    editorProps: {
      attributes: {
        class: styles['input-box'],
        id: 'inputBox',
        spellcheck: 'false',
      },
    },
  });

  // Focus trigger from store
  const inputFocusTrigger = useStore(s => s.inputFocusTrigger);
  useEffect(() => {
    if (inputFocusTrigger > 0) editor?.commands.focus();
  }, [inputFocusTrigger, editor]);

  // Zustand actions
  const addAttachedFile = useStore(s => s.addAttachedFile);
  const removeAttachedFile = useStore(s => s.removeAttachedFile);
  const clearAttachedFiles = useStore(s => s.clearAttachedFiles);
  const toggleDocContext = useStore(s => s.toggleDocContext);
  const setDocContextAttached = useStore(s => s.setDocContextAttached);
  const setDraft = useStore(s => s.setDraft);
  const clearDraft = useStore(s => s.clearDraft);

  // Doc context
  const currentDoc = useMemo(() => {
    if (!previewOpen || !activeTabId) return null;
    const art = artifacts.find(a => a.id === activeTabId);
    if (!art?.filePath) return null;
    return { path: art.filePath, name: art.title || art.filePath.split('/').pop() || '' };
  }, [previewOpen, activeTabId, artifacts]);
  const hasDoc = !!currentDoc;

  // doc 消失时同步清 attach，避免悬空的 docContextAttached 干扰 hasContent / 发送态
  useEffect(() => {
    if (!hasDoc && docContextAttached) setDocContextAttached(false);
  }, [hasDoc, docContextAttached, setDocContextAttached]);

  // ── 统一命令发送 ──

  const sendAsUser = useCallback(async (text: string, displayText?: string): Promise<boolean> => {
    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const _s = useStore.getState();
    if (_s.streamingSessions.includes(_s.currentSessionPath || '')) return false;

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
    executeDiary(t, showSlashResult, setSlashBusy, () => { editor?.commands.clearContent(); }, setSlashMenuOpen),
    [t, showSlashResult, editor],
  );
  const xingFn = useCallback(async () => {
    editor?.commands.clearContent();
    setSlashMenuOpen(false);
    await sendAsUser(XING_PROMPT);
  }, [sendAsUser, editor]);
  const compactFn = useCallback(
    executeCompact(setSlashBusy, () => { editor?.commands.clearContent(); }, setSlashMenuOpen),
    [editor],
  );

  const skillItems = useSkillSlashItems();

  const slashCommands = useMemo(
    () => [...buildSlashCommands(t, diaryFn, xingFn, compactFn), ...skillItems],
    [diaryFn, xingFn, compactFn, t, skillItems],
  );

  const filteredCommands = useMemo(() => {
    if (!inputText.startsWith('/')) return slashCommands;
    return getSlashMatches(inputText, slashCommands);
  }, [inputText, slashCommands]);

  const dismissSlashMenu = useCallback(() => {
    const text = editor?.getText().trim() ?? inputText.trim();
    slashDismissedTextRef.current = text.startsWith('/') ? text : null;
    setSlashMenuOpen(false);
  }, [editor, inputText]);

  const openSlashMenu = useCallback(() => {
    slashDismissedTextRef.current = null;
    setSlashMenuOpen(true);
  }, []);

  const handleSlashToggle = useCallback(() => {
    if (slashMenuOpen) dismissSlashMenu();
    else openSlashMenu();
  }, [slashMenuOpen, dismissSlashMenu, openSlashMenu]);

  const handleAttach = useCallback(async () => {
    const paths = await window.platform?.selectFiles?.();
    if (paths && paths.length > 0) await attachFilesFromPaths(paths);
  }, []);

  // Sync editor text to React state (drives hasInput / canSend) + slash menu detection + draft save
  useEffect(() => {
    if (!editor) return;
    const handler = () => {
      const text = editor.getText();
      setInputText(text);
      if (slashDismissedTextRef.current && slashDismissedTextRef.current !== text.trim()) {
        slashDismissedTextRef.current = null;
      }
      const slashMatches = getSlashMatches(text, slashCommands);
      if (slashMatches.length > 0 && slashDismissedTextRef.current !== text.trim()) {
        setSlashMenuOpen(true);
        setSlashSelected(0);
      } else {
        setSlashMenuOpen(false);
      }
      // 保存草稿到 store
      if (currentSessionPath) {
        setDraft(currentSessionPath, text);
      }
      // 内容超出可见区域时，自动滚动到光标位置
      requestAnimationFrame(() => editor.commands.scrollIntoView());
    };
    editor.on('update', handler);
    return () => { editor.off('update', handler); };
  }, [editor, currentSessionPath, setDraft, slashCommands]);

  // 切换 session 时恢复草稿
  useEffect(() => {
    if (!editor || !currentSessionPath) return;
    const draft = useStore.getState().drafts[currentSessionPath] || '';
    const current = editor.getText();
    if (draft !== current) {
      if (!draft) {
        editor.commands.setContent('', { emitUpdate: false });
      } else {
        const doc = {
          type: 'doc' as const,
          content: draft.split('\n').map(line => ({
            type: 'paragraph' as const,
            content: line ? [{ type: 'text' as const, text: line }] : [],
          })),
        };
        editor.commands.setContent(doc, { emitUpdate: false });
      }
    }
  }, [editor, currentSessionPath]);

  // 点击外部关闭斜杠菜单
  useEffect(() => {
    if (!slashMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (slashMenuRef.current?.contains(e.target as Node)) return;
      if (slashBtnRef.current?.contains(e.target as Node)) return;
      dismissSlashMenu();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dismissSlashMenu, slashMenuOpen]);

  // Can send?
  const hasContent = inputText.trim().length > 0 || attachedFiles.length > 0 || docContextAttached || !!quotedSelection
    || (editor?.getJSON().content?.some(n => n.type === 'skillBadge') ?? false);
  const canSend = hasContent && connected && !isStreaming && !modelSwitching;

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

  // ── Load thinking level once server port is ready + listen for plan mode sync ──
  const serverPort = useStore(s => s.serverPort);
  useEffect(() => {
    if (serverPort) {
      fetchConfig()
        .then(d => { if (d.thinking_level) setThinkingLevel(d.thinking_level as ThinkingLevel); })
        .catch((err: unknown) => console.warn('[InputArea] load config failed', err));
    }

    const handler = (e: Event) => {
      setPlanMode((e as CustomEvent).detail?.enabled ?? false);
    };
    window.addEventListener('hana-plan-mode', handler);
    return () => window.removeEventListener('hana-plan-mode', handler);
  }, [serverPort, setThinkingLevel]);

  // ── Handle slash selection (builtin vs skill) ──
  const handleSlashSelect = useCallback((item: SlashItem) => {
    slashDismissedTextRef.current = null;
    if (item.type === 'builtin') {
      item.execute();
      return;
    }
    if (!editor) return;
    editor.chain()
      .clearContent()
      .insertContent({ type: 'skillBadge', attrs: { name: item.name } })
      .insertContent(' ')
      .focus()
      .run();
    setSlashMenuOpen(false);
  }, [editor]);

  // ── Send message ──
  const handleSend = useCallback(async () => {
    if (!editor) return;
    const editorJson = editor.getJSON();
    const { text: rawText, skills } = serializeEditor(editorJson);
    const text = rawText.trim();

    const slashSelection = resolveSlashSubmitSelection({
      text,
      skills,
      commands: slashCommands,
      selectedIndex: slashSelected,
      dismissedText: slashDismissedTextRef.current,
    });
    if (slashSelection) {
      handleSlashSelect(slashSelection);
      return;
    }

    const hasFiles = attachedFiles.length > 0;
    if ((!text && !hasFiles && !docContextAttached && !useStore.getState().quotedSelection) || !connected) return;
    if (isStreaming) return;
    if (sending) return;
    if (modelSwitching) return;
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
            skills: skills.length > 0 ? skills : undefined,
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

      editor.commands.clearContent();
      if (currentSessionPath) clearDraft(currentSessionPath);
      clearAttachedFiles();
      const qs2 = useStore.getState().quotedSelection;
      if (qs2) useStore.getState().clearQuotedSelection();

      const ws = getWebSocket();
      const wsMsg: Record<string, unknown> = {
        type: 'prompt',
        text: finalText,
        sessionPath: useStore.getState().currentSessionPath,
      };
      if (images.length > 0) wsMsg.images = images;
      if (skills.length > 0) wsMsg.skills = skills;
      ws?.send(JSON.stringify(wsMsg));
    } finally {
      setSending(false);
    }
  }, [editor, attachedFiles, docContextAttached, connected, isStreaming, sending, pendingNewSession, currentDoc, clearAttachedFiles, clearDraft, currentSessionPath, setDocContextAttached, slashCommands, slashSelected, handleSlashSelect]);

  // ── Steer ──
  const handleSteer = useCallback(async () => {
    if (!editor) return;
    const text = editor.getText().trim();
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
    editor.commands.clearContent();
    const sp = useStore.getState().currentSessionPath;
    if (sp) clearDraft(sp);
    ws.send(JSON.stringify({ type: 'steer', text, sessionPath: sp }));
  }, [editor, isStreaming, clearDraft]);

  // ── Stop ──
  const handleStop = useCallback(() => {
    const ws = getWebSocket();
    if (!isStreaming || !ws) return;
    ws.send(JSON.stringify({ type: 'abort', sessionPath: useStore.getState().currentSessionPath }));
  }, [isStreaming]);

  // ── Key handler ──
  const handleEditorKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (slashMenuOpen && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSelected(i => (i + 1) % filteredCommands.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSelected(i => (i - 1 + filteredCommands.length) % filteredCommands.length); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        const cmd = filteredCommands[slashSelected];
        if (cmd) editor?.commands.setContent('/' + cmd.name);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); dismissSlashMenu(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !isComposing.current) {
      e.preventDefault();
      if (isStreaming && (editor?.getText().trim())) handleSteer(); else handleSend();
    }
  }, [dismissSlashMenu, handleSend, handleSteer, isStreaming, editor, slashMenuOpen, filteredCommands, slashSelected]);

  const handleSlashResultClick = useCallback(() => {
    if (!slashResult?.deskDir) return;
    toggleJianSidebar(true);
    loadDeskFiles('', slashResult.deskDir);
  }, [slashResult?.deskDir]);

  return (
    <>
      <InputStatusBars
        slashBusy={slashBusy}
        slashBusyLabel={slashCommands.find(c => c.name === slashBusy)?.busyLabel || t('common.executing')}
        compacting={compacting}
        compactingLabel={t('chat.compacting')}
        inlineError={inlineError}
        slashResult={slashResult}
        onResultClick={slashResult?.deskDir ? handleSlashResultClick : undefined}
      />
      <InputContextRow
        attachedFiles={attachedFiles}
        removeAttachedFile={removeAttachedFile}
        hasQuotedSelection={!!quotedSelection}
        sessionTodos={sessionTodos}
      />
      <div className={styles['slash-menu-anchor']} ref={slashMenuRef}>
        {slashMenuOpen && filteredCommands.length > 0 && (
          <SlashCommandMenu commands={filteredCommands} selected={slashSelected} busy={slashBusy}
            onSelect={handleSlashSelect} onHover={(i) => setSlashSelected(i)} />
        )}
      </div>
      <div className={styles['input-wrapper']}>
        <div
          onKeyDown={handleEditorKeyDown}
          onPaste={handlePaste}
          onCompositionStart={() => { isComposing.current = true; }}
          onCompositionEnd={() => { isComposing.current = false; }}
        >
          <EditorContent editor={editor} />
        </div>
        <InputControlBar
          t={t}
          onAttach={handleAttach}
          slashBtnRef={slashBtnRef}
          onSlashToggle={handleSlashToggle}
          planMode={planMode}
          onTogglePlanMode={setPlanMode}
          hasDoc={hasDoc}
          docContextAttached={docContextAttached}
          onToggleDocContext={toggleDocContext}
          showThinking={currentModelInfo?.reasoning !== false}
          thinkingLevel={thinkingLevel}
          onThinkingChange={setThinkingLevel}
          modelXhigh={(sessionModel ? models.find(m => m.id === sessionModel.id && m.provider === sessionModel.provider)?.xhigh : globalModelInfo?.xhigh) ?? false}
          models={models}
          sessionModel={sessionModel}
          isStreaming={isStreaming}
          hasInput={!!inputText.trim()}
          canSend={canSend}
          onSend={handleSend}
          onSteer={handleSteer}
          onStop={handleStop}
        />
      </div>
    </>
  );
}
