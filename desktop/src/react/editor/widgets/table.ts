import { EditorView, WidgetType } from '@codemirror/view';
import { getMd } from '../../utils/markdown';

/** 去掉首尾的 | 后按 | 拆分，保留空单元格 */
function parseRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

function isSeparator(line: string): boolean {
  return /^\|?[\s\-:|]+\|?$/.test(line.trim());
}

/** 单元格内的 | 转义为 \| */
function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

export class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly nodeFrom: number,
  ) { super(); }

  eq(other: TableWidget) { return this.source === other.source; }

  toDOM(view: EditorView) {
    const md = getMd();
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-table-widget';

    const rawLines = this.source.split('\n').filter(l => l.trim());
    if (rawLines.length < 2) {
      wrapper.textContent = this.source;
      return wrapper;
    }

    const headers = parseRow(rawLines[0]);
    const sepIdx = rawLines.findIndex((l, i) => i > 0 && isSeparator(l));
    if (sepIdx === -1) {
      wrapper.textContent = this.source;
      return wrapper;
    }
    const bodyLines = rawLines.slice(sepIdx + 1);
    const bodyData = bodyLines.map(parseRow);
    const colCount = headers.length;

    const table = document.createElement('table');

    // ── thead ──
    const thead = document.createElement('thead');
    const headTr = document.createElement('tr');
    headers.forEach((h, ci) => {
      const th = document.createElement('th');
      th.dataset.raw = h;
      th.dataset.row = '-1';
      th.dataset.col = String(ci);
      th.innerHTML = md.renderInline(h);
      th.contentEditable = 'true';
      th.spellcheck = false;
      this.bindCell(th, wrapper, view);
      headTr.appendChild(th);
    });
    thead.appendChild(headTr);
    table.appendChild(thead);

    // ── tbody ──
    const tbody = document.createElement('tbody');
    bodyData.forEach((row, ri) => {
      const tr = document.createElement('tr');
      for (let ci = 0; ci < colCount; ci++) {
        const td = document.createElement('td');
        const raw = row[ci] ?? '';
        td.dataset.raw = raw;
        td.dataset.row = String(ri);
        td.dataset.col = String(ci);
        td.innerHTML = md.renderInline(raw);
        td.contentEditable = 'true';
        td.spellcheck = false;
        this.bindCell(td, wrapper, view);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrapper.appendChild(table);
    return wrapper;
  }

  /** 给单元格绑定编辑事件 */
  private bindCell(cell: HTMLElement, wrapper: HTMLElement, view: EditorView) {
    const md = getMd();

    // Focus → 显示原始 markdown 供编辑
    cell.addEventListener('focus', () => {
      cell.textContent = cell.dataset.raw || '';
      // 全选方便替换
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(cell);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });

    // Blur → 读回新内容、重渲染、同步到文档
    cell.addEventListener('blur', () => {
      const newRaw = cell.textContent || '';
      if (newRaw === cell.dataset.raw) {
        // 没变化，只是恢复渲染
        cell.innerHTML = md.renderInline(newRaw);
        return;
      }
      cell.dataset.raw = newRaw;
      cell.innerHTML = md.renderInline(newRaw);
      this.syncToDocument(wrapper, view);
    });

    // 键盘快捷键
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        // 放弃编辑，恢复原值
        cell.textContent = cell.dataset.raw || '';
        cell.innerHTML = md.renderInline(cell.dataset.raw || '');
        view.focus();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        cell.blur(); // 确认编辑
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const next = e.shiftKey
          ? this.adjacentCell(cell, wrapper, -1)
          : this.adjacentCell(cell, wrapper, 1);
        if (next) {
          cell.blur();
          next.focus();
        } else {
          cell.blur();
          view.focus();
        }
      }
    });
  }

  /** 找相邻单元格 */
  private adjacentCell(current: HTMLElement, wrapper: HTMLElement, dir: number): HTMLElement | null {
    const cells = Array.from(wrapper.querySelectorAll<HTMLElement>('th, td'));
    const idx = cells.indexOf(current);
    if (idx === -1) return null;
    const next = cells[idx + dir];
    return next ?? null;
  }

  /** 从 DOM 读取所有单元格，重建 markdown 表格，写回文档 */
  private syncToDocument(wrapper: HTMLElement, view: EditorView) {
    const headerCells = Array.from(wrapper.querySelectorAll<HTMLElement>('thead th'));
    const headers = headerCells.map(c => escapeCell(c.dataset.raw || ''));

    const rows: string[][] = [];
    const trs = wrapper.querySelectorAll<HTMLElement>('tbody tr');
    trs.forEach(tr => {
      const tds = Array.from(tr.querySelectorAll<HTMLElement>('td'));
      rows.push(tds.map(c => escapeCell(c.dataset.raw || '')));
    });

    // 按最长内容对齐列宽
    const colWidths = headers.map((h, i) => {
      let max = h.length;
      for (const row of rows) max = Math.max(max, (row[i] || '').length);
      return Math.max(max, 3);
    });

    const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));

    const headerLine = '| ' + headers.map((h, i) => pad(h, colWidths[i])).join(' | ') + ' |';
    const sepLine = '| ' + colWidths.map(w => '-'.repeat(w)).join(' | ') + ' |';
    const bodyMd = rows.map(row =>
      '| ' + row.map((c, i) => pad(c || '', colWidths[i])).join(' | ') + ' |',
    );
    const newMarkdown = [headerLine, sepLine, ...bodyMd].join('\n');

    if (newMarkdown === this.source) return;

    // 校验：文档中对应位置的内容是否还是原始 source
    const from = this.nodeFrom;
    const to = from + this.source.length;
    if (to > view.state.doc.length) return;
    const current = view.state.doc.sliceString(from, to);
    if (current !== this.source) return; // 文档已被别人改过，放弃同步

    view.dispatch({ changes: { from, to, insert: newMarkdown } });
  }

  /** 让 widget 自行处理所有 DOM 事件（不让 CM6 截获） */
  ignoreEvent() { return true; }
}
