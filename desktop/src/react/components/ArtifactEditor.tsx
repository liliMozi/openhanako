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
import { markdownDecoPlugin } from '../editor/md-decorations';
import { linkClickHandler } from '../editor/link-handler';
import { tableDecoField } from '../editor/table-field';
import { csvTableField } from '../editor/csv-field';

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
}

const SAVE_DELAY = 600;

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
  function ArtifactEditor({ content, filePath, mode, language, onSelectionChange }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSavedContentRef = useRef<string>(content);
    const filePathRef = useRef(filePath);
    filePathRef.current = filePath;
    const selectionCbRef = useRef(onSelectionChange);
    selectionCbRef.current = onSelectionChange;

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

    const saveToFile = useCallback((text: string) => {
      const fp = filePathRef.current;
      if (!fp) return;
      lastSavedContentRef.current = text;
      window.platform?.writeFile(fp, text);
    }, []);

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
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const text = update.state.doc.toString();
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
          saveTimerRef.current = setTimeout(() => {
            saveTimerRef.current = null;
            saveToFile(text);
          }, SAVE_DELAY);
        }),
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
        c.conceal.of(isMd ? markdownDecoPlugin : []),
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
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        view.destroy();
        viewRef.current = null;
      };
    }, [mode, language]); // eslint-disable-line react-hooks/exhaustive-deps -- 仅在 mode/language 变化时重建 CodeMirror，content/refs 故意省略以避免销毁重建

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

    // File watching
    useEffect(() => {
      if (!filePath) return;
      setupFileChangeListener();
      window.platform?.watchFile(filePath);

      const handler = (e: Event) => {
        const changedPath = (e as CustomEvent).detail;
        if (changedPath !== filePath) return;
        window.platform?.readFile(filePath).then((newContent) => {
          if (newContent == null) return;
          // Content comparison: same as last write → self-write, ignore
          if (newContent === lastSavedContentRef.current) return;
          const view = viewRef.current;
          if (!view) return;
          const current = view.state.doc.toString();
          if (current === newContent) return;
          lastSavedContentRef.current = newContent;
          view.dispatch({
            changes: { from: 0, to: current.length, insert: newContent },
          });
        });
      };

      _fileChangeEmitter.addEventListener('change', handler);
      return () => {
        _fileChangeEmitter.removeEventListener('change', handler);
        window.platform?.unwatchFile(filePath);
      };
    }, [filePath]);

    return <div className={`artifact-editor mode-${mode}`} ref={containerRef} />;
  },
);
