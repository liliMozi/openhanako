/**
 * ArtifactEditor — CodeMirror 6 编辑器组件
 *
 * Obsidian 风格 markdown live preview：
 * - 衬线体渲染，无行号，无行高亮
 * - 语法标记仅在光标所在行可见（conceal）
 * - H1 居中，标题/粗体/斜体等格式实时渲染
 *
 * 架构：
 * - forwardRef 暴露 EditorView handle，供外部 toolbar 发命令
 * - Compartment 动态扩展槽，运行时可切换 mode/language
 * - 文件系统 source of truth，直接对接文件读写
 */

import { forwardRef, useEffect, useRef, useCallback, useImperativeHandle } from 'react';
import {
  EditorView, keymap, highlightActiveLine, drawSelection,
  lineNumbers,
} from '@codemirror/view';
import { EditorState, Compartment, Transaction, EditorSelection } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  syntaxHighlighting, bracketMatching,
} from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { markdownHighlight, codeHighlight } from '../editor/highlight';
import { markdownTheme, codeTheme } from '../editor/theme';
import { markdownBlockDecoField, markdownDecoPlugin } from '../editor/md-decorations';
import { linkClickHandler } from '../editor/link-handler';
import { tableDecoField } from '../editor/table-field';
import { csvTableField } from '../editor/csv-field';
import { requestUserEditCheckpoint, type UserEditCheckpointReason } from '../utils/checkpoints';
import type { FileVersion } from '../types';

/* ── Types ── */

export interface ArtifactEditorHandle {
  getView(): EditorView | null;
  focus(): void;
}

export interface ArtifactEditorProps {
  content: string;
  filePath?: string;
  fileVersion?: FileVersion | null;
  mode: 'markdown' | 'code' | 'csv' | 'text';
  language?: string | null;
  onSelectionChange?: (view: EditorView) => void;
  onContentChange?: (content: string, fileVersion?: FileVersion | null) => void;
  /**
   * 只读模式：禁用编辑、不挂 autosave listener、不挂 file watch。
   * 调用方（如派生 viewer 窗口）自己管 watchFile → setContent 即可。
   */
  readOnly?: boolean;
}

const SAVE_DELAY = 600;
const CHECKPOINT_INTERVAL = 5 * 60 * 1000;

interface SaveJob {
  text: string;
  revision: number;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function showSaveError(prefixKey: string, err: unknown): void {
  const tFn = window.t ?? ((p: string) => p);
  window.dispatchEvent(new CustomEvent('hana-inline-notice', {
    detail: { text: `${tFn(prefixKey)}: ${getErrorMessage(err)}`, type: 'error' },
  }));
}

function clampPos(pos: number, max: number): number {
  return Math.max(0, Math.min(pos, max));
}

function replaceDocumentPreservingSelection(view: EditorView, content: string): boolean {
  const current = view.state.doc.toString();
  if (current === content) return false;
  const nextLength = content.length;
  const { anchor, head } = view.state.selection.main;
  view.dispatch({
    changes: { from: 0, to: current.length, insert: content },
    selection: EditorSelection.single(clampPos(anchor, nextLength), clampPos(head, nextLength)),
    annotations: Transaction.remote.of(true),
  });
  return true;
}

/* ── File change emitter (global singleton) ── */

const _fileChangeEmitter = new EventTarget();
let _fileChangeListenerSetup = false;

function setupFileChangeListener() {
  if (_fileChangeListenerSetup) return;
  _fileChangeListenerSetup = true;
  window.platform?.onFileChanged((filePath: string) => {
    _fileChangeEmitter.dispatchEvent(new CustomEvent('change', { detail: filePath }));
  });
}

/* ── Editor Component ── */

export const ArtifactEditor = forwardRef<ArtifactEditorHandle, ArtifactEditorProps>(
  function ArtifactEditor({ content, filePath, fileVersion, mode, language, onSelectionChange, onContentChange, readOnly = false }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const saveInFlightRef = useRef(false);
    const pendingSaveRef = useRef<SaveJob | null>(null);
    const lastSavedContentRef = useRef<string>(content);
    const selfWriteContentsRef = useRef<Set<string>>(new Set());
    const diskVersionRef = useRef<FileVersion | null>(fileVersion ?? null);
    const docRevisionRef = useRef(0);
    const lastCheckpointAtRef = useRef<number>(0);
    const filePathRef = useRef(filePath);
    filePathRef.current = filePath;
    const selectionCbRef = useRef(onSelectionChange);
    selectionCbRef.current = onSelectionChange;
    const contentCbRef = useRef(onContentChange);
    contentCbRef.current = onContentChange;

    useEffect(() => {
      if (fileVersion !== undefined) {
        diskVersionRef.current = fileVersion;
      }
    }, [fileVersion]);

    // Per-instance compartments for dynamic reconfiguration
    const cRef = useRef({
      lang: new Compartment(),
      highlight: new Compartment(),
      gutter: new Compartment(),
      conceal: new Compartment(),
      theme: new Compartment(),
    });

    useImperativeHandle(ref, () => ({
      getView: () => viewRef.current,
      focus: () => viewRef.current?.focus(),
    }));

    const createCheckpointIfDue = useCallback(async (fp: string) => {
      const now = Date.now();
      if (lastCheckpointAtRef.current > 0 && now - lastCheckpointAtRef.current < CHECKPOINT_INTERVAL) return;
      const reason: UserEditCheckpointReason = lastCheckpointAtRef.current > 0
        ? 'autosave-interval'
        : 'edit-start';
      try {
        await requestUserEditCheckpoint(fp, reason);
      } catch (err) {
        console.warn('[ArtifactEditor] checkpoint failed:', err);
        showSaveError('settings.saveFailed', err);
      } finally {
        lastCheckpointAtRef.current = now;
      }
    }, []);

    const rememberSelfWrite = useCallback((text: string) => {
      selfWriteContentsRef.current.add(text);
      window.setTimeout(() => {
        selfWriteContentsRef.current.delete(text);
      }, 5000);
    }, []);

    const performSave = useCallback(async ({ text, revision }: SaveJob) => {
      const fp = filePathRef.current;
      if (!fp) return;

      try {
        await createCheckpointIfDue(fp);
        if (revision !== docRevisionRef.current || fp !== filePathRef.current) return;
        const expectedVersion = diskVersionRef.current;
        let nextVersion: FileVersion | null | undefined;

        if (window.platform?.writeFileIfUnchanged) {
          const result = await window.platform.writeFileIfUnchanged(fp, text, expectedVersion);
          if (!result?.ok) {
            if (result?.conflict) {
              const tFn = window.t ?? ((p: string) => p);
              throw new Error(tFn('settings.fileChangedOnDisk'));
            }
            throw new Error('write-file-if-unchanged returned false');
          }
          nextVersion = result.version ?? null;
          if (result.version) diskVersionRef.current = result.version;
          rememberSelfWrite(text);
        } else {
          rememberSelfWrite(text);
          const ok = await window.platform?.writeFile(fp, text);
          if (ok === false) throw new Error('write-file returned false');
          nextVersion = undefined;
        }
        lastSavedContentRef.current = text;

        if (revision === docRevisionRef.current && fp === filePathRef.current && nextVersion !== undefined) {
          contentCbRef.current?.(text, nextVersion);
        }
      } catch (err) {
        console.warn('[ArtifactEditor] write failed:', err);
        showSaveError('settings.saveFailed', err);
      }
    }, [createCheckpointIfDue, rememberSelfWrite]);

    const drainSaveQueue = useCallback(function drain() {
      if (saveInFlightRef.current) return;
      const job = pendingSaveRef.current;
      if (!job) return;
      pendingSaveRef.current = null;
      saveInFlightRef.current = true;
      void performSave(job).finally(() => {
        saveInFlightRef.current = false;
        drain();
      });
    }, [performSave]);

    const saveToFile = useCallback((text: string, revision: number = docRevisionRef.current) => {
      pendingSaveRef.current = { text, revision };
      drainSaveQueue();
    }, [drainSaveQueue]);

    // Create editor
    useEffect(() => {
      if (!containerRef.current) return;
      const c = cRef.current;
      const isMd = mode === 'markdown';
      const isCsv = mode === 'csv';

      const extensions = [
        drawSelection(),
        history(),
        bracketMatching(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        // 只读模式：禁用编辑 + 关闭 autosave；不挂 file watch（调用方自理）
        ...(readOnly
          ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
          : [
              EditorView.updateListener.of((update) => {
                if (!update.docChanged) return;
                if (update.transactions.some((tr) => tr.annotation(Transaction.remote))) return;
                const text = update.state.doc.toString();
                docRevisionRef.current += 1;
                const revision = docRevisionRef.current;
                contentCbRef.current?.(text);
                if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
                saveTimerRef.current = setTimeout(() => {
                  saveTimerRef.current = null;
                  saveToFile(text, revision);
                }, SAVE_DELAY);
              }),
            ]),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet && selectionCbRef.current) {
            selectionCbRef.current(update.view);
          }
        }),
        // Dynamic compartments
        c.gutter.of(isMd || isCsv ? [] : lineNumbers()),
        c.lang.of(
          isMd ? markdown({ base: markdownLanguage, codeLanguages: languages }) : [],
        ),
        c.highlight.of(
          syntaxHighlighting(isMd ? markdownHighlight : codeHighlight),
        ),
        c.conceal.of(isMd ? [markdownDecoPlugin, markdownBlockDecoField] : []),
        ...(isMd ? [tableDecoField] : []),
        ...(isCsv ? [csvTableField] : []),
        c.theme.of(isMd || isCsv ? markdownTheme : codeTheme),
        linkClickHandler,
      ];

      // 代码模式保留行高亮，markdown / csv 模式不要
      if (!isMd && !isCsv) extensions.push(highlightActiveLine());

      const state = EditorState.create({ doc: content, extensions });
      const view = new EditorView({ state, parent: containerRef.current });
      viewRef.current = view;

      return () => {
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
          saveToFile(view.state.doc.toString(), docRevisionRef.current);
        }
        view.destroy();
        viewRef.current = null;
      };
    }, [mode, language, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps -- 仅在 mode/language/readOnly 变化时重建 CodeMirror，content/refs 故意省略以避免销毁重建

    // content prop change → update editor (skip if already in sync)
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current !== content) {
        docRevisionRef.current += 1;
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        replaceDocumentPreservingSelection(view, content);
      }
    }, [content]);

    // File watching（只读模式下由调用方自理，这里跳过避免重复监听）
    useEffect(() => {
      if (!filePath || readOnly) return;
      setupFileChangeListener();
      window.platform?.watchFile(filePath);

      const handler = (e: Event) => {
        const changedPath = (e as CustomEvent).detail;
        if (changedPath !== filePath) return;
        void (async () => {
          const snapshot = await window.platform?.readFileSnapshot?.(filePath);
          const newContent = snapshot?.content ?? await window.platform?.readFile(filePath);
          if (snapshot?.version) diskVersionRef.current = snapshot.version;
          return newContent;
        })()
          .then((newContent) => {
            if (newContent == null) return;
            // Content comparison: same as last write → self-write, ignore
            if (newContent === lastSavedContentRef.current || selfWriteContentsRef.current.has(newContent)) {
              lastSavedContentRef.current = newContent;
              return;
            }
            const view = viewRef.current;
            if (!view) return;
            const current = view.state.doc.toString();
            if (current === newContent) return;
            docRevisionRef.current += 1;
            if (saveTimerRef.current) {
              clearTimeout(saveTimerRef.current);
              saveTimerRef.current = null;
            }
            lastSavedContentRef.current = newContent;
            replaceDocumentPreservingSelection(view, newContent);
            contentCbRef.current?.(newContent, diskVersionRef.current);
          })
          .catch((err) => {
            console.warn('[ArtifactEditor] reload watched file failed:', err);
          });
      };

      _fileChangeEmitter.addEventListener('change', handler);
      return () => {
        _fileChangeEmitter.removeEventListener('change', handler);
        window.platform?.unwatchFile(filePath);
      };
    }, [filePath, readOnly]);

    return <div className={`artifact-editor mode-${mode}`} ref={containerRef} />;
  },
);
