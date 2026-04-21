import {
  EditorView, ViewPlugin, Decoration,
} from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { hrDecoration } from './widgets/hr';
import { handleCheckbox } from './widgets/checkbox';
import { handleBlockquote } from './widgets/blockquote';
import { handleCodeBlock } from './widgets/code-block';
import { handleImage } from './widgets/image';
import { handleLink } from './widgets/link';

export type DecoRange = { from: number; to: number; deco: Decoration };

export const hideMark = Decoration.replace({});
const centerLineDeco = Decoration.line({ class: 'cm-center-line' });

export const CONCEAL_MARKS = new Set([
  'HeaderMark', 'EmphasisMark', 'CodeMark', 'StrikethroughMark',
  'LinkMark', 'URL', 'QuoteMark',
]);

export function collectActiveLines(view: EditorView): Set<number> {
  const active = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const start = view.state.doc.lineAt(range.from).number;
    const end = view.state.doc.lineAt(range.to).number;
    for (let i = start; i <= end; i++) active.add(i);
  }
  return active;
}

export function buildMarkdownDecorations(view: EditorView): DecorationSet {
  const activeLines = collectActiveLines(view);
  const ranges: DecoRange[] = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter(node) {
        const line = view.state.doc.lineAt(node.from);
        const isActive = activeLines.has(line.number);

        // ── 始终渲染（不受 isActive 控制）──
        switch (node.name) {
          case 'ATXHeading1':
            ranges.push({ from: line.from, to: line.from, deco: centerLineDeco });
            return;
          case 'HorizontalRule':
            if (!isActive) {
              ranges.push({ from: node.from, to: node.to, deco: hrDecoration });
              ranges.push({ from: line.from, to: line.from, deco: centerLineDeco });
            }
            return;
          case 'TaskMarker':
            handleCheckbox({ view, node, ranges });
            return;
          case 'Blockquote':
            handleBlockquote({ view, node, ranges });
            return;
          case 'FencedCode':
            handleCodeBlock({ view, node, activeLines, ranges });
            return false; // don't traverse children
        }

        // ── 活跃行：跳过所有 conceal / replace ──
        if (isActive) return;

        // ── 非活跃行：按节点类型处理 ──
        switch (node.name) {
          case 'Image':
            handleImage({ view, node, activeLines, ranges });
            break;
          case 'Link':
            handleLink({ view, node, activeLines, ranges });
            break;
          // conceal marks
          case 'HeaderMark': case 'EmphasisMark': case 'CodeMark':
          case 'StrikethroughMark': case 'LinkMark': case 'URL': case 'QuoteMark': {
            let hideTo = node.to;
            if (node.name === 'HeaderMark') {
              const next = view.state.doc.sliceString(hideTo, hideTo + 1);
              if (next === ' ') hideTo += 1;
            }
            ranges.push({ from: node.from, to: hideTo, deco: hideMark });
            break;
          }
        }
      },
    });
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.deco);
  return builder.finish();
}

export const markdownDecoPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildMarkdownDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged
          || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = buildMarkdownDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
