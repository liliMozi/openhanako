import { memo, type RefObject } from 'react';
import { PlanModeButton } from './PlanModeButton';
import { DocContextButton } from './DocContextButton';
import { ContextRing } from './ContextRing';
import { ThinkingLevelButton } from './ThinkingLevelButton';
import { ModelSelector } from './ModelSelector';
import { SendButton } from './SendButton';
import type { ThinkingLevel } from '../../stores/model-slice';
import type { Model } from '../../types';
import type { SessionModel } from '../../stores/chat-types';
import styles from './InputArea.module.css';

interface Props {
  t: (key: string) => string;
  // 左侧工具按钮
  onAttach: () => void;
  slashBtnRef: RefObject<HTMLButtonElement | null>;
  onSlashToggle: () => void;
  planMode: boolean;
  onTogglePlanMode: (v: boolean) => void;
  hasDoc: boolean;
  docContextAttached: boolean;
  onToggleDocContext: () => void;
  // 右侧控制
  showThinking: boolean;
  thinkingLevel: ThinkingLevel;
  onThinkingChange: (level: ThinkingLevel) => void;
  modelXhigh: boolean;
  models: Model[];
  sessionModel?: SessionModel;
  isStreaming: boolean;
  hasInput: boolean;
  canSend: boolean;
  onSend: () => void;
  onSteer: () => void;
  onStop: () => void;
}

/** 编辑器下方的工具按钮行 + 发送控制 */
export const InputControlBar = memo(function InputControlBar(props: Props) {
  const {
    t, onAttach, slashBtnRef, onSlashToggle,
    planMode, onTogglePlanMode, hasDoc, docContextAttached, onToggleDocContext,
    showThinking, thinkingLevel, onThinkingChange, modelXhigh,
    models, sessionModel, isStreaming, hasInput, canSend, onSend, onSteer, onStop,
  } = props;

  return (
    <div className={styles['input-bottom-bar']}>
      <div className={styles['input-actions']}>
        <button
          className={styles['attach-btn']}
          title={t('input.attachFiles')}
          onClick={onAttach}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button
          ref={slashBtnRef}
          className={styles['attach-btn']}
          title={t('input.commandMenu')}
          onClick={onSlashToggle}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L14 10L22 12L14 14L12 22L10 14L2 12L10 10Z" />
          </svg>
        </button>
        <PlanModeButton enabled={planMode} onToggle={onTogglePlanMode} />
        {hasDoc && <DocContextButton active={docContextAttached} disabled={false} onToggle={onToggleDocContext} />}
        <ContextRing />
      </div>
      <div className={styles['input-controls']}>
        {showThinking && (
          <ThinkingLevelButton level={thinkingLevel} onChange={onThinkingChange} modelXhigh={modelXhigh} />
        )}
        <ModelSelector models={models} sessionModel={sessionModel} />
        <SendButton isStreaming={isStreaming} hasInput={hasInput}
          disabled={isStreaming ? false : !canSend} onSend={onSend} onSteer={onSteer} onStop={onStop} />
      </div>
    </div>
  );
});
