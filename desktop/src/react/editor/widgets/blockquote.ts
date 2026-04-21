import { EditorView, Decoration } from '@codemirror/view';
import type { DecoRange } from '../md-decorations';

const blockquoteLineDeco = Decoration.line({ class: 'cm-blockquote-line' });

export function handleBlockquote(ctx: {
  view: EditorView;
  node: { name: string; from: number; to: number };
  ranges: DecoRange[];
}) {
  const { view, node, ranges } = ctx;
  const startLine = view.state.doc.lineAt(node.from);
  const endLine = view.state.doc.lineAt(node.to);
  for (let i = startLine.number; i <= endLine.number; i++) {
    const line = view.state.doc.line(i);
    ranges.push({ from: line.from, to: line.from, deco: blockquoteLineDeco });
  }
}
