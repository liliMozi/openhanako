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
  lineNumbers,
} from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  syntaxHighlighting, bracketMatching,
} from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { markdownHighlight, codeHighlight } from './react/editor/highlight';
import { markdownTheme, codeTheme } from './react/editor/theme';
import { markdownDecoPlugin } from './react/editor/md-decorations';
import { linkClickHandler } from './react/editor/link-handler';
import { tableDecoField } from './react/editor/table-field';

const SAVE_DELAY = 600;

/* ── Editor window logic ── */

const hana = (window as any).hana;
const titleEl = document.getElementById('editorTitle')!;
const bodyEl = document.getElementById('editorBody')!;
const btnDock = document.getElementById('btnDock')!;
const btnClose = document.getElementById('btnClose')!;

let filePath: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSavedContent = '';
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
    ...(isMd ? [tableDecoField] : []),
    themeComp.of(isMd ? markdownTheme : codeTheme),
    linkClickHandler,
  ];

  if (!isMd) extensions.push(highlightActiveLine());

  const state = EditorState.create({ doc: content, extensions });
  editorView = new EditorView({ state, parent: bodyEl });
}

async function saveContent(text: string) {
  if (!filePath) return;
  lastSavedContent = text;
  await hana?.writeFile(filePath, text);
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
    if (changedPath !== filePath) return;
    hana?.readFile(filePath).then((newContent: string | null) => {
      if (newContent == null || !editorView) return;
      // Content comparison: same as last write → self-write, ignore
      if (newContent === lastSavedContent) return;
      const current = editorView.state.doc.toString();
      if (current === newContent) return;
      lastSavedContent = newContent;
      editorView.dispatch({
        changes: { from: 0, to: current.length, insert: newContent },
      });
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
