import { EditorView, Decoration } from '@codemirror/view';
import type { DecoRange } from '../md-decorations';

const linkTextMark = Decoration.mark({ class: 'cm-link-text' });

export function handleLink(ctx: {
  view: EditorView;
  node: { name: string; from: number; to: number };
  activeLines: Set<number>;
  ranges: DecoRange[];
}) {
  const { view, node, activeLines, ranges } = ctx;
  const line = view.state.doc.lineAt(node.from);
  if (activeLines.has(line.number)) return;

  // Extract link text range: between first [ and first ]
  const text = view.state.doc.sliceString(node.from, node.to);
  const openBracket = text.indexOf('[');
  const closeBracket = text.indexOf(']');
  if (openBracket === -1 || closeBracket === -1 || closeBracket <= openBracket + 1) return;

  const textFrom = node.from + openBracket + 1;
  const textTo = node.from + closeBracket;
  ranges.push({ from: textFrom, to: textTo, deco: linkTextMark });
}
