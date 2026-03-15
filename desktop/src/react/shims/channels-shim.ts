/**
 * channels-shim.ts — channels.js 的 bridge shim
 *
 * 包含：频道列表渲染、消息收发、@联想、新建频道弹窗、tab 切换。
 * bridge.ts 在 React mount 后调用 setupChannelsShim，覆盖 react-init.js 的 no-op 版本。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── ctx 闭包 ──

let ctx: Record<string, any> = {};
const $ = (sel: string): HTMLElement | null => document.querySelector(sel);

// ── DOM 引用（init 时初始化）──

let tbTabs: HTMLElement | null = null;
let sidebarChatContent: HTMLElement | null = null;
let sidebarChannelContent: HTMLElement | null = null;
let chatArea: HTMLElement | null = null;
let channelView: HTMLElement | null = null;
let jianChatContent: HTMLElement | null = null;
let jianChannelContent: HTMLElement | null = null;
let channelTabBadge: HTMLElement | null = null;
let channelListEl: HTMLElement | null = null;
let channelMessagesEl: HTMLElement | null = null;
let channelInputArea: HTMLElement | null = null;
let channelInputBox: HTMLTextAreaElement | null = null;
let channelSendBtn: HTMLButtonElement | null = null;
let channelReadonlyNotice: HTMLElement | null = null;
let channelHeaderName: HTMLElement | null = null;
let channelHeaderMembers: HTMLElement | null = null;
let channelInfoToggle: HTMLElement | null = null;
let channelMenuBtn: HTMLElement | null = null;
let channelInfoName: HTMLElement | null = null;
let channelMembersList: HTMLElement | null = null;
let channelMentionDropdown: HTMLElement | null = null;

// ── 模块内部状态 ──

let _channelsEnabled = localStorage.getItem('hana-channels-enabled') !== 'false';
let _sendingChannelMsg = false;
let _mentionActive = false;
let _mentionStartPos = -1;
let _mentionSelectedIdx = 0;
let _channelCreateMembers: string[] = [];
let _creatingChannel = false;

// ── 快捷访问 ──

function state(): Record<string, any> { return ctx.state; }
function hanaFetch(path: string, opts?: RequestInit): Promise<Response> { return ctx.hanaFetch(path, opts); }
function hanaUrl(path: string): string { return ctx.hanaUrl(path); }

// ══════════════════════════════════════════════════════
// Warning 弹窗
// ══════════════════════════════════════════════════════

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
// Tab 切换
// ══════════════════════════════════════════════════════

function moveSlider(tab: string, animate = true): void {
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

function switchTab(tab: string): void {
  const s = state();
  if (tab === s.currentTab) return;
  s.currentTab = tab;
  localStorage.setItem('hana-tab', tab);

  tbTabs?.querySelectorAll('.tb-tab').forEach((btn) => {
    (btn as HTMLElement).classList.toggle('active', (btn as HTMLElement).dataset.tab === tab);
  });
  moveSlider(tab);

  const savedLeft = localStorage.getItem(`hana-sidebar-${tab}`);
  const wantLeftOpen = savedLeft !== 'closed';
  if (s.sidebarOpen !== wantLeftOpen) {
    ctx.toggleSidebar(wantLeftOpen);
  }
  const savedRight = localStorage.getItem(`hana-jian-${tab}`);
  const wantRightOpen = savedRight !== 'closed';
  if (s.jianOpen !== wantRightOpen) {
    ctx.toggleJianSidebar(wantRightOpen);
  }

  if (tab === 'chat') {
    sidebarChatContent?.classList.remove('hidden');
    sidebarChannelContent?.classList.add('hidden');
    chatArea?.classList.remove('hidden');
    const inputArea = $('.input-area');
    inputArea?.classList.remove('hidden');
    channelView?.classList.remove('active');
    jianChatContent?.classList.remove('hidden');
    jianChannelContent?.classList.add('hidden');
  } else {
    sidebarChatContent?.classList.add('hidden');
    sidebarChannelContent?.classList.remove('hidden');
    chatArea?.classList.add('hidden');
    const inputArea = $('.input-area');
    inputArea?.classList.add('hidden');
    channelView?.classList.add('active');
    jianChatContent?.classList.add('hidden');
    jianChannelContent?.classList.remove('hidden');

    $('#activityPanel')?.classList.add('hidden');
    $('#automationPanel')?.classList.add('hidden');

    if (_channelsEnabled && s.channels.length === 0) {
      loadChannels();
    }
  }

  ctx.updateTbToggleState();
}

// ══════════════════════════════════════════════════════
// 频道加载
// ══════════════════════════════════════════════════════

async function loadChannels(): Promise<void> {
  const s = state();
  if (!s.serverPort) return;
  try {
    // 同时加载 channels 和 DMs
    const [chRes, dmRes] = await Promise.all([
      hanaFetch('/api/channels'),
      hanaFetch('/api/dm'),
    ]);

    const chData = chRes.ok ? await chRes.json() : { channels: [] };
    const dmData = dmRes.ok ? await dmRes.json() : { dms: [] };

    // channels 已有 id/name/description/members
    const channels = (chData.channels || []).map((ch: any) => ({
      ...ch,
      isDM: false,
    }));

    // DMs 转换为 channel 兼容格式
    const dms = (dmData.dms || []).map((dm: any) => ({
      id: `dm:${dm.peerId}`,
      name: dm.peerName || dm.peerId,
      members: [dm.peerId],
      lastMessage: dm.lastMessage || '',
      lastSender: dm.lastSender || '',
      lastTimestamp: dm.lastTimestamp || '',
      newMessageCount: 0,
      messageCount: dm.messageCount || 0,
      isDM: true,
      peerId: dm.peerId,
      peerName: dm.peerName,
    }));

    s.channels = [...channels, ...dms];
    s.channelTotalUnread = s.channels.reduce((sum: number, ch: any) => sum + (ch.newMessageCount || 0), 0);
    renderChannelList();
    updateChannelTabBadge();
  } catch (err) {
    console.error('[channels] load failed:', err);
  }
}

function updateChannelTabBadge(): void {
  if (!channelTabBadge) return;
  const s = state();
  if (s.channelTotalUnread > 0) {
    channelTabBadge.textContent = s.channelTotalUnread > 99
      ? '99+' : String(s.channelTotalUnread);
    channelTabBadge.classList.remove('hidden');
  } else {
    channelTabBadge.classList.add('hidden');
  }
}

// ══════════════════════════════════════════════════════
// 成员解析
// ══════════════════════════════════════════════════════

interface MemberInfo {
  displayName: string;
  avatarUrl: string | null;
  fallbackAvatar?: string | null;
  yuan?: string;
  isUser: boolean;
}

function resolveChannelMember(memberId: string): MemberInfo {
  const s = state();
  if (memberId === 'user' || memberId === (s.userName || 'user')) {
    return {
      displayName: s.userName || 'user',
      avatarUrl: s.userAvatarUrl || null,
      fallbackAvatar: null,
      isUser: true,
    };
  }
  const agent = s.agents?.find((a: any) => a.id === memberId || a.name === memberId);
  if (agent) {
    return {
      displayName: agent.name || agent.id,
      avatarUrl: hanaUrl(`/api/agents/${agent.id}/avatar?t=${Date.now()}`),
      fallbackAvatar: ctx.yuanFallbackAvatar(agent.yuan),
      yuan: agent.yuan,
      isUser: false,
    };
  }
  return {
    displayName: memberId,
    avatarUrl: null,
    isUser: false,
  };
}

// ══════════════════════════════════════════════════════
// 频道列表渲染
// ══════════════════════════════════════════════════════

function renderChannelList(): void {
  if (!channelListEl) return;
  channelListEl.innerHTML = '';
  const s = state();

  if (s.channels.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = (window as any).t('channel.empty');
    channelListEl.appendChild(empty);
    return;
  }

  const dms = s.channels.filter((ch: any) => ch.isDM === true);
  const groups = s.channels.filter((ch: any) => !ch.isDM);

  if (dms.length > 0) {
    const labelRow = document.createElement('div');
    labelRow.className = 'channel-section-label';
    const labelText = document.createElement('span');
    labelText.textContent = (window as any).t('channel.dmLabel');
    labelRow.appendChild(labelText);
    const hint = document.createElement('span');
    hint.className = 'channel-section-hint';
    hint.textContent = (window as any).t('channel.dmHint');
    labelRow.appendChild(hint);
    channelListEl.appendChild(labelRow);
    for (const ch of dms) {
      channelListEl.appendChild(_buildChannelItem(ch, true));
    }
  }

  if (groups.length > 0) {
    const label = document.createElement('div');
    label.className = 'channel-section-label';
    label.textContent = (window as any).t('channel.groupLabel');
    channelListEl.appendChild(label);
    for (const ch of groups) {
      channelListEl.appendChild(_buildChannelItem(ch, false));
    }
  }
}

function _buildChannelItem(ch: any, isDM: boolean): HTMLElement {
  const s = state();
  const item = document.createElement('div');
  item.className = 'channel-item' + (ch.id === s.currentChannel ? ' active' : '');
  item.dataset.channel = ch.id;

  if (isDM) {
    const peerInfo = resolveChannelMember(ch.peerId || ch.members?.[0] || '');
    const dmIcon = document.createElement('div');
    dmIcon.className = 'channel-dm-icon';

    const av = document.createElement('div');
    av.className = 'channel-dm-avatar';
    if (peerInfo.avatarUrl) {
      const img = document.createElement('img') as HTMLImageElement;
      img.src = peerInfo.avatarUrl;
      img.onerror = () => { img.onerror = null; img.src = peerInfo.fallbackAvatar || 'assets/Hanako.png'; };
      av.appendChild(img);
    } else {
      av.textContent = (peerInfo.displayName || '?').charAt(0).toUpperCase();
    }

    dmIcon.appendChild(av);
    item.appendChild(dmIcon);
  } else {
    const icon = document.createElement('div');
    icon.className = 'channel-item-icon';
    icon.textContent = '#';
    item.appendChild(icon);
  }

  const body = document.createElement('div');
  body.className = 'channel-item-body';

  const nameEl = document.createElement('div');
  nameEl.className = 'channel-item-name';
  if (isDM) {
    nameEl.textContent = ch.peerName || ch.name;
  } else {
    nameEl.textContent = ch.name || ch.id;
  }

  const preview = document.createElement('div');
  preview.className = 'channel-item-preview';
  if (ch.lastMessage) {
    const senderInfo = resolveChannelMember(ch.lastSender);
    preview.textContent = `${senderInfo.displayName}: ${ch.lastMessage}`;
  }

  body.appendChild(nameEl);
  body.appendChild(preview);

  const meta = document.createElement('div');
  meta.className = 'channel-item-meta';

  if (ch.lastTimestamp) {
    const time = document.createElement('div');
    time.className = 'channel-item-time';
    time.textContent = formatChannelTime(ch.lastTimestamp);
    meta.appendChild(time);
  }

  if ((ch.newMessageCount || 0) > 0) {
    const badge = document.createElement('div');
    badge.className = 'channel-unread-badge';
    badge.textContent = ch.newMessageCount > 99 ? '99+' : String(ch.newMessageCount);
    meta.appendChild(badge);
  }

  item.appendChild(body);
  item.appendChild(meta);

  item.addEventListener('click', () => openChannel(ch.id, ch.isDM));

  if (!isDM) {
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showChannelContextMenu(e.clientX, e.clientY, ch.id);
    });
  }

  return item;
}

// ══════════════════════════════════════════════════════
// 打开频道 + 消息渲染
// ══════════════════════════════════════════════════════

async function openChannel(channelId: string, isDM?: boolean): Promise<void> {
  const s = state();
  s.currentChannel = channelId;
  renderChannelList();

  const ch = s.channels.find((c: any) => c.id === channelId);
  const isThisDM = isDM ?? ch?.isDM ?? false;

  try {
    let data: any;
    if (isThisDM) {
      // DM: 从 /api/dm/:peerId 读取
      const peerId = ch?.peerId || channelId.replace('dm:', '');
      const res = await hanaFetch(`/api/dm/${encodeURIComponent(peerId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      s.channelMessages = data.messages || [];
      s.channelMembers = [peerId];

      if (channelHeaderName) channelHeaderName.textContent = data.peerName || peerId;
      if (channelHeaderMembers) channelHeaderMembers.textContent = '';

      // 右侧面板：显示对方 agent 信息
      channelInfoToggle?.classList.remove('hidden');
      channelMenuBtn?.classList.add('hidden');
      renderDmPeerInfo(peerId);
    } else {
      // Channel: 从 /api/channels/:id 读取
      const res = await hanaFetch(`/api/channels/${encodeURIComponent(channelId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      s.channelMessages = data.messages || [];
      const members = data.members || [];
      s.channelMembers = members;

      if (channelHeaderName) channelHeaderName.textContent = `# ${data.name || channelId}`;
      const displayMembers = [s.userName || 'user', ...members];
      if (channelHeaderMembers) channelHeaderMembers.textContent = `${displayMembers.length} ${(window as any).t('channel.membersCount')}`;
      channelInfoToggle?.classList.remove('hidden');
      channelMenuBtn?.classList.remove('hidden');
      if (channelInfoName) channelInfoName.textContent = data.name || channelId;
      renderChannelMembers(displayMembers);
    }

    renderChannelMessages();

    // DM 不允许用户直接发消息（agent 之间的对话）
    if (isThisDM) {
      channelInputArea?.classList.add('hidden');
      channelReadonlyNotice?.classList.remove('hidden');
    } else {
      channelInputArea?.classList.remove('hidden');
      channelReadonlyNotice?.classList.add('hidden');
    }

    // 标记已读
    if (!isThisDM) {
      const lastMsg = s.channelMessages[s.channelMessages.length - 1];
      if (lastMsg) {
        hanaFetch(`/api/channels/${encodeURIComponent(channelId)}/read`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timestamp: lastMsg.timestamp }),
        }).catch(() => {});

        if (ch) {
          s.channelTotalUnread = Math.max(0, s.channelTotalUnread - (ch.newMessageCount || 0));
          ch.newMessageCount = 0;
          updateChannelTabBadge();
          renderChannelList();
        }
      }
    }
  } catch (err) {
    console.error('[channels] open failed:', err);
  }
}

/** 渲染 DM 对方的 agent 信息卡片（右侧面板） */
function renderDmPeerInfo(peerId: string): void {
  if (!channelMembersList) return;
  channelMembersList.innerHTML = '';

  const peerInfo = resolveChannelMember(peerId);
  const s = state();
  const selfInfo = resolveChannelMember(s.currentAgentId || '');

  for (const info of [peerInfo, selfInfo]) {
    const card = document.createElement('div');
    card.className = 'channel-member-item';

    if (info.avatarUrl) {
      const img = document.createElement('img') as HTMLImageElement;
      img.className = 'channel-member-avatar-img';
      img.src = info.avatarUrl;
      img.onerror = () => { img.onerror = null; img.src = info.fallbackAvatar || 'assets/Hanako.png'; };
      card.appendChild(img);
    } else {
      const avatar = document.createElement('div');
      avatar.className = 'channel-member-avatar';
      avatar.textContent = (info.displayName || '?').charAt(0).toUpperCase();
      card.appendChild(avatar);
    }

    const name = document.createElement('div');
    name.className = 'channel-member-name';
    name.textContent = info.displayName;
    card.appendChild(name);

    channelMembersList.appendChild(card);
  }
}

function renderChannelMessages(): void {
  if (!channelMessagesEl) return;
  channelMessagesEl.innerHTML = '';
  const s = state();

  if (s.channelMessages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'channel-welcome';
    empty.textContent = (window as any).t('channel.noMessages');
    channelMessagesEl.appendChild(empty);
    return;
  }

  let lastSender: string | null = null;

  for (const msg of s.channelMessages) {
    const isContinuation = msg.sender === lastSender;
    const senderInfo = resolveChannelMember(msg.sender);
    // DM 里主 agent 的消息放右边，群聊里用户的消息放右边
    const isSelf = senderInfo.isUser || msg.sender === (s.currentAgentId || '');

    const el = document.createElement('div');
    el.className = 'channel-msg'
      + (isContinuation ? ' channel-msg-continuation' : '')
      + (isSelf ? ' channel-msg-self' : '');

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'channel-msg-avatar';
    if (senderInfo.avatarUrl) {
      const avatarImg = document.createElement('img') as HTMLImageElement;
      avatarImg.src = senderInfo.avatarUrl;
      avatarImg.className = 'channel-msg-avatar-img';
      avatarImg.onerror = () => { avatarImg.onerror = null; avatarImg.src = senderInfo.fallbackAvatar || 'assets/Hanako.png'; };
      avatarWrap.textContent = '';
      avatarWrap.appendChild(avatarImg);
    } else {
      avatarWrap.textContent = (senderInfo.displayName || '?').charAt(0).toUpperCase();
    }
    el.appendChild(avatarWrap);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'channel-msg-body';

    if (!isContinuation) {
      const header = document.createElement('div');
      header.className = 'channel-msg-header';

      const sender = document.createElement('span');
      sender.className = 'channel-msg-sender';
      sender.textContent = senderInfo.displayName;

      const time = document.createElement('span');
      time.className = 'channel-msg-time';
      time.textContent = formatChannelTime(msg.timestamp);

      header.appendChild(sender);
      header.appendChild(time);
      bodyEl.appendChild(header);
    }

    const textEl = document.createElement('div');
    textEl.className = 'channel-msg-text';
    textEl.innerHTML = ctx.md.render(msg.body || '');
    bodyEl.appendChild(textEl);

    el.appendChild(bodyEl);
    channelMessagesEl.appendChild(el);
    lastSender = msg.sender;
  }

  channelMessagesEl.scrollTop = channelMessagesEl.scrollHeight;
}

function renderChannelMembers(members: string[]): void {
  if (!channelMembersList) return;
  channelMembersList.innerHTML = '';

  for (const m of members) {
    const info = resolveChannelMember(m);
    const item = document.createElement('div');
    item.className = 'channel-member-item';

    if (info.avatarUrl) {
      const img = document.createElement('img') as HTMLImageElement;
      img.className = 'channel-member-avatar-img';
      img.src = info.avatarUrl;
      img.onerror = () => { img.onerror = null; img.src = info.fallbackAvatar || 'assets/Hanako.png'; };
      item.appendChild(img);
    } else {
      const avatar = document.createElement('div');
      avatar.className = 'channel-member-avatar';
      avatar.textContent = (info.displayName || '?').charAt(0).toUpperCase();
      item.appendChild(avatar);
    }

    const name = document.createElement('div');
    name.className = 'channel-member-name';
    name.textContent = info.displayName;

    item.appendChild(name);
    channelMembersList.appendChild(item);
  }
}

// ══════════════════════════════════════════════════════
// 消息发送
// ══════════════════════════════════════════════════════

async function sendChannelMessage(): Promise<void> {
  const s = state();
  if (!channelInputBox || _sendingChannelMsg) return;
  const text = channelInputBox.value.trim();
  if (!text || !s.currentChannel) return;

  _sendingChannelMsg = true;
  channelInputBox.value = '';
  if (channelSendBtn) channelSendBtn.disabled = true;

  try {
    const res = await hanaFetch(`/api/channels/${encodeURIComponent(s.currentChannel)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok && data.timestamp) {
      s.channelMessages.push({
        sender: s.userName || 'user',
        timestamp: data.timestamp,
        body: text,
      });
      renderChannelMessages();
    }
  } catch (err) {
    console.error('[channels] send failed:', err);
  } finally {
    _sendingChannelMsg = false;
    if (channelSendBtn) channelSendBtn.disabled = !channelInputBox.value.trim();
  }
}

// ══════════════════════════════════════════════════════
// @ 联想系统
// ══════════════════════════════════════════════════════

function checkMentionTrigger(): void {
  if (!channelInputBox || !channelMentionDropdown) return;

  const val = channelInputBox.value;
  const cursorPos = channelInputBox.selectionStart ?? 0;
  const textBeforeCursor = val.slice(0, cursorPos);

  const atIdx = textBeforeCursor.lastIndexOf('@');
  if (atIdx < 0 || (atIdx > 0 && /\S/.test(textBeforeCursor[atIdx - 1]))) {
    hideMentionDropdown();
    return;
  }

  const keyword = textBeforeCursor.slice(atIdx + 1).toLowerCase();
  _mentionStartPos = atIdx;

  const members = (state().channelMembers || [])
    .map((id: string) => resolveChannelMember(id))
    .filter((m: MemberInfo) => !m.isUser);

  const filtered = keyword
    ? members.filter((m: MemberInfo) =>
        m.displayName.toLowerCase().includes(keyword) ||
        (m.yuan || '').toLowerCase().includes(keyword),
      )
    : members;

  if (filtered.length === 0) {
    hideMentionDropdown();
    return;
  }

  channelMentionDropdown.innerHTML = '';
  _mentionSelectedIdx = 0;

  filtered.forEach((m: MemberInfo, idx: number) => {
    const item = document.createElement('div');
    item.className = 'channel-mention-item' + (idx === 0 ? ' active' : '');
    item.dataset.name = m.displayName;

    const avatar = document.createElement('div');
    avatar.className = 'channel-mention-avatar';
    if (m.avatarUrl) {
      const img = document.createElement('img') as HTMLImageElement;
      img.src = m.avatarUrl;
      img.onerror = () => { img.onerror = null; img.src = m.fallbackAvatar || 'assets/Hanako.png'; };
      avatar.appendChild(img);
    } else {
      avatar.textContent = (m.displayName || '?').charAt(0).toUpperCase();
    }

    const nameEl = document.createElement('span');
    nameEl.textContent = m.displayName;

    item.appendChild(avatar);
    item.appendChild(nameEl);

    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      insertMention(m.displayName);
    });

    channelMentionDropdown!.appendChild(item);
  });

  channelMentionDropdown.classList.remove('hidden');
  _mentionActive = true;
}

function hideMentionDropdown(): void {
  if (channelMentionDropdown) channelMentionDropdown.classList.add('hidden');
  _mentionActive = false;
  _mentionStartPos = -1;
}

function navigateMention(direction: number): void {
  if (!channelMentionDropdown) return;
  const items = channelMentionDropdown.querySelectorAll('.channel-mention-item');
  if (items.length === 0) return;

  items[_mentionSelectedIdx]?.classList.remove('active');
  _mentionSelectedIdx = (_mentionSelectedIdx + direction + items.length) % items.length;
  items[_mentionSelectedIdx]?.classList.add('active');
  items[_mentionSelectedIdx]?.scrollIntoView({ block: 'nearest' });
}

function selectMentionItem(): void {
  if (!channelMentionDropdown) return;
  const items = channelMentionDropdown.querySelectorAll('.channel-mention-item');
  const selected = items[_mentionSelectedIdx] as HTMLElement | undefined;
  if (selected) {
    insertMention(selected.dataset.name || '');
  }
}

function insertMention(displayName: string): void {
  if (!channelInputBox || _mentionStartPos < 0) return;

  const val = channelInputBox.value;
  const cursorPos = channelInputBox.selectionStart ?? 0;
  const before = val.slice(0, _mentionStartPos);
  const after = val.slice(cursorPos);
  const inserted = `@${displayName} `;

  channelInputBox.value = before + inserted + after;
  const newCursor = before.length + inserted.length;
  channelInputBox.setSelectionRange(newCursor, newCursor);
  channelInputBox.focus();

  hideMentionDropdown();
  if (channelSendBtn) channelSendBtn.disabled = !channelInputBox.value.trim();
}

function formatChannelTime(timestamp: string): string {
  if (!timestamp) return '';
  const parts = timestamp.split(' ');
  if (parts.length < 2) return timestamp;

  const today = new Date();
  const [y, mo, d] = parts[0].split('-').map(Number);

  if (y === today.getFullYear() && mo === today.getMonth() + 1 && d === today.getDate()) {
    return parts[1];
  }
  if (y === today.getFullYear() && mo === today.getMonth() + 1 && d === today.getDate() - 1) {
    return (window as any).t('time.yesterday');
  }
  return `${mo}/${d}`;
}

// ══════════════════════════════════════════════════════
// 新建频道弹窗
// ══════════════════════════════════════════════════════

function showChannelContextMenu(x: number, y: number, channelId: string): void {
  const s = state();
  const ch = s.channels.find((c: any) => c.id === channelId);
  if (ch?.isDM) return;

  const items = [
    {
      label: (window as any).t('channel.deleteChannel'),
      danger: true,
      action: () => confirmDeleteChannel(channelId),
    },
  ];
  ctx.showContextMenu(x, y, items);
}

async function confirmDeleteChannel(channelId: string): Promise<void> {
  const s = state();
  const ch = s.channels.find((c: any) => c.id === channelId);
  const displayName = ch?.name || channelId;
  const msg = ((window as any).t('channel.deleteConfirm', { name: displayName }) || '');
  if (!confirm(msg)) return;

  try {
    const res = await hanaFetch(`/api/channels/${encodeURIComponent(channelId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok) {
      if (s.currentChannel === channelId) {
        s.currentChannel = null;
        s.channelMessages = [];
        if (channelMessagesEl) channelMessagesEl.innerHTML = '';
        if (channelHeaderName) channelHeaderName.textContent = '';
        if (channelHeaderMembers) channelHeaderMembers.textContent = '';
        channelInputArea?.classList.add('hidden');
        channelReadonlyNotice?.classList.add('hidden');
      }
      await loadChannels();
    } else {
      console.error('[channels] delete failed:', data.error);
    }
  } catch (err) {
    console.error('[channels] delete failed:', err);
  }
}

function showChannelCreate(): void {
  const overlay = $('#channelCreateOverlay');
  if (!overlay) return;
  overlay.classList.add('visible');

  const nameInput = $('#channelCreateNameInput') as HTMLInputElement | null;
  if (nameInput) {
    nameInput.value = '';
    requestAnimationFrame(() => nameInput.focus());
  }

  const introInput = $('#channelCreateIntroInput') as HTMLTextAreaElement | null;
  if (introInput) introInput.value = '';

  // 默认选中所有 agent
  _channelCreateMembers = state().agents.map((a: any) => a.id);
  renderChannelCreateMembers();
}

function hideChannelCreate(): void {
  const overlay = $('#channelCreateOverlay');
  if (overlay) overlay.classList.remove('visible');
}

function renderChannelCreateMembers(): void {
  const container = $('#channelCreateMembers');
  if (!container) return;
  container.innerHTML = '';
  const s = state();

  for (const agent of s.agents) {
    const chip = document.createElement('button');
    chip.type = 'button';
    const isSelected = _channelCreateMembers.includes(agent.id);
    chip.className = 'channel-create-member-chip' + (isSelected ? ' selected' : '');

    const avatarEl = document.createElement('span');
    avatarEl.className = 'chip-avatar';
    const avatarImg = document.createElement('img') as HTMLImageElement;
    avatarImg.src = hanaUrl(`/api/agents/${agent.id}/avatar?t=${Date.now()}`);
    avatarImg.className = 'chip-avatar-img';
    avatarImg.onerror = () => {
      avatarImg.onerror = null;
      avatarImg.style.display = 'none';
      avatarEl.textContent = (agent.name || agent.id).charAt(0).toUpperCase();
    };
    avatarEl.appendChild(avatarImg);

    const name = document.createElement('span');
    name.textContent = agent.name || agent.id;

    chip.appendChild(avatarEl);
    chip.appendChild(name);

    chip.addEventListener('click', () => {
      const idx = _channelCreateMembers.indexOf(agent.id);
      if (idx > -1) {
        _channelCreateMembers.splice(idx, 1);
      } else {
        _channelCreateMembers.push(agent.id);
      }
      renderChannelCreateMembers();
    });

    container.appendChild(chip);
  }
}

async function submitChannelCreate(): Promise<void> {
  if (_creatingChannel) return;

  const nameInput = $('#channelCreateNameInput') as HTMLInputElement | null;
  const name = (nameInput?.value ?? '').trim();
  if (!name) {
    nameInput?.focus();
    return;
  }

  if (_channelCreateMembers.length < 2) {
    const membersContainer = $('#channelCreateMembers');
    if (membersContainer) {
      membersContainer.style.outline = '1.5px solid var(--danger, #c44)';
      setTimeout(() => { membersContainer.style.outline = ''; }, 1500);
    }
    return;
  }

  _creatingChannel = true;
  const btn = $('#channelCreateConfirmBtn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  try {
    const introInput = $('#channelCreateIntroInput') as HTMLTextAreaElement | null;
    const intro = (introInput?.value ?? '').trim();

    const res = await hanaFetch('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        members: _channelCreateMembers,
        intro: intro || undefined,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    hideChannelCreate();

    await loadChannels();
    if (data.id) {
      openChannel(data.id);
    }
  } catch (err: any) {
    console.error('[channels] create failed:', err);
    const msg = String(err?.message || err || 'unknown error');
    if (msg.includes('已存在') || msg.includes('409')) {
      if (nameInput) {
        const origPlaceholder = nameInput.placeholder;
        nameInput.style.outline = '1.5px solid var(--danger, #c44)';
        nameInput.placeholder = (window as any).t('channel.nameExists');
        nameInput.focus();
        setTimeout(() => { nameInput.style.outline = ''; nameInput.placeholder = origPlaceholder; }, 2000);
      }
    }
  } finally {
    _creatingChannel = false;
    if (btn) btn.disabled = false;
  }
}

// ══════════════════════════════════════════════════════
// 初始化
// ══════════════════════════════════════════════════════

function initChannels(context: Record<string, any>): void {
  ctx = context;

  tbTabs = $('#tbTabs');
  sidebarChatContent = $('#sidebarChatContent');
  sidebarChannelContent = $('#sidebarChannelContent');
  chatArea = $('#chatArea');
  channelView = $('#channelView');
  jianChatContent = $('#jianChatContent');
  jianChannelContent = $('#jianChannelContent');
  channelTabBadge = $('#channelTabBadge');
  channelListEl = $('#channelList');
  channelMessagesEl = $('#channelMessages');
  channelInputArea = $('#channelInputArea');
  channelInputBox = $('#channelInputBox') as HTMLTextAreaElement | null;
  channelSendBtn = $('#channelSendBtn') as HTMLButtonElement | null;
  channelReadonlyNotice = $('#channelReadonlyNotice');
  channelHeaderName = $('#channelHeaderName');
  channelHeaderMembers = $('#channelHeaderMembers');
  channelInfoToggle = $('#channelInfoToggle');
  channelMenuBtn = $('#channelMenuBtn');
  channelInfoName = $('#channelInfoName');
  channelMembersList = $('#channelMembersList');
  channelMentionDropdown = $('#channelMentionDropdown');

  tbTabs?.addEventListener('click', (e) => {
    const tabBtn = (e.target as HTMLElement).closest('.tb-tab') as HTMLElement | null;
    if (!tabBtn) return;
    switchTab(tabBtn.dataset.tab || 'chat');
  });

  $('#channelCollapseBtn')?.addEventListener('click', () => ctx.toggleSidebar());

  channelInfoToggle?.addEventListener('click', () => ctx.toggleJianSidebar());

  channelMenuBtn?.addEventListener('click', (e) => {
    if (!state().currentChannel) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showChannelContextMenu(rect.left, rect.bottom + 4, state().currentChannel);
  });

  channelSendBtn?.addEventListener('click', sendChannelMessage);
  channelInputBox?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !(e as any).isComposing) {
      if (channelMentionDropdown && !channelMentionDropdown.classList.contains('hidden')) {
        e.preventDefault();
        selectMentionItem();
        return;
      }
      e.preventDefault();
      sendChannelMessage();
    }
    if (channelMentionDropdown && !channelMentionDropdown.classList.contains('hidden')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); navigateMention(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); navigateMention(-1); }
      if (e.key === 'Escape') { e.preventDefault(); hideMentionDropdown(); }
    }
  });
  channelInputBox?.addEventListener('input', () => {
    if (channelSendBtn) {
      channelSendBtn.disabled = !channelInputBox!.value.trim();
    }
    checkMentionTrigger();
  });

  $('#channelCreateBtn')?.addEventListener('click', showChannelCreate);
  $('#channelCreateCancelBtn')?.addEventListener('click', hideChannelCreate);
  $('#channelCreateConfirmBtn')?.addEventListener('click', submitChannelCreate);
  $('#channelCreateOverlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) hideChannelCreate();
  });
  ($('#channelCreateNameInput') as HTMLInputElement | null)?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideChannelCreate();
  });

  const channelToggle = $('#channelToggle');
  const channelOverlay = $('#channelDisabledOverlay');
  const channelCreateBtn = $('#channelCreateBtn') as HTMLButtonElement | null;

  function syncChannelDisabledUI(enabled: boolean): void {
    if (channelOverlay) channelOverlay.classList.toggle('hidden', enabled);
    if (channelCreateBtn) {
      channelCreateBtn.disabled = !enabled;
      channelCreateBtn.classList.toggle('btn-disabled', !enabled);
    }
  }

  if (channelToggle) {
    channelToggle.classList.toggle('on', _channelsEnabled);
    syncChannelDisabledUI(_channelsEnabled);
    channelToggle.addEventListener('click', async () => {
      const turningOn = !_channelsEnabled;

      if (turningOn) {
        const accepted = await showChannelWarning();
        if (!accepted) return;
      }

      _channelsEnabled = turningOn;
      localStorage.setItem('hana-channels-enabled', String(_channelsEnabled));
      channelToggle.classList.toggle('on', _channelsEnabled);
      syncChannelDisabledUI(_channelsEnabled);
      if (_channelsEnabled) loadChannels();
      try {
        await hanaFetch('/api/channels/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: _channelsEnabled }),
        });
      } catch (err) {
        console.error('[channels] toggle backend failed:', err);
      }
    });
  }

  const savedTab = localStorage.getItem('hana-tab');
  if (savedTab === 'channels') {
    switchTab('channels');
  }

  moveSlider(state().currentTab || 'chat', false);

  if (_channelsEnabled) {
    loadChannels();
  } else {
    hanaFetch('/api/channels/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    }).catch(() => {});
  }
}

// ══════════════════════════════════════════════════════
// 导出
// ══════════════════════════════════════════════════════

export function setupChannelsShim(modules: Record<string, unknown>): void {
  modules.channels = {
    initChannels,
    switchTab,
    loadChannels,
    updateChannelTabBadge,
    renderChannelList,
    renderChannelMessages,
    openChannel,
  };
}
