import { memo } from 'react';
import styles from './InputArea.module.css';

interface Props {
  slashBusy: string | null;
  slashBusyLabel: string;
  compacting: boolean;
  compactingLabel: string;
  inlineError: string | null;
  slashResult: { text: string; type: 'success' | 'error'; deskDir?: string } | null;
  onResultClick: (() => void) | undefined;
}

/** 输入区域上方的状态提示条（slash 执行中 / 压缩中 / 错误 / 结果） */
export const InputStatusBars = memo(function InputStatusBars({
  slashBusy, slashBusyLabel, compacting, compactingLabel,
  inlineError, slashResult, onResultClick,
}: Props) {
  return (
    <>
      {slashBusy && (
        <div className={styles['slash-busy-bar']}>
          <span className={styles['slash-busy-dot']} />
          <span>{slashBusyLabel}</span>
        </div>
      )}
      {compacting && (
        <div className={styles['slash-busy-bar']}>
          <span className={styles['slash-busy-dot']} />
          <span>{compactingLabel}</span>
        </div>
      )}
      {inlineError && (
        <div className={styles['slash-error-bar']}>
          <span className={styles['slash-error-dot']} />
          <span>{inlineError}</span>
        </div>
      )}
      {!slashBusy && !compacting && !inlineError && slashResult && (
        <div
          className={`${styles['slash-busy-bar']}${slashResult.deskDir ? ` ${styles['slash-busy-bar-clickable']}` : ''}`}
          onClick={onResultClick}
          role={slashResult.deskDir ? 'button' : undefined}
        >
          <span className={styles[slashResult.type === 'success' ? 'slash-result-dot-ok' : 'slash-result-dot-err']} />
          <span>{slashResult.text}</span>
        </div>
      )}
    </>
  );
});
