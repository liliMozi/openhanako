import { HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

export const markdownHighlight = HighlightStyle.define([
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
  { tag: tags.list, color: 'var(--text)' },
  { tag: tags.meta, color: 'var(--text-muted)' },
]);

export const codeHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#8959a8' },
  { tag: tags.string, color: '#718c00' },
  { tag: tags.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: tags.number, color: '#f5871f' },
  { tag: tags.operator, color: '#3e999f' },
  { tag: tags.definition(tags.variableName), color: '#4271ae' },
  { tag: tags.function(tags.variableName), color: '#4271ae' },
  { tag: tags.typeName, color: '#c82829' },
]);
