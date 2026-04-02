/**
 * UserMessage — 用户消息气泡
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { AttachmentChip } from '../shared/AttachmentChip';
import { MessageActions } from './MessageActions';
const lazyScreenshot = () => import('../../utils/screenshot').then(m => m.takeScreenshot);
import type { ChatMessage, UserAttachment, DeskContext, ContentBlock } from '../../stores/chat-types';
import { useStore } from '../../stores';
import styles from './Chat.module.css';
import badgeStyles from '../input/SkillBadgeView.module.css';

interface Props {
  message: ChatMessage;
  showAvatar: boolean;
}

export const UserMessage = memo(function UserMessage({ message, showAvatar }: Props) {
  const userAvatarUrl = useStore(s => s.userAvatarUrl);
  const t = window.t ?? ((p: string) => p);
  const userName = useStore(s => s.userName) || t('common.me');
  const [avatarFailed, setAvatarFailed] = useState(false);

  const sessionPath = useStore(s => s.currentSessionPath) || '';
  const isStreaming = useStore(s => s.streamingSessions.includes(sessionPath));
  const selectedIds = useStore(s => s.selectedIdsBySession[sessionPath] || []);
  const isSelected = selectedIds.includes(message.id);

  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setAvatarFailed(false);
  }, [userAvatarUrl]);

  const handleCopy = useCallback(() => {
    const state = useStore.getState();
    const sp = state.currentSessionPath;
    if (!sp) return;
    const ids = state.selectedIdsBySession[sp] || [];

    if (ids.length > 0) {
      const session = state.chatSessions[sp];
      if (!session) return;
      const texts: string[] = [];
      for (const item of session.items) {
        if (item.type !== 'message') continue;
        if (!ids.includes(item.data.id)) continue;
        if (item.data.role === 'user') {
          texts.push(item.data.text || '');
        } else {
          const textBlocks = (item.data.blocks || []).filter(
            (b): b is ContentBlock & { type: 'text' } => b.type === 'text'
          );
          if (textBlocks.length === 0) continue;
          // eslint-disable-next-line no-restricted-syntax
          const tmp = document.createElement('div');
          tmp.innerHTML = textBlocks.map(b => b.html).join('\n');
          texts.push(tmp.innerText.trim());
        }
      }
      navigator.clipboard.writeText(texts.join('\n\n')).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }).catch(() => {});
    } else {
      const text = message.text || '';
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }).catch(() => {});
    }
  }, [message.text]);

  const handleScreenshot = useCallback(async () => {
    const fn = await lazyScreenshot();
    fn(message.id);
  }, [message.id]);

  return (
    <div className={`${styles.messageGroup} ${styles.messageGroupUser}${isSelected ? ` ${styles.messageGroupSelected}` : ''}`}
         data-message-id={message.id}>
      {showAvatar && (
        <div className={`${styles.avatarRow} ${styles.avatarRowUser}`}>
          <span className={styles.avatarName}>{userName}</span>
          {userAvatarUrl && !avatarFailed ? (
            <img
              className={styles.avatar}
              src={userAvatarUrl}
              alt={userName}
              draggable={false}
              onError={() => setAvatarFailed(true)}
              style={{ objectFit: 'cover' }}
            />
          ) : (
            <span className={`${styles.avatar} ${styles.userAvatar}`}>👧🏻</span>
          )}
        </div>
      )}
      {message.quotedText && (
        <div className={styles.userAttachments}>
          <AttachmentChip
            icon={<GridIcon />}
            name={message.quotedText}
          />
        </div>
      )}
      {message.attachments && message.attachments.length > 0 && (
        <UserAttachmentsView attachments={message.attachments} deskContext={message.deskContext} />
      )}
      <div className={`${styles.message} ${styles.messageUser}`}>
        {message.skills && message.skills.length > 0 && message.skills.map(skillName => (
          <span key={skillName} className={badgeStyles.badge} style={{ cursor: 'default' }}>
            <svg className={badgeStyles.icon} width="13" height="13" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
              <path d="M8 1 L9.5 6 L15 8 L9.5 10 L8 15 L6.5 10 L1 8 L6.5 6 Z" />
            </svg>
            <span className={badgeStyles.name}>{skillName}</span>
          </span>
        ))}
        {message.textHtml && <MarkdownContent html={message.textHtml} />}
      </div>
      <MessageActions
        messageId={message.id}
        sessionPath={sessionPath}
        onCopy={handleCopy}
        onScreenshot={handleScreenshot}
        copied={copied}
        isStreaming={isStreaming}
      />
    </div>
  );
});

// ── 附件区 ──

const UserAttachmentsView = memo(function UserAttachmentsView({ attachments, deskContext }: {
  attachments: UserAttachment[];
  deskContext?: DeskContext | null;
}) {
  const isImage = useCallback((att: UserAttachment) => {
    return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(att.name);
  }, []);

  const t = window.t ?? ((p: string) => p);

  return (
    <div className={styles.userAttachments}>
      {attachments.map((att, i) => {
        if (isImage(att) && att.base64Data) {
          return (
            <img
              key={att.name || `att-${i}`}
              className={styles.attachImage}
              src={`data:${att.mimeType || 'image/png'};base64,${att.base64Data}`}
              alt={att.name}
              loading="lazy"
            />
          );
        }
        return (
          <AttachmentChip
            key={att.name || `att-${i}`}
            icon={att.isDir ? <FolderIcon /> : <FileIcon />}
            name={att.name}
          />
        );
      })}
      {deskContext && (
        <AttachmentChip
          icon={<FolderIcon />}
          name={`${t('sidebar.jian')} (${deskContext.fileCount})`}
        />
      )}
    </div>
  );
});

// ── Icons ──

function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="4" x2="6" y2="20" />
      <line x1="18" y1="4" x2="18" y2="20" />
      <line x1="6" y1="8" x2="18" y2="8" />
      <line x1="6" y1="16" x2="18" y2="16" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
