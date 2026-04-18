export interface BridgeIncomingMessage {
  platform: string;
  sessionKey: string;
  direction: string;
  sender: string;
  text: string;
  isGroup: boolean;
  ts: number;
  agentId?: string;
}

export interface BridgeSlice {
  /** 最新收到的 bridge 消息（ws-message-handler 写入，BridgePanel 订阅） */
  bridgeLatestMessage: BridgeIncomingMessage | null;
  /** 递增计数器，每次 bridge_status 事件 +1，代替 loadStatus 回调 */
  bridgeStatusTrigger: number;
  /** 写入一条 bridge 消息 */
  addBridgeMessage: (msg: BridgeIncomingMessage) => void;
  /** 触发 bridge 状态重载 */
  triggerBridgeReload: () => void;
}

export const createBridgeSlice = (
  set: (partial: Partial<BridgeSlice> | ((s: BridgeSlice) => Partial<BridgeSlice>)) => void,
): BridgeSlice => ({
  bridgeLatestMessage: null,
  bridgeStatusTrigger: 0,
  addBridgeMessage: (msg) => set({ bridgeLatestMessage: msg }),
  triggerBridgeReload: () =>
    set((s) => ({ bridgeStatusTrigger: s.bridgeStatusTrigger + 1 })),
});
