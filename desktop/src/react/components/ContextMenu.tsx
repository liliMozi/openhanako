/**
 * ContextMenu — 通用右键菜单（React portal）
 *
 * 替代 desk-shim.ts 的 DOM 命令式菜单。
 * 使用已有 CSS classes: .context-menu, .context-menu-item, .context-menu-divider
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label?: string;
  action?: () => void;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  children?: ContextMenuItem[];
}

export interface ContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [openSubmenuIndex, setOpenSubmenuIndex] = useState<number | null>(null);
  const [submenuSide, setSubmenuSide] = useState<'left' | 'right'>('right');

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
    setSubmenuSide(x + rect.width + 220 > window.innerWidth ? 'left' : 'right');
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
        const hasSubmenu = !!item.children?.length;
        const submenuOpen = openSubmenuIndex === i && hasSubmenu;
        return (
          <div
            key={`${item.label || 'item'}-${i}`}
            className={`context-menu-item${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}${hasSubmenu ? ' has-submenu' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => {
              if (hasSubmenu && !item.disabled) setOpenSubmenuIndex(i);
              else setOpenSubmenuIndex(null);
            }}
            onClick={(e) => {
              if (item.disabled) {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              if (hasSubmenu) {
                e.preventDefault();
                e.stopPropagation();
                setOpenSubmenuIndex(i);
                return;
              }
              handleItemClick(e, item.action);
            }}
          >
            <span className="context-menu-label">{item.label || ''}</span>
            {submenuOpen && (
              <div className={`context-menu-submenu ${submenuSide}`}>
                {item.children?.map((child, childIndex) => {
                  if (child.divider) {
                    return <div key={`child-divider-${childIndex}`} className="context-menu-divider" />;
                  }
                  return (
                    <div
                      key={`${child.label || 'child'}-${childIndex}`}
                      className={`context-menu-item${child.danger ? ' danger' : ''}${child.disabled ? ' disabled' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        if (child.disabled) {
                          e.preventDefault();
                          e.stopPropagation();
                          return;
                        }
                        handleItemClick(e, child.action);
                      }}
                    >
                      <span className="context-menu-label">{child.label || ''}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
