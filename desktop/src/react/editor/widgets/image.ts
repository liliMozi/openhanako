import { EditorView, WidgetType, Decoration } from '@codemirror/view';
import type { DecoRange } from '../md-decorations';

export class ImageWidget extends WidgetType {
  constructor(readonly url: string, readonly alt: string) { super(); }

  eq(other: ImageWidget) { return this.url === other.url; }

  toDOM() {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-image-widget';
    const img = document.createElement('img');
    img.src = this.url;
    img.alt = this.alt;
    img.loading = 'lazy';
    img.onerror = () => {
      wrapper.innerHTML = '';
      const fallback = document.createElement('span');
      fallback.className = 'cm-image-fallback';
      fallback.textContent = this.alt || this.url;
      wrapper.appendChild(fallback);
    };
    wrapper.appendChild(img);
    return wrapper;
  }
}

export function handleImage(ctx: {
  view: EditorView;
  node: { name: string; from: number; to: number };
  activeLines: Set<number>;
  ranges: DecoRange[];
}) {
  const { view, node, activeLines, ranges } = ctx;
  const line = view.state.doc.lineAt(node.from);

  // Cross-line guard: Image should be single-line
  if (view.state.doc.lineAt(node.to).number !== line.number) return;
  if (activeLines.has(line.number)) return;

  const text = view.state.doc.sliceString(node.from, node.to);
  const urlMatch = text.match(/!\[([^\]]*)\]\(([^)]+)\)/);
  if (!urlMatch) return;

  const alt = urlMatch[1];
  const url = urlMatch[2];

  // Security: only allow local paths and http/https
  if (!url.startsWith('/') && !url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) return;

  ranges.push({
    from: node.from,
    to: node.to,
    deco: Decoration.replace({ widget: new ImageWidget(url, alt) }),
  });
}
