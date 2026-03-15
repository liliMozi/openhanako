import type { Channel, ChannelMessage } from '../types';

export interface ChannelSlice {
  channels: Channel[];
  currentChannel: string | null;
  channelMessages: ChannelMessage[];
  channelTotalUnread: number;
  setChannels: (channels: Channel[]) => void;
  setCurrentChannel: (channel: string | null) => void;
  setChannelMessages: (messages: ChannelMessage[]) => void;
  setChannelTotalUnread: (count: number) => void;
}

export const createChannelSlice = (
  set: (partial: Partial<ChannelSlice>) => void
): ChannelSlice => ({
  channels: [],
  currentChannel: null,
  channelMessages: [],
  channelTotalUnread: 0,
  setChannels: (channels) => set({ channels }),
  setCurrentChannel: (channel) => set({ currentChannel: channel }),
  setChannelMessages: (messages) => set({ channelMessages: messages }),
  setChannelTotalUnread: (count) => set({ channelTotalUnread: count }),
});
