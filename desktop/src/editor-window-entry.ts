/**
 * editor-window-entry.ts — 独立编辑器窗口的 CM6 入口
 *
 * 与 ArtifactEditor.tsx 共享相同的 markdown live preview 风格：
 * - 衬线体、conceal、H1 居中、HR widget
 * - 自动保存 + 文件变更监听
 *
 * 不依赖 React，直接操作 DOM。
 */

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

const SAVE_DELAY = 600;

/* ── CM6 Themes ── */

const codeTheme = EditorView.theme({
  '&': { fontSize: '0.84rem' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.7',
  },
});

const markdownTheme = EditorView.theme({
  '&': { fontSize: '0.92rem' },
  '.cm-scroller': {
    fontFamily: 'var(--font-serif)',
    lineHeight: '1.75',
    padding: '1.5rem 0',
  },
  '.cm-content': { padding: '0 1.5rem' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
});

/* ── Highlights ── */

const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.2em', fontWeight: '700' },
  { tag: tags.heading2, fontSize: '1.1em', fontWeight: '600' },
  { tag: tags.heading3, fontSize: '1.05em', fontWeight: '600' },
  { tag: tags.heading4, fontWeight: '600' },
  { tag: tags.heading5, fontWeight: '600' },
  { tag: tags.heading6, fontWeight: '600' },
  { tag: tags.processingInstruction, color: 'var(--text-muted)', opacity: '0.4' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.9em',
    backgroundColor: 'var(--overlay-light)', borderRadius: '3px' },
  { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--text-muted)', fontSize: '0.85em' },
  { tag: tags.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: tags.list, color: 'var(--text-muted)' },
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

/* ── Markdown conceal + line decorations (single tree pass) ── */

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

        if (node.name === 'ATXHeading1') {
          ranges.push({ from: line.from, to: line.from, deco: centerLineDeco });
          return;
        }
        if (node.name === 'HorizontalRule') {
          if (!isActive) {
            ranges.push({ from: node.from, to: node.to, deco: hrDecoration });
            ranges.push({ from: line.from, to: line.from, deco: centerLineDeco });
          }
          return;
        }
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

/* ── Editor window logic ── */

const hana = (window as any).hana;
const titleEl = document.getElementById('editorTitle')!;
const bodyEl = document.getElementById('editorBody')!;
const btnDock = document.getElementById('btnDock')!;
const btnClose = document.getElementById('btnClose')!;

let filePath: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let selfSave = false;
let editorView: EditorView | null = null;

function createEditor(content: string, isMd: boolean) {
  // 清理旧编辑器
  if (editorView) {
    editorView.destroy();
    editorView = null;
  }
  bodyEl.innerHTML = '';

  const langComp = new Compartment();
  const highlightComp = new Compartment();
  const gutterComp = new Compartment();
  const concealComp = new Compartment();
  const themeComp = new Compartment();

  const extensions = [
    drawSelection(),
    history(),
    bracketMatching(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const text = update.state.doc.toString();
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveContent(text), SAVE_DELAY);
    }),
    gutterComp.of(isMd ? [] : lineNumbers()),
    langComp.of(
      isMd ? markdown({ base: markdownLanguage, codeLanguages: languages }) : [],
    ),
    highlightComp.of(
      syntaxHighlighting(isMd ? markdownHighlight : codeHighlight),
    ),
    concealComp.of(isMd ? markdownDecoPlugin : []),
    themeComp.of(isMd ? markdownTheme : codeTheme),
  ];

  if (!isMd) extensions.push(highlightActiveLine());

  const state = EditorState.create({ doc: content, extensions });
  editorView = new EditorView({ state, parent: bodyEl });
}

async function saveContent(text: string) {
  if (!filePath) return;
  selfSave = true;
  await hana?.writeFile(filePath, text);
  setTimeout(() => { selfSave = false; }, 300);
}

async function loadContent(data: { filePath: string; title: string; type: string }) {
  filePath = data.filePath;
  titleEl.textContent = data.title || filePath.split('/').pop() || 'Editor';

  const isMd = data.type === 'markdown';
  if (isMd) bodyEl.classList.add('mode-markdown');
  else bodyEl.classList.remove('mode-markdown');

  const content = await hana?.readFile(filePath);
  if (content == null) return;

  createEditor(content, isMd);

  // 文件变更监听
  hana?.watchFile(filePath);
  hana?.onFileChanged((changedPath: string) => {
    if (changedPath !== filePath || selfSave) return;
    hana?.readFile(filePath).then((newContent: string | null) => {
      if (newContent == null || !editorView) return;
      const current = editorView.state.doc.toString();
      if (current !== newContent) {
        editorView.dispatch({
          changes: { from: 0, to: current.length, insert: newContent },
        });
      }
    });
  });
}

// IPC: 接收编辑器数据
hana?.onEditorLoad((data: any) => loadContent(data));

// 工具栏按钮
btnDock.addEventListener('click', () => hana?.editorDock?.());
btnClose.addEventListener('click', () => hana?.editorClose?.());

// 主题同步
const saved = localStorage.getItem('hana-theme') || 'auto';
const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const theme = saved === 'auto' ? (isDark ? 'midnight' : 'warm-paper') : saved;
document.getElementById('themeSheet')!.setAttribute('href', `themes/${theme}.css`);

// 衬线字体同步
if (localStorage.getItem('hana-font-serif') === '0') {
  document.body.classList.add('font-sans');
}
