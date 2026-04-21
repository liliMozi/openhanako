import { EditorView, WidgetType, Decoration } from '@codemirror/view';
import type { DecoRange } from '../md-decorations';

const codeBlockLineDeco = Decoration.line({ class: 'cm-codeblock-line' });

export class CodeLangWidget extends WidgetType {
  constructor(readonly lang: string) { super(); }
  eq(other: CodeLangWidget) { return this.lang === other.lang; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-codeblock-lang';
    el.textContent = this.lang;
    return el;
  }
}

export function handleCodeBlock(ctx: {
  view: EditorView;
  node: { name: string; from: number; to: number };
  activeLines: Set<number>;
  ranges: DecoRange[];
}) {
  const { view, node, activeLines, ranges } = ctx;
  const startLine = view.state.doc.lineAt(node.from);
  const endLine = view.state.doc.lineAt(node.to);

  // Check if any line in the code block is active
  let blockActive = false;
  for (let i = startLine.number; i <= endLine.number; i++) {
    if (activeLines.has(i)) { blockActive = true; break; }
  }

  // Add background to every line in the code block
  for (let i = startLine.number; i <= endLine.number; i++) {
    const line = view.state.doc.line(i);
    ranges.push({ from: line.from, to: line.from, deco: codeBlockLineDeco });
  }

  if (!blockActive) {
    // Hide fence lines when not active
    // Opening fence line
    if (startLine.text.trim().startsWith('```')) {
      const langMatch = startLine.text.match(/```(\w+)/);
      const lang = langMatch?.[1] || '';

      if (startLine.from < startLine.to) {
        if (lang) {
          // Replace fence with language label widget (float right)
          ranges.push({
            from: startLine.from,
            to: startLine.to,
            deco: Decoration.replace({ widget: new CodeLangWidget(lang) }),
          });
        } else {
          // No language, just hide the fence
          ranges.push({
            from: startLine.from,
            to: startLine.to,
            deco: Decoration.replace({}),
          });
        }
      }
    }
    // Closing fence line
    if (endLine.text.trim() === '```' && endLine.from < endLine.to) {
      ranges.push({
        from: endLine.from,
        to: endLine.to,
        deco: Decoration.replace({}),
      });
    }
  }
}
