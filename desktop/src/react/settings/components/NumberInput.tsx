import React from 'react';
import styles from './settings-components.module.css';

interface NumberInputProps {
  value: number;
  onChange: (value: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  disabled?: boolean;
}

export function NumberInput({
  value,
  onChange,
  unit,
  min,
  max,
  disabled,
}: NumberInputProps) {
  return (
    <div className={styles.numberInput}>
      <input
        type="number"
        className={styles.numberInputField}
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
      />
      {unit && <span className={styles.numberInputUnit}>{unit}</span>}
    </div>
  );
}
