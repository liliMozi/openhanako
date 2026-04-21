import { EditorView, Decoration } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { EditorState, StateField, RangeSetBuilder, type Transaction } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { TableWidget } from './widgets/table';

function buildTableDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  // Collect active lines
  const activeLines = new Set<number>();
  for (const range of state.selection.ranges) {
    const start = state.doc.lineAt(range.from).number;
    const end = state.doc.lineAt(range.to).number;
    for (let i = start; i <= end; i++) activeLines.add(i);
  }

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Table') return;

      // Check if any line in the table is active
      const startLine = state.doc.lineAt(node.from).number;
      const endLine = state.doc.lineAt(node.to).number;
      let tableActive = false;
      for (let i = startLine; i <= endLine; i++) {
        if (activeLines.has(i)) { tableActive = true; break; }
      }

      if (!tableActive) {
        const source = state.doc.sliceString(node.from, node.to);
        builder.add(
          node.from,
          node.to,
          Decoration.replace({ widget: new TableWidget(source, node.from), block: true }),
        );
      }
    },
  });

  return builder.finish();
}

export const tableDecoField = StateField.define<DecorationSet>({
  create(state) { return buildTableDecorations(state); },
  update(value, tr: Transaction) {
    if (tr.docChanged || tr.selection
        || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      return buildTableDecorations(tr.state);
    }
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});
