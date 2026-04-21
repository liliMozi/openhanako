/**
 * ChannelList — 频道列表渲染（DM + Group 分区）
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { useI18n } from '../../hooks/use-i18n';
import { hanaFetch, hanaUrl } from '../../hooks/use-hana-fetch';
import {
  loadChannels,
  openChannel,
  deleteChannel,
  toggleChannelsEnabled,
} from '../../stores/channel-actions';
import { toggleSidebar } from '../SidebarLayout';
import { ContextMenu } from '../ContextMenu';
import { ChannelWarningModal } from './ChannelWarningModal';
import type { ContextMenuItem } from '../ContextMenu';
import type { Channel, Agent } from '../../types';
import { yuanFallbackAvatar } from '../../utils/agent-helpers';
import styles from './Channels.module.css';


// ── 稳定头像时间戳（避免每次渲染生成新 URL） ──
let _avatarTs = Date.now();
export function refreshAvatarTs() { _avatarTs = Date.now(); }

// ── 辅助类型 ──

export interface MemberInfo {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  fallbackAvatar: string | null;
  yuan?: string;
  isUser: boolean;
}

// ── 辅助函数 ──

/** 构建 agent 查找 Map（按 id 和 name 双索引），配合 useMemo 使用 */
export function buildAgentMap(agents: Agent[]): Map<string, Agent> {
  const m = new Map<string, Agent>();
  for (const a of agents) {
    m.set(a.id, a);
    if (a.name) m.set(a.name, a);
  }
  return m;
}

export function resolveChannelMember(
  memberId: string,
  userName: string,
  userAvatarUrl: string | null,
  agents: Agent[],
  currentAgentId: string | null,
  agentMap?: Map<string, Agent>,
): MemberInfo {
  if (memberId === 'user' || memberId === userName) {
    return {
      id: memberId,
      displayName: userName || 'user',
      avatarUrl: userAvatarUrl,
      fallbackAvatar: null,
      isUser: true,
    };
  }
  const agent = agentMap ? agentMap.get(memberId) : agents.find((a) => a.id === memberId || a.name === memberId);
  if (agent) {
    return {
      id: memberId,
      displayName: agent.name || agent.id,
      avatarUrl: agent.hasAvatar ? hanaUrl(`/api/agents/${agent.id}/avatar?t=${_avatarTs}`) : null,
      fallbackAvatar: yuanFallbackAvatar(agent.yuan),
      yuan: agent.yuan,
      isUser: false,
    };
  }
  return {
    id: memberId,
    displayName: memberId,
    avatarUrl: null,
    fallbackAvatar: null,
    isUser: false,
  };
}

export function formatChannelTime(timestamp: string): string {
  if (!timestamp) return '';
  const parts = timestamp.split(' ');
  if (parts.length < 2) return timestamp;

  const today = new Date();
  const [y, mo, d] = parts[0].split('-').map(Number);
  const t = window.t;

  if (y === today.getFullYear() && mo === today.getMonth() + 1 && d === today.getDate()) {
    return parts[1];
  }
  if (y === today.getFullYear() && mo === today.getMonth() + 1 && d === today.getDate() - 1) {
    return t('time.yesterday');
  }
  return `${mo}/${d}`;
}

// ── MemberAvatar ──

export function MemberAvatar({ info, className }: { info: MemberInfo; className?: string }) {
  const [imgError, setImgError] = useState(false);

  if (info.avatarUrl && !imgError) {
    return (
      <img
        className={className}
        src={info.avatarUrl}
        onError={() => setImgError(true)}
      />
    );
  }
  if (imgError && info.fallbackAvatar) {
    return <img className={className} src={info.fallbackAvatar} />;
  }
  return <>{(info.displayName || '?').charAt(0).toUpperCase()}</>;
}

// ══════════════════════════════════════════════════════
// ChannelListSidebar — 左侧边栏中的频道列表区块
// ══════════════════════════════════════════════════════

export function ChannelListSidebar() {
  const { t } = useI18n();
  const channelsEnabled = useStore(s => s.channelsEnabled);
  const setChannelCreateOverlayVisible = useStore(s => s.setChannelCreateOverlayVisible);
  const [warningOpen, setWarningOpen] = useState(false);

  const handleToggle = useCallback(() => {
    const turningOn = !useStore.getState().channelsEnabled;
    if (turningOn) {
      setWarningOpen(true);
      return;
    }
    toggleChannelsEnabled();
  }, []);

  const handleWarningConfirm = useCallback(() => {
    setWarningOpen(false);
    toggleChannelsEnabled();
  }, []);

  const handleWarningCancel = useCallback(() => {
    setWarningOpen(false);
  }, []);

  const handleCreate = useCallback(() => {
    setChannelCreateOverlayVisible(true);
  }, [setChannelCreateOverlayVisible]);

  const handleCollapse = useCallback(() => {
    toggleSidebar();
  }, []);

  return (
    <>
      <div className="sidebar-header">
        <span className="sidebar-title">{t('channel.tab')} <span className="beta-badge">Beta</span></span>
        <div className="sidebar-header-actions">
          <button
            className={`sidebar-action-btn${!channelsEnabled ? ` ${styles.btnDisabled}` : ''}`}
            title={t('channel.createTitle')}
            disabled={!channelsEnabled}
            onClick={handleCreate}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
          <button className="sidebar-action-btn" title="" onClick={handleCollapse}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 6 9 12 15 18"></polyline>
            </svg>
          </button>
        </div>
      </div>
      <div className={styles.channelListWrap}>
        <div className={styles.channelList}>
          <ChannelList />
        </div>
        <div className={`${styles.channelDisabledOverlay}${channelsEnabled ? ` ${styles.channelDisabledOverlayHidden}` : ''}`}>
          <span>{t('channel.disabled')}</span>
        </div>
        <div className={styles.channelToggleBar}>
          <span className={styles.channelToggleBarLabel}>{t('channel.toggleLabel')}</span>
          <button
            className={`hana-toggle${channelsEnabled ? ' on' : ''}`}
            onClick={handleToggle}
          ></button>
        </div>
      </div>
      <ChannelWarningModal
        open={warningOpen}
        onConfirm={handleWarningConfirm}
        onCancel={handleWarningCancel}
      />
    </>
  );
}

// ══════════════════════════════════════════════════════
// ChannelList — 频道列表
// ══════════════════════════════════════════════════════

export function ChannelList() {
  const { t } = useI18n();
  const channels = useStore((s) => s.channels);
  const currentChannel = useStore((s) => s.currentChannel);
  const agents = useStore((s) => s.agents);
  const userName = useStore((s) => s.userName);
  const userAvatarUrl = useStore((s) => s.userAvatarUrl);
  const currentAgentId = useStore((s) => s.currentAgentId);

  const agentMap = useMemo(() => buildAgentMap(agents), [agents]);

  if (channels.length === 0) {
    return <div className="session-empty">{t('channel.empty')}</div>;
  }

  const dms = channels.filter((ch) => ch.isDM === true);
  const groups = channels.filter((ch) => !ch.isDM);

  return (
    <>
      {dms.length > 0 && (
        <>
          <div className={styles.channelSectionLabel}>
            <span>{t('channel.dmLabel')}</span>
            <span className={styles.channelSectionHint}>{t('channel.dmHint')}</span>
          </div>
          {dms.map((ch) => (
            <ChannelItem
              key={ch.id}
              channel={ch}
              isDM
              isActive={ch.id === currentChannel}
              agents={agents}
              agentMap={agentMap}
              userName={userName}
              userAvatarUrl={userAvatarUrl}
              currentAgentId={currentAgentId}
              onOpen={openChannel}
            />
          ))}
        </>
      )}
      {groups.length > 0 && (
        <>
          <div className={styles.channelSectionLabel}>{t('channel.groupLabel')}</div>
          {groups.map((ch) => (
            <ChannelItem
              key={ch.id}
              channel={ch}
              isDM={false}
              isActive={ch.id === currentChannel}
              agents={agents}
              agentMap={agentMap}
              userName={userName}
              userAvatarUrl={userAvatarUrl}
              currentAgentId={currentAgentId}
              onOpen={openChannel}
            />
          ))}
        </>
      )}
    </>
  );
}

// ── ChannelItem ──

interface ChannelItemProps {
  channel: Channel;
  isDM: boolean;
  isActive: boolean;
  agents: Agent[];
  agentMap: Map<string, Agent>;
  userName: string;
  userAvatarUrl: string | null;
  currentAgentId: string | null;
  onOpen: (id: string, isDM?: boolean) => void;
}

function confirmDeleteChannel(channelId: string) {
  const ch = useStore.getState().channels.find((c) => c.id === channelId);
  const displayName = ch?.name || channelId;
  const msg = (window.t('channel.deleteConfirm', { name: displayName }) || '');
  if (!confirm(msg)) return;
  deleteChannel(channelId);
}

function ChannelItem({ channel, isDM, isActive, agents, agentMap, userName, userAvatarUrl, currentAgentId, onOpen }: ChannelItemProps) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const handleClick = useCallback(() => {
    onOpen(channel.id, channel.isDM);
  }, [onOpen, channel.id, channel.isDM]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (isDM) return;
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, [isDM]);

  const handleCloseCtxMenu = useCallback(() => {
    setCtxMenu(null);
  }, []);

  const selfInfo = resolveChannelMember(currentAgentId || '', userName, userAvatarUrl, agents, currentAgentId, agentMap);

  const ctxMenuItems: ContextMenuItem[] = ctxMenu ? [
    {
      label: window.t('channel.deleteChannel'),
      danger: true,
      action: () => confirmDeleteChannel(channel.id),
    },
  ] : [];

  return (
    <div
      className={`${styles.channelItem}${isActive ? ` ${styles.channelItemActive}` : ''}`}
      data-channel={channel.id}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {isDM ? (
        <DmIcon channel={channel} selfInfo={selfInfo} agents={agents} agentMap={agentMap} userName={userName} userAvatarUrl={userAvatarUrl} currentAgentId={currentAgentId} />
      ) : (
        <div className={styles.channelItemIcon}>#</div>
      )}
      <div className={styles.channelItemBody}>
        <div className={styles.channelItemName}>
          {isDM
            ? `${selfInfo.displayName} \u00B7 ${channel.peerName || channel.name}`
            : (channel.name || channel.id)
          }
        </div>
        <div className={styles.channelItemPreview}>
          {channel.lastMessage && (() => {
            const senderInfo = resolveChannelMember(channel.lastSender, userName, userAvatarUrl, agents, currentAgentId, agentMap);
            return `${senderInfo.displayName}: ${channel.lastMessage}`;
          })()}
        </div>
      </div>
      <div className={styles.channelItemMeta}>
        {channel.lastTimestamp && (
          <div className={styles.channelItemTime}>{formatChannelTime(channel.lastTimestamp)}</div>
        )}
        {(channel.newMessageCount || 0) > 0 && (
          <div className={styles.channelUnreadBadge}>
            {channel.newMessageCount! > 99 ? '99+' : String(channel.newMessageCount)}
          </div>
        )}
      </div>
      {ctxMenu && (
        <ContextMenu items={ctxMenuItems} position={ctxMenu} onClose={handleCloseCtxMenu} />
      )}
    </div>
  );
}

// ── DM Icon (dual avatar) ──

function DmIcon({ channel, selfInfo, agents, agentMap, userName, userAvatarUrl, currentAgentId }: {
  channel: Channel;
  selfInfo: MemberInfo;
  agents: Agent[];
  agentMap: Map<string, Agent>;
  userName: string;
  userAvatarUrl: string | null;
  currentAgentId: string | null;
}) {
  const peerId = channel.peerId || channel.members?.[0] || '';
  const peerInfo = resolveChannelMember(peerId, userName, userAvatarUrl, agents, currentAgentId, agentMap);

  return (
    <div className={styles.channelDmIcon}>
      <div className={styles.channelDmAvatar}>
        <MemberAvatar info={selfInfo} />
      </div>
      <div className={styles.channelDmLink}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      </div>
      <div className={styles.channelDmAvatar}>
        <MemberAvatar info={peerInfo} />
      </div>
    </div>
  );
}
