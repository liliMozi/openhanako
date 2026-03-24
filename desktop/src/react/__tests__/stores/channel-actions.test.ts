/**
 * channel-actions 基线测试
 *
 * 测试纯逻辑部分（不涉及网络请求的函数），
 * 以及 store 状态变化的正确性。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock store
const mockState: Record<string, unknown> = {
  serverPort: '3210',
  channels: [],
  currentChannel: null,
  channelMessages: [],
  channelTotalUnread: 0,
  channelsEnabled: true,
  userName: 'testuser',
  channelMembers: [],
  channelHeaderName: '',
  channelHeaderMembersText: '',
  channelIsDM: false,
  channelInfoName: '',
};

const setStateCalls: Array<Record<string, unknown>> = [];

vi.mock('../../stores', () => ({
  useStore: {
    getState: () => ({ ...mockState }),
    setState: (patch: Record<string, unknown>) => {
      setStateCalls.push(patch);
      Object.assign(mockState, patch);
    },
  },
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

import { hanaFetch } from '../../hooks/use-hana-fetch';

const mockFetch = vi.mocked(hanaFetch);

describe('channel-actions', () => {
  beforeEach(() => {
    setStateCalls.length = 0;
    mockState.channels = [];
    mockState.currentChannel = null;
    mockState.channelMessages = [];
    mockState.channelTotalUnread = 0;
    mockState.channelsEnabled = true;
    mockFetch.mockReset();
  });

  describe('loadChannels', () => {
    it('加载频道和 DM 列表', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ channels: [{ id: 'ch1', name: 'general', newMessageCount: 2 }] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ dms: [{ peerId: 'agent1', peerName: 'Agent 1', messageCount: 5 }] }),
        } as Response);

      const { loadChannels } = await import('../../stores/channel-actions');
      await loadChannels();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      // 检查 setState 被调用，包含合并的 channels
      const lastPatch = setStateCalls[setStateCalls.length - 1];
      expect(lastPatch.channels).toBeDefined();
      const channels = lastPatch.channels as Array<{ id: string; isDM: boolean }>;
      expect(channels.length).toBe(2);
      expect(channels[0].isDM).toBe(false);
      expect(channels[1].isDM).toBe(true);
      expect(channels[1].id).toBe('dm:agent1');
    });

    it('serverPort 为空时不请求', async () => {
      mockState.serverPort = '';
      const { loadChannels } = await import('../../stores/channel-actions');
      await loadChannels();
      expect(mockFetch).not.toHaveBeenCalled();
      mockState.serverPort = '3210';
    });
  });

  describe('sendChannelMessage', () => {
    it('空消息不发送', async () => {
      mockState.currentChannel = 'ch1';
      const { sendChannelMessage } = await import('../../stores/channel-actions');
      await sendChannelMessage('   ');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('无当前频道不发送', async () => {
      mockState.currentChannel = null;
      const { sendChannelMessage } = await import('../../stores/channel-actions');
      await sendChannelMessage('hello');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('发送成功后追加消息到 store', async () => {
      mockState.currentChannel = 'ch1';
      mockState.channelMessages = [];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, timestamp: '2026-03-22T00:00:00Z' }),
      } as Response);

      const { sendChannelMessage } = await import('../../stores/channel-actions');
      await sendChannelMessage('hello world');

      const msgPatch = setStateCalls.find(p => p.channelMessages);
      expect(msgPatch).toBeDefined();
      const msgs = msgPatch!.channelMessages as Array<{ sender: string; body: string }>;
      expect(msgs[msgs.length - 1].body).toBe('hello world');
      expect(msgs[msgs.length - 1].sender).toBe('testuser');
    });
  });

  describe('toggleChannelsEnabled', () => {
    it('切换开关状态', async () => {
      mockState.channelsEnabled = true;

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ channels: [] }),
      } as Response);

      const { toggleChannelsEnabled } = await import('../../stores/channel-actions');
      const result = await toggleChannelsEnabled();

      expect(result).toBe(false); // toggled from true to false
      // 状态通过后端 /api/channels/toggle 持久化，不再用 localStorage
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/channels/toggle'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });
});
