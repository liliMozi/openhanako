/**
 * channel-actions.ts — Channel 副作用操作（网络请求 + 状态联动）
 *
 * 从 channel-slice.ts 提取，所有函数通过 useStore.getState() / useStore.setState() 访问 store。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- API 响应 JSON 及 catch(err: any) */

import { useStore } from './index';
import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Channel } from '../types';

// ══════════════════════════════════════════════════════
// 加载频道列表
// ══════════════════════════════════════════════════════

export async function loadChannels(): Promise<void> {
  const s = useStore.getState();
  if (!s.serverPort) return;
  try {
    const [chRes, dmRes] = await Promise.all([
      hanaFetch('/api/channels'),
      hanaFetch('/api/dm'),
    ]);

    const chData = chRes.ok ? await chRes.json() : { channels: [] };
    const dmData = dmRes.ok ? await dmRes.json() : { dms: [] };

    const channels: Channel[] = (chData.channels || []).map((ch: any) => ({
      ...ch,
      isDM: false,
    }));

    const dms: Channel[] = (dmData.dms || []).map((dm: any) => ({
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

    const allChannels = [...channels, ...dms];
    const totalUnread = allChannels.reduce((sum, ch) => sum + (ch.newMessageCount || 0), 0);
    useStore.setState({ channels: allChannels, channelTotalUnread: totalUnread });
  } catch (err) {
    console.error('[channels] load failed:', err);
  }
}

// ══════════════════════════════════════════════════════
// 打开频道
// ══════════════════════════════════════════════════════

export async function openChannel(channelId: string, isDM?: boolean): Promise<void> {
  const s = useStore.getState();
  const ch = s.channels.find((c: Channel) => c.id === channelId);
  const isThisDM = isDM ?? ch?.isDM ?? false;
  const t = window.t;

  useStore.setState({ currentChannel: channelId });

  try {
    if (isThisDM) {
      const peerId = ch?.peerId || channelId.replace('dm:', '');
      const res = await hanaFetch(`/api/dm/${encodeURIComponent(peerId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      useStore.setState({
        channelMessages: data.messages || [],
        channelMembers: [peerId],
        channelHeaderName: data.peerName || peerId,
        channelHeaderMembersText: '',
        channelIsDM: true,
        channelInfoName: data.peerName || peerId,
      });
    } else {
      const res = await hanaFetch(`/api/channels/${encodeURIComponent(channelId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const members = data.members || [];
      const displayMembers = [useStore.getState().userName || 'user', ...members];
      useStore.setState({
        channelMessages: data.messages || [],
        channelMembers: members,
        channelHeaderName: `# ${data.name || channelId}`,
        channelHeaderMembersText: `${displayMembers.length} ${t('channel.membersCount')}`,
        channelIsDM: false,
        channelInfoName: data.name || channelId,
      });

      // Mark as read
      const msgs = data.messages || [];
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg) {
        hanaFetch(`/api/channels/${encodeURIComponent(channelId)}/read`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timestamp: lastMsg.timestamp }),
        }).catch((err: unknown) => console.warn('[channel-actions] mark-as-read failed', err));

        // 重新取 store 最新状态，避免覆盖 await 期间的并发更新
        const fresh = useStore.getState();
        const freshCh = fresh.channels.find((c: Channel) => c.id === channelId);
        if (freshCh) {
          const newTotal = Math.max(0, fresh.channelTotalUnread - (freshCh.newMessageCount || 0));
          const updatedChannels = fresh.channels.map((c: Channel) =>
            c.id === channelId ? { ...c, newMessageCount: 0 } : c,
          );
          useStore.setState({ channelTotalUnread: newTotal, channels: updatedChannels });
        }
      }
    }
  } catch (err) {
    console.error('[channels] open failed:', err);
  }
}

// ══════════════════════════════════════════════════════
// 发送消息
// ══════════════════════════════════════════════════════

export async function sendChannelMessage(text: string): Promise<void> {
  const s = useStore.getState();
  if (!text.trim() || !s.currentChannel) return;

  try {
    const res = await hanaFetch(`/api/channels/${encodeURIComponent(s.currentChannel)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok && data.timestamp) {
      // 重新取最新消息列表，避免覆盖 await 期间的并发更新
      const fresh = useStore.getState();
      useStore.setState({
        channelMessages: [...fresh.channelMessages, {
          sender: fresh.userName || 'user',
          timestamp: data.timestamp,
          body: text,
        }],
      });
    }
  } catch (err) {
    console.error('[channels] send failed:', err);
  }
}

// ══════════════════════════════════════════════════════
// 删除频道
// ══════════════════════════════════════════════════════

export async function deleteChannel(channelId: string): Promise<void> {
  const s = useStore.getState();
  try {
    const res = await hanaFetch(`/api/channels/${encodeURIComponent(channelId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok) {
      if (s.currentChannel === channelId) {
        useStore.setState({
          currentChannel: null,
          channelMessages: [],
          channelHeaderName: '',
          channelHeaderMembersText: '',
          channelIsDM: false,
        });
      }
      // Reload channels
      await loadChannels();
    } else {
      console.error('[channels] delete failed:', data.error);
    }
  } catch (err) {
    console.error('[channels] delete failed:', err);
  }
}

// ══════════════════════════════════════════════════════
// 切换频道功能开关
// ══════════════════════════════════════════════════════

export async function toggleChannelsEnabled(): Promise<boolean> {
  const s = useStore.getState();
  const newEnabled = !s.channelsEnabled;
  localStorage.setItem('hana-channels-enabled', String(newEnabled));
  useStore.setState({ channelsEnabled: newEnabled });

  if (newEnabled) {
    await loadChannels();
  }

  try {
    await hanaFetch('/api/channels/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: newEnabled }),
    });
  } catch (err) {
    console.error('[channels] toggle backend failed:', err);
  }

  return newEnabled;
}

// ══════════════════════════════════════════════════════
// 创建频道
// ══════════════════════════════════════════════════════

export async function createChannel(name: string, members: string[], intro?: string): Promise<string | null> {
  try {
    const res = await hanaFetch('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        members,
        intro: intro || undefined,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    await loadChannels();
    if (data.id) {
      await openChannel(data.id);
    }
    return data.id || null;
  } catch (err: any) {
    console.error('[channels] create failed:', err);
    throw err;
  }
}
