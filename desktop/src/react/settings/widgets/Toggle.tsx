/**
 * .hana-toggle 复用：方角滑块，on class 表示开启
 */
import React from 'react';

interface ToggleProps {
  on: boolean;
  onChange: (on: boolean) => void;
  label?: string;
}

export function Toggle({ on, onChange, label }: ToggleProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        className={`hana-toggle${on ? ' on' : ''}`}
        type="button"
        onClick={() => onChange(!on)}
      />
      {label && <span className="hana-toggle-label">{label}</span>}
    </div>
  );
}
