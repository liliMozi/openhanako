/**
 * SDW（轻量下拉选择组件）的 React 版本
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';

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
  const ref = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [open, close]);

  const current = options.find(o => o.value === value);
  const displayText = current?.label || placeholder || '';
  const isPlaceholder = !current;

  return (
    <div className={`sdw${open ? ' open' : ''}`} ref={ref}>
      <button type="button" className="sdw-trigger" onClick={() => setOpen(!open)}>
        <span className={`sdw-value${isPlaceholder ? ' sdw-placeholder' : ''}`}>{displayText}</span>
        <span className="sdw-arrow">▾</span>
      </button>
      <div className="sdw-popup">
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
      </div>
    </div>
  );
}
