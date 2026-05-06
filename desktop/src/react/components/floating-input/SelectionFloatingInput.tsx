import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import type { QuotedSelection } from '../../stores/input-slice';
import { sendFloatingSelectionPrompt } from '../../stores/floating-selection-actions';
import { useI18n } from '../../hooks/use-i18n';
import { FloatingInput } from './FloatingInput';

export const SELECTION_OPEN_DELAY_MS = 500;

export function SelectionFloatingInput() {
  const { t } = useI18n();
  const quotedSelection = useStore(s => s.quotedSelection);
  const connected = useStore(s => s.connected);
  const modelSwitching = useStore(s => s.modelSwitching);
  const isStreaming = useStore(s => s.streamingSessions.includes(s.currentSessionPath || ''));
  const clearQuotedSelection = useStore(s => s.clearQuotedSelection);
  const [activeSelection, setActiveSelection] = useState<QuotedSelection | null>(null);
  const [value, setValue] = useState('');
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    setActiveSelection(null);
    setValue('');

    if (!quotedSelection?.anchorRect) return;
    timerRef.current = window.setTimeout(() => {
      setActiveSelection(quotedSelection);
      timerRef.current = null;
    }, SELECTION_OPEN_DELAY_MS);

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [quotedSelection]);

  const handleClose = useCallback(() => {
    setActiveSelection(null);
    setValue('');
    clearQuotedSelection();
  }, [clearQuotedSelection]);

  const handleSubmit = useCallback(async (text: string) => {
    if (!activeSelection) return;
    const sent = await sendFloatingSelectionPrompt(text, activeSelection);
    if (!sent) return;
    setActiveSelection(null);
    setValue('');
    clearQuotedSelection();
  }, [activeSelection, clearQuotedSelection]);

  const disabled = !connected || isStreaming || modelSwitching;

  return (
    <FloatingInput
      open={!!activeSelection}
      anchorRect={activeSelection?.anchorRect}
      value={value}
      onChange={setValue}
      onSubmit={handleSubmit}
      onClose={handleClose}
      disabled={disabled}
      ariaLabel={t('input.floatingInput')}
      submitLabel={t('chat.send')}
    />
  );
}
