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
import { EditorState, Compartment } from '@codemirror/state';
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

/* ── Types ── */

export interface ArtifactEditorHandle {
  getView(): EditorView | null;
  focus(): void;
}

export interface ArtifactEditorProps {
  content: string;
  filePath?: string;
  mode: 'markdown' | 'code' | 'csv' | 'text';
  language?: string | null;
  onSelectionChange?: (view: EditorView) => void;
  onContentChange?: (content: string) => void;
  /**
   * 只读模式：禁用编辑、不挂 autosave listener、不挂 file watch。
   * 调用方（如派生 viewer 窗口）自己管 watchFile → setContent 即可。
   */
  readOnly?: boolean;
}

const SAVE_DELAY = 600;
const CHECKPOINT_INTERVAL = 5 * 60 * 1000;

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function showSaveError(prefixKey: string, err: unknown): void {
  const tFn = window.t ?? ((p: string) => p);
  window.dispatchEvent(new CustomEvent('hana-inline-notice', {
    detail: { text: `${tFn(prefixKey)}: ${getErrorMessage(err)}`, type: 'error' },
  }));
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
  function ArtifactEditor({ content, filePath, mode, language, onSelectionChange, onContentChange, readOnly = false }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSavedContentRef = useRef<string>(content);
    const selfWriteContentsRef = useRef<Set<string>>(new Set());
    const lastCheckpointAtRef = useRef<number>(0);
    const filePathRef = useRef(filePath);
    filePathRef.current = filePath;
    const selectionCbRef = useRef(onSelectionChange);
    selectionCbRef.current = onSelectionChange;
    const contentCbRef = useRef(onContentChange);
    contentCbRef.current = onContentChange;

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

    const saveToFile = useCallback((text: string) => {
      const fp = filePathRef.current;
      if (!fp) return;
      void (async () => {
        await createCheckpointIfDue(fp);
        selfWriteContentsRef.current.add(text);
        window.setTimeout(() => {
          selfWriteContentsRef.current.delete(text);
        }, 5000);
        const ok = await window.platform?.writeFile(fp, text);
        if (ok === false) throw new Error('write-file returned false');
        lastSavedContentRef.current = text;
      })().catch((err) => {
        console.warn('[ArtifactEditor] write failed:', err);
        showSaveError('settings.saveFailed', err);
      });
    }, [createCheckpointIfDue]);

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
                const text = update.state.doc.toString();
                contentCbRef.current?.(text);
                if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
                saveTimerRef.current = setTimeout(() => {
                  saveTimerRef.current = null;
                  saveToFile(text);
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
          saveToFile(view.state.doc.toString());
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
        view.dispatch({
          changes: { from: 0, to: current.length, insert: content },
        });
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
        void window.platform?.readFile(filePath)
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
            lastSavedContentRef.current = newContent;
            view.dispatch({
              changes: { from: 0, to: current.length, insert: newContent },
            });
            contentCbRef.current?.(newContent);
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
