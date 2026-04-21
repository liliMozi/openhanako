import { EditorView, WidgetType, Decoration } from '@codemirror/view';
import type { DecoRange } from '../md-decorations';

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }

  eq(other: CheckboxWidget) { return this.checked === other.checked; }

  toDOM(view: EditorView) {
    // eslint-disable-next-line no-restricted-syntax -- CodeMirror WidgetType.toDOM(), not React-managed DOM
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.checked;
    input.className = 'cm-checkbox';
    input.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const from = view.posAtDOM(input);
      const to = from + 3; // [x] or [ ] is always 3 chars
      const replacement = this.checked ? '[ ]' : '[x]';
      view.dispatch({ changes: { from, to, insert: replacement } });
    });
    return input;
  }

  ignoreEvent() { return false; }
}

export function handleCheckbox(ctx: {
  view: EditorView;
  node: { name: string; from: number; to: number };
  ranges: DecoRange[];
}) {
  const { view, node, ranges } = ctx;
  // TaskMarker node spans [x] or [ ] (including brackets, 3 chars)
  const text = view.state.doc.sliceString(node.from, node.to);
  const checked = text === '[x]' || text === '[X]';
  ranges.push({
    from: node.from,
    to: node.to,
    deco: Decoration.replace({ widget: new CheckboxWidget(checked) }),
  });
}
