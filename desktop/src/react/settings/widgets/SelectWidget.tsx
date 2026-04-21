/**
 * SDW（轻量下拉选择组件）的 React 版本
 * 使用 position: fixed 避免被父容器 overflow 裁剪
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import styles from '../Settings.module.css';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
}

interface SelectWidgetProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  renderTrigger?: (option: SelectOption | undefined, isOpen: boolean) => React.ReactNode;
  renderOption?: (option: SelectOption, isSelected: boolean) => React.ReactNode;
}

export function SelectWidget({ options, value, onChange, placeholder, disabled, renderTrigger, renderOption }: SelectWidgetProps) {
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

  // 滚动时关闭（避免 fixed 面板脱轨），但排除下拉面板自身的滚动
  useEffect(() => {
    if (!open) return;
    const handler = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      close();
    };
    window.addEventListener('scroll', handler, true);
    return () => window.removeEventListener('scroll', handler, true);
  }, [open, close]);

  const current = options.find(o => o.value === value);
  const displayText = current?.label || placeholder || '';
  const isPlaceholder = !current;

  return (
    <div className={`${styles['sdw']}${open  ? ' ' + styles['open'] : ''}`}>
      <button type="button" className={styles['sdw-trigger']} ref={triggerRef}
        onClick={() => !disabled && setOpen(!open)} disabled={disabled}>
        {renderTrigger ? renderTrigger(current, open) : (
          <>
            <span className={`${styles['sdw-value']}${isPlaceholder ? ' ' + styles['sdw-placeholder'] : ''}`}>{displayText}</span>
            <span className={styles['sdw-arrow']}>▾</span>
          </>
        )}
      </button>
      {open && createPortal(
        <div className={`${styles['sdw-popup']} ${styles['sdw-popup-fixed']}`} ref={panelRef} style={panelStyle} data-sdw-popup>
          {(() => {
            const hasGroups = options.some(o => o.group);
            if (!hasGroups) {
              return options.map(item => (
                <button type="button" key={item.value}
                  className={`${styles['sdw-option']}${item.value === value ? ' ' + styles['selected'] : ''}${item.disabled ? ' ' + styles['disabled'] : ''}`}
                  onClick={() => { if (!item.disabled) { onChange(item.value); close(); } }}>
                  {renderOption ? renderOption(item, item.value === value) : item.label}
                </button>
              ));
            }
            const groups: Record<string, SelectOption[]> = {};
            for (const o of options) {
              const g = o.group || '';
              if (!groups[g]) groups[g] = [];
              groups[g].push(o);
            }
            return Object.entries(groups).map(([group, items]) => (
              <div key={group || '__none'}>
                {group && <div className={styles['sdw-group-header']}>{group}</div>}
                {items.map(item => (
                  <button type="button" key={`${group}/${item.value}`}
                    className={`${styles['sdw-option']}${item.value === value ? ' ' + styles['selected'] : ''}${item.disabled ? ' ' + styles['disabled'] : ''}`}
                    onClick={() => { if (!item.disabled) { onChange(item.value); close(); } }}>
                    {renderOption ? renderOption(item, item.value === value) : item.label}
                  </button>
                ))}
              </div>
            ));
          })()}
        </div>,
        document.body
      )}
    </div>
  );
}
