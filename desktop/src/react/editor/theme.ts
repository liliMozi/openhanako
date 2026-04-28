import { EditorView } from '@codemirror/view';

export const codeTheme = EditorView.theme({
  '&': { fontSize: '0.84rem' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.7',
  },
});

export const markdownTheme = EditorView.theme({
  '&': { fontSize: '0.92rem' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-serif)',
    lineHeight: '1.75',
    padding: 'var(--space-md) 0',
  },
  '.cm-content': { padding: '0 var(--space-lg)' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-md-mark': {
    backgroundColor: 'var(--cm-md-mark-bg, rgba(255, 248, 143, 0.72))',
    borderRadius: '2px',
    padding: '0 1px',
  },
  '.cm-math-widget': {
    fontFamily: 'var(--font-serif)',
  },
  '.cm-math-block-widget': {
    display: 'block',
    overflowX: 'auto',
    padding: 'var(--space-xs) 0',
    borderRadius: 'var(--radius-sm)',
    cursor: 'text',
  },
  '.cm-math-block-widget:hover': {
    backgroundColor: 'var(--overlay-subtle)',
  },
});
