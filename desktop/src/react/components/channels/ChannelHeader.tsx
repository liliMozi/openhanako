/**
 * ChannelHeader — 频道头部（名称、成员数、操作按钮）
 */

import { useCallback, useState } from 'react';
import { useStore } from '../../stores';
import { useI18n } from '../../hooks/use-i18n';
import { toggleJianSidebar } from '../../stores/desk-actions';
import { deleteChannel } from '../../stores/channel-actions';
import { ContextMenu } from '../ContextMenu';
import type { ContextMenuItem } from '../ContextMenu';
import styles from './Channels.module.css';

function confirmDeleteChannel(channelId: string) {
  const ch = useStore.getState().channels.find((c) => c.id === channelId);
  const displayName = ch?.name || channelId;
  const msg = window.t('channel.deleteConfirm', { name: displayName }) || '';
  if (!confirm(msg)) return;
  deleteChannel(channelId);
}

export function ChannelHeader() {
  const { t } = useI18n();
  const headerName = useStore(s => s.channelHeaderName);
  const headerMembers = useStore(s => s.channelHeaderMembersText);
  const currentChannel = useStore(s => s.currentChannel);
  const isDM = useStore(s => s.channelIsDM);

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [menuItems, setMenuItems] = useState<ContextMenuItem[]>([]);

  const handleInfoToggle = useCallback(() => {
    toggleJianSidebar();
  }, []);

  const handleMenu = useCallback((e: React.MouseEvent) => {
    if (!currentChannel) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuItems([
      {
        label: t('channel.deleteChannel'),
        danger: true,
        action: () => confirmDeleteChannel(currentChannel),
      },
    ]);
    setMenuPos({ x: rect.left, y: rect.bottom + 4 });
  }, [currentChannel, t]);

  const handleCloseMenu = useCallback(() => {
    setMenuPos(null);
  }, []);

  return (
    <div className={styles.channelHeader}>
      <div className={styles.channelHeaderInfo}>
        <span className={styles.channelHeaderName}>{headerName}</span>
        <span className={styles.channelHeaderMembers}>{headerMembers}</span>
      </div>
      <div className={styles.channelHeaderActions}>
        {currentChannel && (
          <button
            className={styles.channelHeaderActionBtn}
            title={t('channel.info')}
            onClick={handleInfoToggle}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
          </button>
        )}
        {currentChannel && !isDM && (
          <button
            className={styles.channelHeaderActionBtn}
            title={t('common.more')}
            onClick={handleMenu}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="5" r="1"></circle>
              <circle cx="12" cy="12" r="1"></circle>
              <circle cx="12" cy="19" r="1"></circle>
            </svg>
          </button>
        )}
      </div>
      {menuPos && (
        <ContextMenu items={menuItems} position={menuPos} onClose={handleCloseMenu} />
      )}
    </div>
  );
}
