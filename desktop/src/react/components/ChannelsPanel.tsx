/**
 * ChannelsPanel — 频道系统 React 组件
 *
 * Phase 3 迁移：替代 channels-shim.ts (1159 行)。
 * 通过 portal 渲染到 index.html 中已有的 DOM 容器。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../stores';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import { renderMarkdown } from '../utils/markdown';
import { toggleSidebar, applyTbToggleState } from './SidebarLayout';
import { toggleJianSidebar } from '../stores/desk-actions';
import { ContextMenu } from './ContextMenu';
import type { ContextMenuItem } from './ContextMenu';
import type { Channel, Agent } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── 辅助类型 ──

interface MemberInfo {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  fallbackAvatar: string | null;
  yuan?: string;
  isUser: boolean;
}

// ── 辅助函数 ──

function yuanFallbackAvatar(yuan?: string): string {
  const t = window.t ?? ((p: string) => p);
  const types = t('yuan.types') as unknown;
  if (types && typeof types === 'object') {
    const entry = (types as Record<string, { avatar?: string }>)[yuan || 'hanako'];
    return `assets/${entry?.avatar || 'Hanako.png'}`;
  }
  return 'assets/Hanako.png';
}

function resolveChannelMember(
  memberId: string,
  userName: string,
  userAvatarUrl: string | null,
  agents: Agent[],
  currentAgentId: string | null,
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
  const agent = agents.find((a) => a.id === memberId || a.name === memberId);
  if (agent) {
    return {
      id: memberId,
      displayName: agent.name || agent.id,
      avatarUrl: hanaUrl(`/api/agents/${agent.id}/avatar?t=${Date.now()}`),
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

function formatChannelTime(timestamp: string): string {
  if (!timestamp) return '';
  const parts = timestamp.split(' ');
  if (parts.length < 2) return timestamp;

  const today = new Date();
  const [y, mo, d] = parts[0].split('-').map(Number);
  const t = (window as any).t;

  if (y === today.getFullYear() && mo === today.getMonth() + 1 && d === today.getDate()) {
    return parts[1];
  }
  if (y === today.getFullYear() && mo === today.getMonth() + 1 && d === today.getDate() - 1) {
    return t('time.yesterday');
  }
  return `${mo}/${d}`;
}

// ══════════════════════════════════════════════════════
// MemberAvatar — 复用头像渲染
// ══════════════════════════════════════════════════════

function MemberAvatar({ info, className }: { info: MemberInfo; className?: string }) {
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
// ChannelsPanel — 入口组件
// ══════════════════════════════════════════════════════

export function ChannelsPanel() {
  const currentTab = useStore((s) => s.currentTab);
  const channelsEnabled = useStore((s) => s.channelsEnabled);
  const channels = useStore((s) => s.channels);
  const loadChannels = useStore((s) => s.loadChannels);
  const serverPort = useStore((s) => s.serverPort);

  // 初始化：如果 channels 功能已启用且 tab 是 channels，加载数据
  useEffect(() => {
    if (channelsEnabled && currentTab === 'channels' && channels.length === 0 && serverPort) {
      loadChannels();
    }
  }, [channelsEnabled, currentTab, channels.length, serverPort, loadChannels]);

  // 初始化：如果 channelsEnabled 但还没加载过，在启动时加载
  useEffect(() => {
    if (channelsEnabled && serverPort) {
      loadChannels();
    } else if (!channelsEnabled) {
      // Sync disabled state to backend
      hanaFetch('/api/channels/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverPort]);

  // Tab 初始化：恢复保存的 tab
  useEffect(() => {
    const savedTab = localStorage.getItem('hana-tab');
    if (savedTab === 'channels') {
      useStore.getState().setCurrentTab('channels');
    }
  }, []);

  // Tab 切换的 DOM 副作用（操纵非 React 管理的 DOM 元素）
  useEffect(() => {
    const sidebarChatContent = document.getElementById('sidebarChatContent');
    const sidebarChannelContent = document.getElementById('sidebarChannelContent');
    const chatArea = document.getElementById('chatArea');
    const inputArea = document.querySelector('.input-area') as HTMLElement | null;
    const channelView = document.getElementById('channelView');
    const jianChatContent = document.getElementById('jianChatContent');
    const jianChannelContent = document.getElementById('jianChannelContent');
    const activityPanel = document.getElementById('activityPanel');
    const automationPanel = document.getElementById('automationPanel');

    if (currentTab === 'chat') {
      sidebarChatContent?.classList.remove('hidden');
      sidebarChannelContent?.classList.add('hidden');
      chatArea?.classList.remove('hidden');
      inputArea?.classList.remove('hidden');
      channelView?.classList.remove('active');
      jianChatContent?.classList.remove('hidden');
      jianChannelContent?.classList.add('hidden');
    } else {
      sidebarChatContent?.classList.add('hidden');
      sidebarChannelContent?.classList.remove('hidden');
      chatArea?.classList.add('hidden');
      inputArea?.classList.add('hidden');
      channelView?.classList.add('active');
      jianChatContent?.classList.add('hidden');
      jianChannelContent?.classList.remove('hidden');
      activityPanel?.classList.add('hidden');
      automationPanel?.classList.add('hidden');
    }
  }, [currentTab]);

  // Tab 切换时同步 sidebar/jian 的 open 状态
  useEffect(() => {
    const savedLeft = localStorage.getItem(`hana-sidebar-${currentTab}`);
    const wantLeftOpen = savedLeft !== 'closed';
    const s = useStore.getState();
    if (s.sidebarOpen !== wantLeftOpen) {
      toggleSidebar(wantLeftOpen);
    }
    const savedRight = localStorage.getItem(`hana-jian-${currentTab}`);
    const wantRightOpen = savedRight !== 'closed';
    if (s.jianOpen !== wantRightOpen) {
      toggleJianSidebar(wantRightOpen);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTab]);

  // Tab slider + badge 的 DOM 操纵（titlebar tabs 现在由 React 渲染但仍用 DOM 操纵 slider）
  useTabSlider(currentTab);
  useTabBadge();
  useTabClickHandler();

  // 渲染 headless 控制组件（不产出 DOM，只管理副作用）
  return (
    <>
      <ChannelHeaderSync />
      <ChannelToggleController />
      <ChannelSidebarButtons />
    </>
  );
}

// ── 导出子组件供 App.tsx 布局使用 ──
export const ChannelList = ChannelListSection;
export const ChannelMessages = ChannelMessagesSection;
export const ChannelMembers = ChannelMembersSection;
export const ChannelInput = ChannelInputSection;
export const ChannelReadonly = ChannelReadonlyNotice;
export const ChannelCreate = ChannelCreateModal;

// ══════════════════════════════════════════════════════
// Hooks for titlebar tab management
// ══════════════════════════════════════════════════════

function useTabSlider(currentTab: string) {
  useEffect(() => {
    moveSlider(currentTab, true);
  }, [currentTab]);

  // Initial slider position (no animation)
  useEffect(() => {
    moveSlider(useStore.getState().currentTab || 'chat', false);
  }, []);
}

function moveSlider(tab: string, animate: boolean) {
  const tbTabs = document.getElementById('tbTabs');
  const slider = document.getElementById('tbSlider');
  const target = tbTabs?.querySelector(`.tb-tab[data-tab="${tab}"]`) as HTMLElement | null;
  if (!slider || !target || !tbTabs) return;
  const parentRect = tbTabs.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const offsetX = targetRect.left - parentRect.left;
  if (!animate) slider.style.transition = 'none';
  slider.style.width = targetRect.width + 'px';
  slider.style.transform = `translateX(${offsetX - 2}px)`;
  if (!animate) requestAnimationFrame(() => { slider.style.transition = ''; });
}

function useTabBadge() {
  const channelTotalUnread = useStore((s) => s.channelTotalUnread);

  useEffect(() => {
    const badge = document.getElementById('channelTabBadge');
    if (!badge) return;
    if (channelTotalUnread > 0) {
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }, [channelTotalUnread]);
}

function useTabClickHandler() {
  useEffect(() => {
    const tbTabs = document.getElementById('tbTabs');
    if (!tbTabs) return;

    const handler = (e: Event) => {
      const tabBtn = (e.target as HTMLElement).closest('.tb-tab') as HTMLElement | null;
      if (!tabBtn) return;
      const tab = tabBtn.dataset.tab || 'chat';
      const s = useStore.getState();
      if (tab === s.currentTab) return;

      s.setCurrentTab(tab as any);
      localStorage.setItem('hana-tab', tab);

      // Update active class on tab buttons
      tbTabs.querySelectorAll('.tb-tab').forEach((btn) => {
        (btn as HTMLElement).classList.toggle('active', (btn as HTMLElement).dataset.tab === tab);
      });

      applyTbToggleState();
    };

    tbTabs.addEventListener('click', handler);
    return () => tbTabs.removeEventListener('click', handler);
  }, []);
}

// ══════════════════════════════════════════════════════
// ChannelToggleController — toggle 开关 + disabled overlay
// ══════════════════════════════════════════════════════

function ChannelToggleController() {
  const channelsEnabled = useStore((s) => s.channelsEnabled);

  useEffect(() => {
    const toggle = document.getElementById('channelToggle');
    const overlay = document.getElementById('channelDisabledOverlay');
    const createBtn = document.getElementById('channelCreateBtn') as HTMLButtonElement | null;

    if (toggle) toggle.classList.toggle('on', channelsEnabled);
    if (overlay) overlay.classList.toggle('hidden', channelsEnabled);
    if (createBtn) {
      createBtn.disabled = !channelsEnabled;
      createBtn.classList.toggle('btn-disabled', !channelsEnabled);
    }
  }, [channelsEnabled]);

  useEffect(() => {
    const toggle = document.getElementById('channelToggle');
    if (!toggle) return;

    const handler = async () => {
      const s = useStore.getState();
      const turningOn = !s.channelsEnabled;

      if (turningOn) {
        const accepted = await showChannelWarning();
        if (!accepted) return;
      }

      await s.toggleChannelsEnabled();
    };

    toggle.addEventListener('click', handler);
    return () => toggle.removeEventListener('click', handler);
  }, []);

  return null;
}

// ── Warning 弹窗 ──

function showChannelWarning(): Promise<boolean> {
  return new Promise((resolve) => {
    const t = (window as any).t;
    const overlay = document.createElement('div');
    overlay.className = 'hana-warning-overlay';

    const box = document.createElement('div');
    box.className = 'hana-warning-box';

    const title = document.createElement('h3');
    title.className = 'hana-warning-title';
    title.textContent = t('channel.warningTitle');
    box.appendChild(title);

    const body = document.createElement('div');
    body.className = 'hana-warning-body';
    const text = t('channel.warningBody') || '';
    for (const para of text.split('\n\n')) {
      const p = document.createElement('p');
      const lines = para.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) p.appendChild(document.createElement('br'));
        p.appendChild(document.createTextNode(lines[i]));
      }
      body.appendChild(p);
    }
    box.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'hana-warning-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'hana-warning-cancel';
    cancelBtn.textContent = t('channel.createCancel');
    cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(false); });

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'hana-warning-confirm';
    confirmBtn.textContent = t('channel.warningConfirm');
    confirmBtn.addEventListener('click', () => { overlay.remove(); resolve(true); });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

// ══════════════════════════════════════════════════════
// ChannelSidebarButtons — collapse + info toggle 按钮事件
// ══════════════════════════════════════════════════════

function ChannelSidebarButtons() {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [menuItems, setMenuItems] = useState<ContextMenuItem[]>([]);

  useEffect(() => {
    const collapseBtn = document.getElementById('channelCollapseBtn');
    const infoToggle = document.getElementById('channelInfoToggle');
    const menuBtn = document.getElementById('channelMenuBtn');

    const handleCollapse = () => {
      toggleSidebar();
    };
    const handleInfoToggle = () => {
      toggleJianSidebar();
    };
    const handleMenu = (e: Event) => {
      const s = useStore.getState();
      if (!s.currentChannel) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setMenuItems([
        {
          label: (window as any).t('channel.deleteChannel'),
          danger: true,
          action: () => confirmDeleteChannel(s.currentChannel!),
        },
      ]);
      setMenuPos({ x: rect.left, y: rect.bottom + 4 });
    };

    collapseBtn?.addEventListener('click', handleCollapse);
    infoToggle?.addEventListener('click', handleInfoToggle);
    menuBtn?.addEventListener('click', handleMenu);

    return () => {
      collapseBtn?.removeEventListener('click', handleCollapse);
      infoToggle?.removeEventListener('click', handleInfoToggle);
      menuBtn?.removeEventListener('click', handleMenu);
    };
  }, []);

  const handleCloseMenu = useCallback(() => {
    setMenuPos(null);
  }, []);

  return menuPos ? (
    <ContextMenu items={menuItems} position={menuPos} onClose={handleCloseMenu} />
  ) : null;
}

function confirmDeleteChannel(channelId: string) {
  const s = useStore.getState();
  const ch = s.channels.find((c) => c.id === channelId);
  const displayName = ch?.name || channelId;
  const msg = ((window as any).t('channel.deleteConfirm', { name: displayName }) || '');
  if (!confirm(msg)) return;
  s.deleteChannel(channelId);
}

// ══════════════════════════════════════════════════════
// ChannelHeaderSync — 同步频道头部信息到静态 DOM
// ══════════════════════════════════════════════════════

function ChannelHeaderSync() {
  const headerName = useStore((s) => s.channelHeaderName);
  const headerMembers = useStore((s) => s.channelHeaderMembersText);
  const channelInfoName = useStore((s) => s.channelInfoName);
  const currentChannel = useStore((s) => s.currentChannel);
  const isDM = useStore((s) => s.channelIsDM);

  useEffect(() => {
    const el = document.getElementById('channelHeaderName');
    if (el) el.textContent = headerName;
  }, [headerName]);

  useEffect(() => {
    const el = document.getElementById('channelHeaderMembers');
    if (el) el.textContent = headerMembers;
  }, [headerMembers]);

  useEffect(() => {
    const el = document.getElementById('channelInfoName');
    if (el) el.textContent = channelInfoName;
  }, [channelInfoName]);

  useEffect(() => {
    const infoToggle = document.getElementById('channelInfoToggle');
    const menuBtn = document.getElementById('channelMenuBtn');
    if (currentChannel) {
      infoToggle?.classList.remove('hidden');
      if (isDM) {
        menuBtn?.classList.add('hidden');
      } else {
        menuBtn?.classList.remove('hidden');
      }
    }
  }, [currentChannel, isDM]);

  return null;
}

// ══════════════════════════════════════════════════════
// ChannelListSection — 频道列表
// ══════════════════════════════════════════════════════

function ChannelListSection() {
  const { t } = useI18n();
  const channels = useStore((s) => s.channels);
  const currentChannel = useStore((s) => s.currentChannel);
  const agents = useStore((s) => s.agents);
  const userName = useStore((s) => s.userName);
  const userAvatarUrl = useStore((s) => s.userAvatarUrl);
  const currentAgentId = useStore((s) => s.currentAgentId);
  const openChannel = useStore((s) => s.openChannel);

  if (channels.length === 0) {
    return <div className="session-empty">{t('channel.empty')}</div>;
  }

  const dms = channels.filter((ch) => ch.isDM === true);
  const groups = channels.filter((ch) => !ch.isDM);

  return (
    <>
      {dms.length > 0 && (
        <>
          <div className="channel-section-label">
            <span>{t('channel.dmLabel')}</span>
            <span className="channel-section-hint">{t('channel.dmHint')}</span>
          </div>
          {dms.map((ch) => (
            <ChannelItem
              key={ch.id}
              channel={ch}
              isDM
              isActive={ch.id === currentChannel}
              agents={agents}
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
          <div className="channel-section-label">{t('channel.groupLabel')}</div>
          {groups.map((ch) => (
            <ChannelItem
              key={ch.id}
              channel={ch}
              isDM={false}
              isActive={ch.id === currentChannel}
              agents={agents}
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
  userName: string;
  userAvatarUrl: string | null;
  currentAgentId: string | null;
  onOpen: (id: string, isDM?: boolean) => void;
}

function ChannelItem({ channel, isDM, isActive, agents, userName, userAvatarUrl, currentAgentId, onOpen }: ChannelItemProps) {
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

  const selfInfo = resolveChannelMember(currentAgentId || '', userName, userAvatarUrl, agents, currentAgentId);

  const ctxMenuItems: ContextMenuItem[] = ctxMenu ? [
    {
      label: (window as any).t('channel.deleteChannel'),
      danger: true,
      action: () => confirmDeleteChannel(channel.id),
    },
  ] : [];

  return (
    <div
      className={`channel-item${isActive ? ' active' : ''}`}
      data-channel={channel.id}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {isDM ? (
        <DmIcon channel={channel} selfInfo={selfInfo} agents={agents} userName={userName} userAvatarUrl={userAvatarUrl} currentAgentId={currentAgentId} />
      ) : (
        <div className="channel-item-icon">#</div>
      )}
      <div className="channel-item-body">
        <div className="channel-item-name">
          {isDM
            ? `${selfInfo.displayName} \u00B7 ${channel.peerName || channel.name}`
            : (channel.name || channel.id)
          }
        </div>
        <div className="channel-item-preview">
          {channel.lastMessage && (() => {
            const senderInfo = resolveChannelMember(channel.lastSender, userName, userAvatarUrl, agents, currentAgentId);
            return `${senderInfo.displayName}: ${channel.lastMessage}`;
          })()}
        </div>
      </div>
      <div className="channel-item-meta">
        {channel.lastTimestamp && (
          <div className="channel-item-time">{formatChannelTime(channel.lastTimestamp)}</div>
        )}
        {(channel.newMessageCount || 0) > 0 && (
          <div className="channel-unread-badge">
            {channel.newMessageCount > 99 ? '99+' : String(channel.newMessageCount)}
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

function DmIcon({ channel, selfInfo, agents, userName, userAvatarUrl, currentAgentId }: {
  channel: Channel;
  selfInfo: MemberInfo;
  agents: Agent[];
  userName: string;
  userAvatarUrl: string | null;
  currentAgentId: string | null;
}) {
  const peerId = channel.peerId || channel.members?.[0] || '';
  const peerInfo = resolveChannelMember(peerId, userName, userAvatarUrl, agents, currentAgentId);

  return (
    <div className="channel-dm-icon">
      <div className="channel-dm-avatar">
        <MemberAvatar info={selfInfo} />
      </div>
      <div className="channel-dm-link">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      </div>
      <div className="channel-dm-avatar">
        <MemberAvatar info={peerInfo} />
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// ChannelMessagesSection — 消息列表
// ══════════════════════════════════════════════════════

function ChannelMessagesSection() {
  const { t } = useI18n();
  const messages = useStore((s) => s.channelMessages);
  const currentChannel = useStore((s) => s.currentChannel);
  const channels = useStore((s) => s.channels);
  const agents = useStore((s) => s.agents);
  const userName = useStore((s) => s.userName);
  const userAvatarUrl = useStore((s) => s.userAvatarUrl);
  const currentAgentId = useStore((s) => s.currentAgentId);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    const el = document.getElementById('channelMessages');
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  if (!currentChannel || messages.length === 0) {
    return <div className="channel-welcome">{t('channel.noMessages')}</div>;
  }

  const ch = channels.find((c) => c.id === currentChannel);
  const isDM = ch?.isDM ?? false;
  let lastSender: string | null = null;

  return (
    <>
      {messages.map((msg, idx) => {
        const isContinuation = msg.sender === lastSender;
        const senderInfo = resolveChannelMember(msg.sender, userName, userAvatarUrl, agents, currentAgentId);
        const isSelf = senderInfo.isUser || (isDM && msg.sender === (currentAgentId || ''));
        const el = (
          <div
            key={`${msg.timestamp}-${idx}`}
            className={
              'channel-msg'
              + (isContinuation ? ' channel-msg-continuation' : '')
              + (isSelf ? ' channel-msg-self' : '')
            }
          >
            <div className="channel-msg-avatar">
              <MemberAvatar info={senderInfo} className="channel-msg-avatar-img" />
            </div>
            <div className="channel-msg-body">
              {!isContinuation && (
                <div className="channel-msg-header">
                  <span className="channel-msg-sender">{senderInfo.displayName}</span>
                  <span className="channel-msg-time">{formatChannelTime(msg.timestamp)}</span>
                </div>
              )}
              <div
                className="channel-msg-text"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.body || '') }}
              />
            </div>
          </div>
        );
        lastSender = msg.sender;
        return el;
      })}
    </>
  );
}

// ══════════════════════════════════════════════════════
// ChannelMembersSection — 右侧面板成员列表
// ══════════════════════════════════════════════════════

function ChannelMembersSection() {
  const currentChannel = useStore((s) => s.currentChannel);
  const channelMembers = useStore((s) => s.channelMembers);
  const isDM = useStore((s) => s.channelIsDM);
  const agents = useStore((s) => s.agents);
  const userName = useStore((s) => s.userName);
  const userAvatarUrl = useStore((s) => s.userAvatarUrl);
  const currentAgentId = useStore((s) => s.currentAgentId);

  if (!currentChannel) return null;

  if (isDM) {
    // DM: show peer and self info cards
    const peerId = channelMembers[0] || '';
    const peerInfo = resolveChannelMember(peerId, userName, userAvatarUrl, agents, currentAgentId);
    const selfInfo = resolveChannelMember(currentAgentId || '', userName, userAvatarUrl, agents, currentAgentId);

    return (
      <>
        {[peerInfo, selfInfo].map((info) => (
          <div key={info.id} className="channel-member-item">
            {info.avatarUrl ? (
              <MemberAvatar info={info} className="channel-member-avatar-img" />
            ) : (
              <div className="channel-member-avatar">
                {(info.displayName || '?').charAt(0).toUpperCase()}
              </div>
            )}
            <div className="channel-member-name">{info.displayName}</div>
          </div>
        ))}
      </>
    );
  }

  // Group channel: show all members (user + agents)
  const displayMembers = [userName || 'user', ...channelMembers];
  return (
    <>
      {displayMembers.map((m) => {
        const info = resolveChannelMember(m, userName, userAvatarUrl, agents, currentAgentId);
        return (
          <div key={info.id + m} className="channel-member-item">
            {info.avatarUrl ? (
              <MemberAvatar info={info} className="channel-member-avatar-img" />
            ) : (
              <div className="channel-member-avatar">
                {(info.displayName || '?').charAt(0).toUpperCase()}
              </div>
            )}
            <div className="channel-member-name">{info.displayName}</div>
          </div>
        );
      })}
    </>
  );
}

// ══════════════════════════════════════════════════════
// ChannelInputSection — 输入区域 + @mention
// ══════════════════════════════════════════════════════

function ChannelInputSection() {
  const currentChannel = useStore((s) => s.currentChannel);
  const isDM = useStore((s) => s.channelIsDM);
  const channelMembers = useStore((s) => s.channelMembers);
  const agents = useStore((s) => s.agents);
  const userName = useStore((s) => s.userName);
  const userAvatarUrl = useStore((s) => s.userAvatarUrl);
  const currentAgentId = useStore((s) => s.currentAgentId);
  const sendChannelMessage = useStore((s) => s.sendChannelMessage);

  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  const [mentionActive, setMentionActive] = useState(false);
  const [mentionItems, setMentionItems] = useState<MemberInfo[]>([]);
  const [mentionSelectedIdx, setMentionSelectedIdx] = useState(0);
  const [mentionStartPos, setMentionStartPos] = useState(-1);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Show/hide the input area based on DM state
  useEffect(() => {
    const inputArea = document.getElementById('channelInputArea');
    const readonlyNotice = document.getElementById('channelReadonlyNotice');
    if (!currentChannel) {
      inputArea?.classList.add('hidden');
      readonlyNotice?.classList.add('hidden');
      return;
    }
    if (isDM) {
      inputArea?.classList.add('hidden');
      readonlyNotice?.classList.remove('hidden');
    } else {
      inputArea?.classList.remove('hidden');
      readonlyNotice?.classList.add('hidden');
    }
  }, [currentChannel, isDM]);

  const handleSend = useCallback(async () => {
    if (sending || !inputValue.trim()) return;
    setSending(true);
    try {
      await sendChannelMessage(inputValue.trim());
      setInputValue('');
    } finally {
      setSending(false);
    }
  }, [sending, inputValue, sendChannelMessage]);

  const checkMention = useCallback(() => {
    if (!inputRef.current) return;
    const val = inputRef.current.value;
    const cursorPos = inputRef.current.selectionStart ?? 0;
    const textBeforeCursor = val.slice(0, cursorPos);

    const atIdx = textBeforeCursor.lastIndexOf('@');
    if (atIdx < 0 || (atIdx > 0 && /\S/.test(textBeforeCursor[atIdx - 1]))) {
      setMentionActive(false);
      return;
    }

    const keyword = textBeforeCursor.slice(atIdx + 1).toLowerCase();
    setMentionStartPos(atIdx);

    const members = (channelMembers || [])
      .map((id) => resolveChannelMember(id, userName, userAvatarUrl, agents, currentAgentId))
      .filter((m) => !m.isUser);

    const filtered = keyword
      ? members.filter((m) =>
          m.displayName.toLowerCase().includes(keyword) ||
          (m.yuan || '').toLowerCase().includes(keyword),
        )
      : members;

    if (filtered.length === 0) {
      setMentionActive(false);
      return;
    }

    setMentionItems(filtered);
    setMentionSelectedIdx(0);
    setMentionActive(true);
  }, [channelMembers, agents, userName, userAvatarUrl, currentAgentId]);

  const insertMention = useCallback((displayName: string) => {
    if (!inputRef.current || mentionStartPos < 0) return;
    const val = inputRef.current.value;
    const cursorPos = inputRef.current.selectionStart ?? 0;
    const before = val.slice(0, mentionStartPos);
    const after = val.slice(cursorPos);
    const inserted = `@${displayName} `;
    const newVal = before + inserted + after;
    setInputValue(newVal);
    setMentionActive(false);

    requestAnimationFrame(() => {
      if (inputRef.current) {
        const newCursor = before.length + inserted.length;
        inputRef.current.setSelectionRange(newCursor, newCursor);
        inputRef.current.focus();
      }
    });
  }, [mentionStartPos]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) {
      if (mentionActive) {
        e.preventDefault();
        const selected = mentionItems[mentionSelectedIdx];
        if (selected) insertMention(selected.displayName);
        return;
      }
      e.preventDefault();
      handleSend();
      return;
    }
    if (mentionActive) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionSelectedIdx((i) => (i + 1) % mentionItems.length); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionSelectedIdx((i) => (i - 1 + mentionItems.length) % mentionItems.length); }
      if (e.key === 'Escape') { e.preventDefault(); setMentionActive(false); }
    }
  }, [mentionActive, mentionItems, mentionSelectedIdx, insertMention, handleSend]);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
    // Defer mention check to after state update
    requestAnimationFrame(() => checkMention());
  }, [checkMention]);

  if (isDM || !currentChannel) return null;

  return (
    <div className="channel-input-wrapper">
      {mentionActive && mentionItems.length > 0 && (
        <div className="channel-mention-dropdown">
          {mentionItems.map((m, idx) => (
            <div
              key={m.id}
              className={`channel-mention-item${idx === mentionSelectedIdx ? ' active' : ''}`}
              data-name={m.displayName}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(m.displayName);
              }}
            >
              <div className="channel-mention-avatar">
                <MemberAvatar info={m} />
              </div>
              <span>{m.displayName}</span>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={inputRef}
        className="channel-input-box"
        placeholder="发消息..."
        rows={1}
        spellCheck={false}
        value={inputValue}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
      />
      <button
        className="channel-send-btn"
        disabled={!inputValue.trim() || sending}
        onClick={handleSend}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
      </button>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// ChannelReadonlyNotice
// ══════════════════════════════════════════════════════

function ChannelReadonlyNotice() {
  const isDM = useStore((s) => s.channelIsDM);
  const currentChannel = useStore((s) => s.currentChannel);

  if (!isDM || !currentChannel) return null;

  return (
    <span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: 'middle', marginRight: 4 }}>
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
      {(window as any).t?.('channel.dmReadonly') || '这是 Agent 之间的私信，仅可查看'}
    </span>
  );
}

// ══════════════════════════════════════════════════════
// ChannelCreateModal — 新建频道弹窗
// ══════════════════════════════════════════════════════

function ChannelCreateModal() {
  const { t } = useI18n();
  const agents = useStore((s) => s.agents);
  const createChannel = useStore((s) => s.createChannel);

  const [name, setName] = useState('');
  const [intro, setIntro] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [nameError, setNameError] = useState(false);
  const [membersError, setMembersError] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // When modal becomes visible, reset form and select all agents
  useEffect(() => {
    const overlay = document.getElementById('channelCreateOverlay');
    if (!overlay) return;

    const observer = new MutationObserver(() => {
      if (overlay.classList.contains('visible')) {
        setName('');
        setIntro('');
        setSelectedMembers(agents.map((a) => a.id));
        setNameError(false);
        setMembersError(false);
        requestAnimationFrame(() => nameRef.current?.focus());
      }
    });

    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [agents]);

  // Show/hide overlay via channelCreateBtn
  useEffect(() => {
    const createBtn = document.getElementById('channelCreateBtn');
    const cancelBtn = document.getElementById('channelCreateCancelBtnLegacy'); // won't exist, we handle inside
    const overlay = document.getElementById('channelCreateOverlay');

    const handleCreate = () => {
      overlay?.classList.add('visible');
    };
    const handleOverlayClick = (e: Event) => {
      if (e.target === e.currentTarget) overlay?.classList.remove('visible');
    };

    createBtn?.addEventListener('click', handleCreate);
    overlay?.addEventListener('click', handleOverlayClick);

    return () => {
      createBtn?.removeEventListener('click', handleCreate);
      overlay?.removeEventListener('click', handleOverlayClick);
    };
  }, []);

  const toggleMember = useCallback((agentId: string) => {
    setSelectedMembers((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId],
    );
    setMembersError(false);
  }, []);

  const handleCancel = useCallback(() => {
    document.getElementById('channelCreateOverlay')?.classList.remove('visible');
  }, []);

  const handleSubmit = useCallback(async () => {
    if (creating) return;
    if (!name.trim()) {
      nameRef.current?.focus();
      return;
    }
    if (selectedMembers.length < 2) {
      setMembersError(true);
      setTimeout(() => setMembersError(false), 1500);
      return;
    }

    setCreating(true);
    try {
      await createChannel(name.trim(), selectedMembers, intro.trim() || undefined);
      document.getElementById('channelCreateOverlay')?.classList.remove('visible');
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      if (msg.includes('已存在') || msg.includes('409')) {
        setNameError(true);
        nameRef.current?.focus();
        setTimeout(() => setNameError(false), 2000);
      }
    } finally {
      setCreating(false);
    }
  }, [creating, name, selectedMembers, intro, createChannel]);

  const handleNameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') handleCancel();
  }, [handleCancel]);

  return (
    <div className="agent-create-card">
      <h3 className="agent-create-title">{t('channel.createTitle') || '新建频道'}</h3>
      <div className="settings-field">
        <label className="settings-field-label">{t('channel.createName') || '频道名称'}</label>
        <input
          ref={nameRef}
          className="settings-input"
          type="text"
          placeholder={nameError ? (t('channel.nameExists') || '名称已存在') : (t('channel.createNamePlaceholder') || '例如：design-team')}
          autoComplete="off"
          value={name}
          onChange={(e) => { setName(e.target.value); setNameError(false); }}
          onKeyDown={handleNameKeyDown}
          style={nameError ? { outline: '1.5px solid var(--danger, #c44)' } : undefined}
        />
      </div>
      <div className="settings-field">
        <label className="settings-field-label">{t('channel.createMembers') || '成员'}</label>
        <div
          className="channel-create-members"
          style={membersError ? { outline: '1.5px solid var(--danger, #c44)' } : undefined}
        >
          {agents.map((agent) => {
            const isSelected = selectedMembers.includes(agent.id);
            return (
              <button
                key={agent.id}
                type="button"
                className={`channel-create-member-chip${isSelected ? ' selected' : ''}`}
                onClick={() => toggleMember(agent.id)}
              >
                <AgentChipAvatar agentId={agent.id} agentName={agent.name} />
                <span>{agent.name || agent.id}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="settings-field">
        <label className="settings-field-label">
          {t('channel.createIntro') || '频道介绍'}{' '}
          <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>
            {t('channel.createIntroOptional') || '（可选）'}
          </span>
        </label>
        <textarea
          className="settings-input channel-create-intro"
          rows={2}
          placeholder={t('channel.createIntroPlaceholder') || '描述一下这个频道的用途...'}
          style={{ resize: 'vertical', minHeight: '2.4rem' }}
          value={intro}
          onChange={(e) => setIntro(e.target.value)}
        />
      </div>
      <div className="agent-create-actions">
        <button className="agent-create-cancel" onClick={handleCancel}>
          {t('channel.createCancel') || '取消'}
        </button>
        <button className="agent-create-confirm" onClick={handleSubmit} disabled={creating}>
          {t('channel.createConfirm') || '创建'}
        </button>
      </div>
    </div>
  );
}

function AgentChipAvatar({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [error, setError] = useState(false);
  const src = hanaUrl(`/api/agents/${agentId}/avatar?t=${Date.now()}`);

  return (
    <span className="chip-avatar">
      {!error ? (
        <img
          src={src}
          className="chip-avatar-img"
          onError={() => setError(true)}
        />
      ) : (
        <>{(agentName || agentId).charAt(0).toUpperCase()}</>
      )}
    </span>
  );
}
