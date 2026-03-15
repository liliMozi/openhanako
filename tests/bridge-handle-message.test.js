/**
 * BridgeManager._handleMessage 测试
 *
 * 关键路径：
 * - 群聊：直接发送，不 debounce 不 abort（guest 快速回复）
 * - 私聊：debounce 2s 聚合 → 合并发送
 * - 私聊新消息到达：abort 正在进行的生成
 * - /stop 命令：abort + 清空 pending
 * - 处理锁：防止并发 flush
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock adapter imports (避免拉真实 SDK) ──

vi.mock("../lib/bridge/telegram-adapter.js", () => ({
  createTelegramAdapter: vi.fn(),
}));
vi.mock("../lib/bridge/feishu-adapter.js", () => ({
  createFeishuAdapter: vi.fn(),
}));
vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
}));

import { BridgeManager } from "../lib/bridge/bridge-manager.js";

// ── Helpers ──

/** 匹配 timeTag 前缀（[MM-DD HH:mm] ）后跟预期文本 */
const tagged = (text) => expect.stringMatching(new RegExp(`^\\[\\d{2}-\\d{2} \\d{2}:\\d{2}\\] ${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));

function createMocks() {
  const adapter = {
    sendReply: vi.fn().mockResolvedValue(),
    sendBlockReply: vi.fn().mockResolvedValue(),
    stop: vi.fn(),
  };

  const engine = {
    getPreferences: vi.fn().mockReturnValue({
      bridge: { owner: { telegram: "owner123" } },
    }),
    isBridgeSessionStreaming: vi.fn().mockReturnValue(false),
    abortBridgeSession: vi.fn().mockResolvedValue(false),
    steerBridgeSession: vi.fn().mockReturnValue(false),
    agentName: "TestAgent",
  };

  const hub = {
    send: vi.fn().mockResolvedValue("AI response"),
    eventBus: { emit: vi.fn() },
  };

  const bm = new BridgeManager({ engine, hub });
  // Inject mock adapter directly (bypass startPlatform)
  bm._platforms.set("telegram", { adapter, status: "connected" });
  // Disable block streaming for simpler assertions
  bm.blockStreaming = false;

  return { bm, adapter, engine, hub };
}

// ── Tests ──

describe("BridgeManager._handleMessage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Group messages ──

  describe("group fast path", () => {
    it("sends immediately without debounce", async () => {
      const { bm, hub, adapter } = createMocks();

      await bm._handleMessage("telegram", {
        sessionKey: "tg_group_g1",
        text: "hello",
        senderName: "Alice",
        userId: "user1",
        isGroup: true,
        chatId: "g1",
      });

      expect(hub.send).toHaveBeenCalledOnce();
      expect(hub.send).toHaveBeenCalledWith(
        tagged("Alice: hello"),
        expect.objectContaining({ sessionKey: "tg_group_g1", role: "guest", isGroup: true }),
      );
      expect(adapter.sendReply).toHaveBeenCalledWith("g1", "AI response");
    });

    it("prefixes sender name in group messages", async () => {
      const { bm, hub } = createMocks();

      await bm._handleMessage("telegram", {
        sessionKey: "tg_group_g1",
        text: "hi there",
        senderName: "Bob",
        userId: "user2",
        isGroup: true,
        chatId: "g1",
      });

      expect(hub.send).toHaveBeenCalledWith(tagged("Bob: hi there"), expect.any(Object));
    });
  });

  // ── DM debounce ──

  describe("DM debounce", () => {
    it("buffers messages and sends merged after 2s", async () => {
      const { bm, hub, adapter } = createMocks();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123",
        text: "hello",
        userId: "owner123",
        chatId: "owner123",
      });
      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123",
        text: "world",
        userId: "owner123",
        chatId: "owner123",
      });

      expect(hub.send).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2100);

      expect(hub.send).toHaveBeenCalledOnce();
      expect(hub.send).toHaveBeenCalledWith(
        expect.stringMatching(/^\[\d{2}-\d{2} \d{2}:\d{2}\] hello\nworld$/),
        expect.objectContaining({ sessionKey: "tg_dm_owner123", role: "owner" }),
      );
      expect(adapter.sendReply).toHaveBeenCalledWith("owner123", "AI response");
    });

    it("resets debounce timer on each new message", async () => {
      const { bm, hub } = createMocks();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123",
        text: "first",
        userId: "owner123",
        chatId: "owner123",
      });

      await vi.advanceTimersByTimeAsync(1500);
      expect(hub.send).not.toHaveBeenCalled();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123",
        text: "second",
        userId: "owner123",
        chatId: "owner123",
      });

      await vi.advanceTimersByTimeAsync(1500);
      expect(hub.send).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(600);
      expect(hub.send).toHaveBeenCalledOnce();
      expect(hub.send).toHaveBeenCalledWith(
        expect.stringMatching(/^\[\d{2}-\d{2} \d{2}:\d{2}\] first\nsecond$/),
        expect.any(Object),
      );
    });

    it("uses owner role for owner DMs", async () => {
      const { bm, hub } = createMocks();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123",
        text: "hi",
        userId: "owner123",
        chatId: "owner123",
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect(hub.send).toHaveBeenCalledWith(
        tagged("hi"),
        expect.objectContaining({ role: "owner" }),
      );
    });

    it("uses guest role for non-owner DMs", async () => {
      const { bm, hub } = createMocks();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_stranger",
        text: "hi",
        senderName: "Stranger",
        userId: "stranger",
        chatId: "stranger",
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect(hub.send).toHaveBeenCalledWith(
        tagged("Stranger: hi"),
        expect.objectContaining({ role: "guest" }),
      );
    });
  });

  // ── Abort ──

  describe("abort on new message", () => {
    it("uses steer (not abort) when session is streaming", async () => {
      const { bm, engine } = createMocks();
      engine.isBridgeSessionStreaming.mockReturnValue(true);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123",
        text: "new msg",
        userId: "owner123",
        chatId: "owner123",
      });

      // streaming 时 debounce 缩短到 1s（steer 路径），不 abort
      expect(engine.abortBridgeSession).not.toHaveBeenCalled();
    });

    it("does not steer if session is not streaming", async () => {
      const { bm, engine } = createMocks();
      engine.isBridgeSessionStreaming.mockReturnValue(false);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123",
        text: "new msg",
        userId: "owner123",
        chatId: "owner123",
      });

      expect(engine.abortBridgeSession).not.toHaveBeenCalled();
    });
  });

  // ── /stop command ──

  describe("/stop command", () => {
    it("aborts active session and clears pending buffer", async () => {
      const { bm, engine, hub } = createMocks();
      engine.abortBridgeSession.mockResolvedValue(true);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123",
        text: "hello",
        userId: "owner123",
        chatId: "owner123",
      });

      await bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123",
        text: "/stop",
        userId: "owner123",
        chatId: "owner123",
      });

      expect(engine.abortBridgeSession).toHaveBeenCalledWith("tg_dm_owner123");

      await vi.advanceTimersByTimeAsync(3000);
      expect(hub.send).not.toHaveBeenCalled();
    });

    it("non-owner /stop is treated as regular message", async () => {
      const { bm, engine, hub } = createMocks();
      engine.isBridgeSessionStreaming.mockReturnValue(false);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_stranger",
        text: "/stop",
        senderName: "Stranger",
        userId: "stranger",
        chatId: "stranger",
      });

      // non-owner: /stop 不触发 abort，走普通消息路径
      expect(engine.abortBridgeSession).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2100);
      expect(hub.send).toHaveBeenCalledOnce();
      expect(hub.send).toHaveBeenCalledWith(
        tagged("Stranger: /stop"),
        expect.objectContaining({ role: "guest" }),
      );
    });
  });

  // ── Processing lock ──

  describe("processing lock", () => {
    it("prevents concurrent _flushPending for same sessionKey", async () => {
      const { bm, hub } = createMocks();

      let resolveFirst;
      hub.send.mockImplementationOnce(() =>
        new Promise((r) => { resolveFirst = r; })
      );

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123",
        text: "msg1",
        userId: "owner123",
        chatId: "owner123",
      });
      await vi.advanceTimersByTimeAsync(2100);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123",
        text: "msg2",
        userId: "owner123",
        chatId: "owner123",
      });
      await vi.advanceTimersByTimeAsync(2100);

      expect(hub.send).toHaveBeenCalledOnce();

      resolveFirst("response 1");
      await vi.advanceTimersByTimeAsync(600);

      expect(hub.send).toHaveBeenCalledTimes(2);
      expect(hub.send).toHaveBeenLastCalledWith(tagged("msg2"), expect.any(Object));
    });
  });
});
