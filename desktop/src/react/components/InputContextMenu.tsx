/**
 * InputContextMenu — 输入框全局右键菜单
 *
 * 监听 document 级别的 contextmenu 事件，当目标是 input/textarea 时
 * 弹出剪切 / 复制 / 粘贴 / 全选菜单，复用已有 ContextMenu 组件与样式。
 */

import { useState, useCallback, useEffect } from 'react';
import { ContextMenu } from './ContextMenu';
import type { ContextMenuItem } from './ContextMenu';

declare function t(key: string): string;

const TEXT_INPUT_TYPES = new Set([
  'text', 'password', 'email', 'search', 'url', 'tel', 'number', '',
]);

function isTextInput(el: EventTarget | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type);
  // contentEditable 元素（TipTap、CodeMirror 等富文本/代码编辑器）
  if (el.isContentEditable) return true;
  // CodeMirror: 事件目标可能是 .cm-line 等非 contentEditable 子元素，
  // 但它们的祖先 .cm-content 是 contentEditable
  if (el.closest('.cm-content')) return true;
  return false;
}

interface MenuState {
  position: { x: number; y: number };
  target: HTMLElement;
}

function getSelection(): string {
  return window.getSelection()?.toString() || '';
}

function getContent(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  return el.textContent || '';
}

function findEditableRoot(el: HTMLElement): HTMLElement {
  // 对于 CM 子元素，找到 .cm-content 作为可编辑根
  if (!el.isContentEditable) {
    const cmContent = el.closest('.cm-content') as HTMLElement | null;
    if (cmContent) return cmContent;
  }
  return el;
}

function isEditable(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  const root = findEditableRoot(el);
  return root.isContentEditable;
}

function selectAll(el: HTMLElement): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    el.select();
    return;
  }
  // contentEditable / CodeMirror
  const root = findEditableRoot(el);
  root.focus();
  const range = document.createRange();
  range.selectNodeContents(root);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

export function InputContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target;
      if (!isTextInput(target)) return;

      // 如果已有更具体的右键菜单（比如 desk 的），不拦截
      if ((target as HTMLElement).closest('[data-no-input-ctx]')) return;

      e.preventDefault();
      setMenu({ position: { x: e.clientX, y: e.clientY }, target });
    };

    document.addEventListener('contextmenu', handleContextMenu);
    return () => document.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  const handleClose = useCallback(() => setMenu(null), []);

  if (!menu) return null;

  const { target } = menu;
  const hasSelection = getSelection().length > 0;
  const hasContent = getContent(target).length > 0;
  const editable = isEditable(target);

  const items: ContextMenuItem[] = [];

  if (editable) {
    items.push({
      label: t('ctx.cut'),
      action: () => {
        if (!hasSelection) return;
        document.execCommand('cut');
      },
    });
  }

  items.push({
    label: t('ctx.copy'),
    action: () => {
      if (!hasSelection) return;
      document.execCommand('copy');
    },
  });

  if (editable) {
    items.push({
      label: t('ctx.paste'),
      action: () => {
        target.focus();
        document.execCommand('paste');
      },
    });
  }

  if (hasContent) {
    items.push({ divider: true });
    items.push({
      label: t('ctx.selectAll'),
      action: () => selectAll(target),
    });
  }

  return (
    <ContextMenu
      items={items}
      position={menu.position}
      onClose={handleClose}
    />
  );
}
