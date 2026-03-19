/**
 * UserMessage — 用户消息气泡
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';
import type { ChatMessage, UserAttachment, DeskContext } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { hanaUrl } from '../../hooks/use-hana-fetch';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Props {
  message: ChatMessage;
  showAvatar: boolean;
}

export const UserMessage = memo(function UserMessage({ message, showAvatar }: Props) {
  const userAvatarUrl = useStore(s => s.userAvatarUrl);
  const userName = useStore(s => s.userName) || '我';
  const [avatarFailed, setAvatarFailed] = useState(false);

  useEffect(() => {
    setAvatarFailed(false);
  }, [userAvatarUrl]);

  return (
    <div className="message-group user">
      {showAvatar && (
        <div className="avatar-row user">
          <span className="avatar-name">{userName}</span>
          {userAvatarUrl && !avatarFailed ? (
            <img
              className="avatar user-avatar-img"
              src={userAvatarUrl}
              alt={userName}
              draggable={false}
              onError={() => setAvatarFailed(true)}
            />
          ) : (
            <span className="avatar user-avatar">👧🏻</span>
          )}
        </div>
      )}
      {message.attachments && message.attachments.length > 0 && (
        <UserAttachmentsView attachments={message.attachments} deskContext={message.deskContext} />
      )}
      <div className="message user">
        {message.textHtml && <MarkdownContent html={message.textHtml} />}
      </div>
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

  return (
    <div className="user-attachments">
      {attachments.map((att, i) => {
        if (isImage(att) && att.base64Data) {
          return (
            <img
              key={i}
              className="attach-image"
              src={`data:${att.mimeType || 'image/png'};base64,${att.base64Data}`}
              alt={att.name}
              loading="lazy"
            />
          );
        }
        if (isImage(att)) {
          return (
            <img
              key={i}
              className="attach-image"
              src={hanaUrl(`/api/desk/file?path=${encodeURIComponent(att.path)}`)}
              alt={att.name}
              loading="lazy"
            />
          );
        }
        const ext = att.name.split('.').pop() || '';
        return (
          <div key={i} className="attach-file">
            <span className="attach-file-icon">
              {att.isDir ? (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              ) : (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              )}
            </span>
            <span className="attach-file-name">{att.name}</span>
            {ext && <span className="attach-file-ext">{ext}</span>}
          </div>
        );
      })}
      {deskContext && (
        <div className="attach-file attach-desk">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span className="attach-file-name">书桌 ({deskContext.fileCount})</span>
        </div>
      )}
    </div>
  );
});
