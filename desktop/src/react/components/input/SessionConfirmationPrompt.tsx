import { useCallback, useState } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import type { SessionConfirmationBlock } from '../../stores/chat-types';
import styles from './InputArea.module.css';

interface SessionConfirmationPromptProps {
  block: SessionConfirmationBlock;
  exiting?: boolean;
}

export function SessionConfirmationPrompt({ block, exiting = false }: SessionConfirmationPromptProps) {
  const [submitting, setSubmitting] = useState<'confirmed' | 'rejected' | null>(null);
  const pending = block.status === 'pending' && !exiting;
  const confirmLabel = block.actions?.confirmLabel || window.t?.('common.approve') || '同意';
  const rejectLabel = block.actions?.rejectLabel || window.t?.('common.reject') || '拒绝';

  const submit = useCallback(async (action: 'confirmed' | 'rejected') => {
    if (!pending || submitting) return;
    setSubmitting(action);
    try {
      await hanaFetch(`/api/confirm/${block.confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
    } catch (err) {
      setSubmitting(null);
      console.warn('[session-confirmation] submit failed', err);
    }
  }, [block.confirmId, pending, submitting]);

  return (
    <div
      className={`${styles['session-confirmation-prompt']} ${exiting ? styles['session-confirmation-prompt-exiting'] : ''}`}
      data-confirm-id={block.confirmId}
      data-status={block.status}
      data-severity={block.severity || 'normal'}
    >
      <div className={styles['session-confirmation-body']}>
        <div className={styles['session-confirmation-kicker']}>
          {block.kind === 'computer_app_approval' ? 'Computer Use' : '确认'}
        </div>
        <div className={styles['session-confirmation-title']}>{block.title}</div>
        {block.body && <div className={styles['session-confirmation-text']}>{block.body}</div>}
        {block.subject && (
          <div className={styles['session-confirmation-subject']}>
            <span className={styles['session-confirmation-subject-label']}>{block.subject.label}</span>
            {block.subject.detail && <span className={styles['session-confirmation-subject-detail']}>{block.subject.detail}</span>}
          </div>
        )}
      </div>
      {pending ? (
        <div className={styles['session-confirmation-actions']}>
          <button
            type="button"
            className={`${styles['session-confirmation-button']} ${styles['session-confirmation-button-reject']}`}
            onClick={() => submit('rejected')}
            disabled={!!submitting}
          >
            {rejectLabel}
          </button>
          <button
            type="button"
            className={`${styles['session-confirmation-button']} ${styles['session-confirmation-button-confirm']}`}
            onClick={() => submit('confirmed')}
            disabled={!!submitting}
          >
            {confirmLabel}
          </button>
        </div>
      ) : (
        <div className={styles['session-confirmation-resolved']}>
          {block.status === 'confirmed'
            ? (window.t?.('common.approved') || '已同意')
            : (window.t?.('common.rejected') || '已拒绝')}
        </div>
      )}
    </div>
  );
}
