import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

export const linkClickHandler = EditorView.domEventHandlers({
  click(event, view) {
    if (!(event.metaKey || event.ctrlKey)) return false;

    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;

    const found = { url: '' };
    syntaxTree(view.state).iterate({
      from: pos, to: pos,
      enter(node) {
        if (node.name === 'URL') {
          found.url = view.state.doc.sliceString(node.from, node.to);
        }
      },
    });

    if (!found.url) return false;

    let url = found.url;
    // Remove surrounding parentheses if present
    if (url.startsWith('(') && url.endsWith(')')) {
      url = url.slice(1, -1);
    }
    (window as any).platform?.openExternal?.(url);
    return true;
  },
});
