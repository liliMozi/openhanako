import { memo } from 'react';
import type { ChatListItem } from '../../stores/chat-types';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';

interface Props {
  items: ChatListItem[];
  sessionPath: string;
  agentId?: string | null;
  readOnly?: boolean;
  hideUserIdentity?: boolean;
}

export const ChatTranscript = memo(function ChatTranscript({
  items,
  sessionPath,
  agentId,
  readOnly = false,
  hideUserIdentity = false,
}: Props) {
  return (
    <>
      {items.map((item, index) => (
        <TranscriptItemView
          key={item.type === 'message' ? item.data.id : `c-${index}`}
          item={item}
          prevItem={index > 0 ? items[index - 1] : undefined}
          sessionPath={sessionPath}
          agentId={agentId}
          readOnly={readOnly}
          hideUserIdentity={hideUserIdentity}
        />
      ))}
    </>
  );
});

const TranscriptItemView = memo(function TranscriptItemView({
  item,
  prevItem,
  sessionPath,
  agentId,
  readOnly,
  hideUserIdentity,
}: {
  item: ChatListItem;
  prevItem?: ChatListItem;
  sessionPath: string;
  agentId?: string | null;
  readOnly: boolean;
  hideUserIdentity: boolean;
}) {
  if (item.type === 'compaction') return null;

  const msg = item.data;
  const prevRole = prevItem?.type === 'message' ? prevItem.data.role : null;
  const showAvatar = msg.role !== prevRole;

  if (msg.role === 'user') {
    return (
      <UserMessage
        message={msg}
        showAvatar={showAvatar}
        sessionPath={sessionPath}
        readOnly={readOnly}
        hideIdentity={hideUserIdentity}
      />
    );
  }

  return (
    <AssistantMessage
      message={msg}
      showAvatar={showAvatar}
      sessionPath={sessionPath}
      agentId={agentId}
      readOnly={readOnly}
    />
  );
});
