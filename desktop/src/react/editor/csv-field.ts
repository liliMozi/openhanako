import { EditorView, Decoration } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { EditorState, StateField, RangeSetBuilder, type Transaction } from '@codemirror/state';
import { CsvTableWidget } from './widgets/csv-table';

function buildCsvDecoration(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  // 光标在文档中时不渲染 widget（允许原始编辑）
  const hasSelection = state.selection.ranges.some(r => r.from !== r.to);
  const cursorAt = state.selection.main.head;
  const docLen = state.doc.length;

  // 只要光标聚焦在编辑器中且有实际选区，就保持原始文本模式
  // 否则整个文档替换为表格 widget
  if (hasSelection) return builder.finish();

  // 如果光标在文档范围内且文档非空，仍然渲染表格
  // （点击单元格时 widget 自己处理编辑）
  if (docLen === 0) return builder.finish();

  const source = state.doc.toString();
  builder.add(
    0,
    docLen,
    Decoration.replace({ widget: new CsvTableWidget(source), block: true }),
  );

  return builder.finish();
}

export const csvTableField = StateField.define<DecorationSet>({
  create(state) { return buildCsvDecoration(state); },
  update(value, tr: Transaction) {
    if (tr.docChanged || tr.selection) {
      return buildCsvDecoration(tr.state);
    }
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});
