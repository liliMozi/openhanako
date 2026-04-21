/**
 * AttachmentChip — 统一的附件/引用胶囊组件
 *
 * 用于输入区文件标签、输入区引用标签、聊天区文件附件、聊天区引用文本。
 */

import { memo, type ReactNode } from 'react';
import styles from './AttachmentChip.module.css';

interface AttachmentChipProps {
  icon: ReactNode;
  name: string;
  onRemove?: () => void;
  className?: string;
}

export const AttachmentChip = memo(function AttachmentChip({
  icon,
  name,
  onRemove,
  className,
}: AttachmentChipProps) {
  return (
    <span className={`${styles.chip}${className ? ` ${className}` : ''}`}>
      <span className={styles.name}>
        <span className={styles.icon}>{icon}</span>
        {name}
      </span>
      {onRemove && (
        <button className={styles.remove} onClick={onRemove}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </span>
  );
});
