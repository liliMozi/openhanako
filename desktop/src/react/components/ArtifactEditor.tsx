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
  ViewPlugin, Decoration, WidgetType, lineNumbers,
} from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { EditorState, Compartment, RangeSetBuilder } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  syntaxHighlighting, HighlightStyle, bracketMatching, syntaxTree,
} from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';

/* ── Types ── */

export interface ArtifactEditorHandle {
  getView(): EditorView | null;
  focus(): void;
}

export interface ArtifactEditorProps {
  content: string;
  filePath?: string;
  mode: 'markdown' | 'code' | 'text';
  language?: string | null;
}

const SAVE_DELAY = 600;

/* ── CM6 Theme ── */

const codeTheme = EditorView.theme({
  '&': {
    fontSize: '0.84rem',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.7',
  },
});

const markdownTheme = EditorView.theme({
  '&': {
    fontSize: '0.92rem',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-serif)',
    lineHeight: '1.75',
    padding: 'var(--space-md) 0',
  },
  '.cm-content': {
    padding: '0 var(--space-lg)',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--text)',
  },
});

/* ── Markdown live preview highlight ── */

const markdownHighlight = HighlightStyle.define([
  // 标题尺寸匹配预览面板
  { tag: tags.heading1, fontSize: '1.2em', fontWeight: '700' },
  { tag: tags.heading2, fontSize: '1.1em', fontWeight: '600' },
  { tag: tags.heading3, fontSize: '1.05em', fontWeight: '600' },
  { tag: tags.heading4, fontWeight: '600' },
  { tag: tags.heading5, fontWeight: '600' },
  { tag: tags.heading6, fontWeight: '600' },
  // 语法标记（#, **, *, ``）淡显（cursor 行可见时）
  { tag: tags.processingInstruction, color: 'var(--text-muted)', opacity: '0.4' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.9em',
    backgroundColor: 'var(--overlay-light)', borderRadius: '3px' },
  { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--text-muted)', fontSize: '0.85em' },
  { tag: tags.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: tags.list, color: 'var(--text)' },
  { tag: tags.meta, color: 'var(--text-muted)' },
]);

const codeHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#8959a8' },
  { tag: tags.string, color: '#718c00' },
  { tag: tags.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: tags.number, color: '#f5871f' },
  { tag: tags.operator, color: '#3e999f' },
  { tag: tags.definition(tags.variableName), color: '#4271ae' },
  { tag: tags.function(tags.variableName), color: '#4271ae' },
  { tag: tags.typeName, color: '#c82829' },
]);

/* ── Markdown decoration plugin (conceal + line styles, single tree pass) ── */

const CONCEAL_MARKS = new Set([
  'HeaderMark', 'EmphasisMark', 'CodeMark', 'StrikethroughMark',
  'LinkMark', 'URL',
]);

const hideMark = Decoration.replace({});
const centerLineDeco = Decoration.line({ class: 'cm-center-line' });

class HrWidget extends WidgetType {
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-hr-widget';
    return el;
  }
  eq() { return true; }
}

const hrDecoration = Decoration.replace({ widget: new HrWidget() });

function buildMarkdownDecorations(view: EditorView): DecorationSet {
  const activeLines = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const startLine = view.state.doc.lineAt(range.from).number;
    const endLine = view.state.doc.lineAt(range.to).number;
    for (let i = startLine; i <= endLine; i++) activeLines.add(i);
  }

  const ranges: { from: number; to: number; deco: Decoration }[] = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter(node) {
        const line = view.state.doc.lineAt(node.from);
        const isActive = activeLines.has(line.number);

        // H1 居中（含活跃行）
        if (node.name === 'ATXHeading1') {
          ranges.push({ from: line.from, to: line.from, deco: centerLineDeco });
          return;
        }

        // HR: 非活跃行替换为 widget + 居中
        if (node.name === 'HorizontalRule') {
          if (!isActive) {
            ranges.push({ from: node.from, to: node.to, deco: hrDecoration });
            ranges.push({ from: line.from, to: line.from, deco: centerLineDeco });
          }
          return;
        }

        // 活跃行不隐藏语法标记
        if (isActive) return;
        if (!CONCEAL_MARKS.has(node.name)) return;

        let hideTo = node.to;
        if (node.name === 'HeaderMark') {
          const next = view.state.doc.sliceString(hideTo, hideTo + 1);
          if (next === ' ') hideTo += 1;
        }
        ranges.push({ from: node.from, to: hideTo, deco: hideMark });
      },
    });
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.deco);
  return builder.finish();
}

const markdownDecoPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildMarkdownDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildMarkdownDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

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
  function ArtifactEditor({ content, filePath, mode, language }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const selfSaveRef = useRef(false);
    const filePathRef = useRef(filePath);
    filePathRef.current = filePath;

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
      window.platform?.writeFile(fp, text).finally(() => {
        setTimeout(() => {
          if (!saveTimerRef.current) selfSaveRef.current = false;
        }, 300);
      });
    }, []);

    // Create editor
    useEffect(() => {
      if (!containerRef.current) return;
      const c = cRef.current;
      const isMd = mode === 'markdown';

      const extensions = [
        drawSelection(),
        history(),
        bracketMatching(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          selfSaveRef.current = true;
          const text = update.state.doc.toString();
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
          saveTimerRef.current = setTimeout(() => {
            saveTimerRef.current = null;
            saveToFile(text);
          }, SAVE_DELAY);
        }),
        // Dynamic compartments
        c.gutter.of(isMd ? [] : lineNumbers()),
        c.lang.of(
          isMd ? markdown({ base: markdownLanguage, codeLanguages: languages }) : [],
        ),
        c.highlight.of(
          syntaxHighlighting(isMd ? markdownHighlight : codeHighlight),
        ),
        c.conceal.of(isMd ? markdownDecoPlugin : []),
        c.theme.of(isMd ? markdownTheme : codeTheme),
      ];

      // 代码模式保留行高亮，markdown 模式不要
      if (!isMd) extensions.push(highlightActiveLine());

      const state = EditorState.create({ doc: content, extensions });
      const view = new EditorView({ state, parent: containerRef.current });
      viewRef.current = view;

      return () => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        view.destroy();
        viewRef.current = null;
      };
    }, [mode, language]); // eslint-disable-line react-hooks/exhaustive-deps -- 仅在 mode/language 变化时重建 CodeMirror，content/refs 故意省略以避免销毁重建

    // content prop change → update editor (skip during active editing)
    useEffect(() => {
      const view = viewRef.current;
      if (!view || selfSaveRef.current) return;
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
        if (selfSaveRef.current) return;
        window.platform?.readFile(filePath).then((newContent) => {
          if (newContent == null) return;
          const view = viewRef.current;
          if (!view) return;
          const current = view.state.doc.toString();
          if (current !== newContent) {
            view.dispatch({
              changes: { from: 0, to: current.length, insert: newContent },
            });
          }
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
