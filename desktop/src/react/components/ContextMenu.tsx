/**
 * ContextMenu — 通用右键菜单（React portal）
 *
 * 替代 desk-shim.ts 的 DOM 命令式菜单。
 * 使用已有 CSS classes: .context-menu, .context-menu-item, .context-menu-divider
 */

import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label?: string;
  action?: () => void;
  danger?: boolean;
  divider?: boolean;
}

export interface ContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // 位置修正：确保菜单不超出视口
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    let { x, y } = position;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }, [position]);

  // 关闭：点击外部、右键外部、Escape
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const handleContextMenu = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    // 延迟注册，避免触发菜单的那次点击立即关闭它
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClick, true);
      document.addEventListener('contextmenu', handleContextMenu, true);
      document.addEventListener('keydown', handleKeyDown);
    });

    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', handleClick, true);
      document.removeEventListener('contextmenu', handleContextMenu, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const handleItemClick = useCallback((e: React.MouseEvent, action?: () => void) => {
    e.stopPropagation();
    onClose();
    action?.();
  }, [onClose]);

  return createPortal(
    <div
      className="context-menu"
      ref={menuRef}
      style={{ left: position.x, top: position.y }}
    >
      {items.map((item, i) => {
        if (item.divider) {
          return <div key={`divider-${i}`} className="context-menu-divider" />;
        }
        return (
          <div
            key={`${item.label || 'item'}-${i}`}
            className={`context-menu-item${item.danger ? ' danger' : ''}`}
            onClick={(e) => handleItemClick(e, item.action)}
          >
            {item.label || ''}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
