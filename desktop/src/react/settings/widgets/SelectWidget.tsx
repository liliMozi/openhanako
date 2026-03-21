/**
 * SDW（轻量下拉选择组件）的 React 版本
 * 使用 position: fixed 避免被父容器 overflow 裁剪
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectWidgetProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function SelectWidget({ options, value, onChange, placeholder }: SelectWidgetProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

  const close = useCallback(() => setOpen(false), []);

  // 计算面板位置
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const openAbove = spaceBelow < 200 && spaceAbove > spaceBelow;

    setPanelStyle({
      position: 'fixed',
      left: rect.left,
      width: rect.width,
      ...(openAbove
        ? { bottom: window.innerHeight - rect.top + 2 }
        : { top: rect.bottom + 2 }),
      zIndex: 9999,
    });
  }, [open]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, close]);

  const current = options.find(o => o.value === value);
  const displayText = current?.label || placeholder || '';
  const isPlaceholder = !current;

  return (
    <div className={`sdw${open ? ' open' : ''}`}>
      <button type="button" className="sdw-trigger" ref={triggerRef} onClick={() => setOpen(!open)}>
        <span className={`sdw-value${isPlaceholder ? ' sdw-placeholder' : ''}`}>{displayText}</span>
        <span className="sdw-arrow">▾</span>
      </button>
      {open && createPortal(
        <div className="sdw-popup sdw-popup-fixed" ref={panelRef} style={panelStyle}>
          {options.map(item => (
            <button
              type="button"
              key={item.value}
              className={`sdw-option${item.value === value ? ' selected' : ''}${item.disabled ? ' disabled' : ''}`}
              onClick={() => {
                if (item.disabled) return;
                onChange(item.value);
                close();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
