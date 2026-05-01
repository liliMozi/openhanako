import { useCallback, useState } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import type { SessionConfirmationBlock } from '../../stores/chat-types';
import styles from './InputArea.module.css';

type ConfirmationAction = 'confirmed' | 'rejected';

interface SessionConfirmationPromptProps {
  block: SessionConfirmationBlock;
  exiting?: boolean;
}

function displayTitle(block: SessionConfirmationBlock) {
  if (block.kind === 'computer_app_approval') {
    const appName = block.subject?.label || '这个应用';
    return `是否允许 Hana 控制 ${appName}`;
  }
  return block.title;
}

function displaySubject(block: SessionConfirmationBlock) {
  if (block.kind === 'computer_app_approval') {
    return {
      label: 'computer app',
      detail: block.subject?.detail || block.subject?.label || '',
    };
  }
  if (block.subject?.label || block.subject?.detail) {
    return {
      label: block.subject?.label || '',
      detail: block.subject?.detail || '',
    };
  }
  return {
    label: block.body || '',
    detail: '',
  };
}

export function SessionConfirmationPrompt({ block, exiting = false }: SessionConfirmationPromptProps) {
  const [submission, setSubmission] = useState<{ confirmId: string; action: ConfirmationAction } | null>(null);
  const pending = block.status === 'pending' && !exiting;
  const submitting = submission?.confirmId === block.confirmId ? submission.action : null;
  const confirmLabel = block.actions?.confirmLabel || window.t?.('common.approve') || '同意';
  const rejectLabel = block.actions?.rejectLabel || window.t?.('common.reject') || '拒绝';
  const title = displayTitle(block);
  const subject = displaySubject(block);
  const hasSubject = !!(subject.label || subject.detail);

  const submit = useCallback(async (action: ConfirmationAction) => {
    if (!pending || submitting) return;
    setSubmission({ confirmId: block.confirmId, action });
    try {
      await hanaFetch(`/api/confirm/${block.confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
    } catch (err) {
      setSubmission((current) => (
        current?.confirmId === block.confirmId ? null : current
      ));
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
        <div className={styles['session-confirmation-title']}>{title}</div>
        {hasSubject && (
          <div className={styles['session-confirmation-subject']}>
            {subject.label && <span className={styles['session-confirmation-subject-label']}>{subject.label}</span>}
            {subject.detail && <span className={styles['session-confirmation-subject-detail']}>{subject.detail}</span>}
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
