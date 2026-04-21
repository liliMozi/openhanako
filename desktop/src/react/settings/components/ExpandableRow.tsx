import React, { useState } from 'react';
import styles from './settings-components.module.css';

interface ExpandableRowProps {
  label: React.ReactNode;
  count?: number;
  defaultExpanded?: boolean;
  onToggle?: (expanded: boolean) => void;
  children: React.ReactNode;
}

export function ExpandableRow({
  label,
  count,
  defaultExpanded = false,
  onToggle,
  children,
}: ExpandableRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    onToggle?.(next);
  };

  return (
    <div className={styles.expandable}>
      <button
        type="button"
        className={styles.expandableHeader}
        onClick={toggle}
        aria-expanded={expanded}
      >
        <span className={styles.expandableChevron} data-expanded={expanded}>
          ›
        </span>
        <span>{label}</span>
        {count !== undefined && (
          <span className={styles.expandableCount}>（{count}）</span>
        )}
      </button>
      {expanded && <div className={styles.expandableBody}>{children}</div>}
    </div>
  );
}
