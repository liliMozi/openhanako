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
});
