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

import os from "os";
import { BridgeManager } from "../lib/bridge/bridge-manager.js";

// ── Helpers ──

/** 匹配 timeTag 前缀（<t>MM-DD HH:mm</t> ）后跟预期文本 */
const tagged = (text) => expect.stringMatching(new RegExp(`^<t>\\d{2}-\\d{2} \\d{2}:\\d{2}</t> ${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));

function createMocks() {
  const adapter = {
    sendReply: vi.fn().mockResolvedValue(),
    sendBlockReply: vi.fn().mockResolvedValue(),
    stop: vi.fn(),
  };

  const engine = {
    getAgent: vi.fn().mockImplementation((id) => {
      if (id === "hana") return { agentName: "TestAgent", config: { bridge: { telegram: { owner: "owner123" } } } };
      return null;
    }),
    isBridgeSessionStreaming: vi.fn().mockReturnValue(false),
    abortBridgeSession: vi.fn().mockResolvedValue(false),
    steerBridgeSession: vi.fn().mockReturnValue(false),
    agentName: "TestAgent",
    hanakoHome: os.tmpdir(),
    currentAgentId: "hana",
  };

  const hub = {
    send: vi.fn().mockResolvedValue("AI response"),
    eventBus: { emit: vi.fn() },
  };

  const bm = new BridgeManager({ engine, hub });
  // Inject mock adapter directly (bypass startPlatform) — use composite key
  bm._platforms.set("telegram:hana", { adapter, status: "connected", agentId: "hana", platform: "telegram" });
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

      // _flushGroupMessage is fire-and-forget (not awaited), wait for it
      const promise = bm._handleMessage("telegram", {
        sessionKey: "tg_group_g1@hana",
        text: "hello",
        senderName: "Alice",
        userId: "user1",
        isGroup: true,
        chatId: "g1",
        agentId: "hana",
      });
      await promise;
      // flush the unresolved group message promise
      await vi.waitFor(() => expect(hub.send).toHaveBeenCalledOnce());

      expect(hub.send).toHaveBeenCalledWith(
        tagged("Alice: hello"),
        expect.objectContaining({ sessionKey: "tg_group_g1@hana", role: "guest", isGroup: true }),
      );
      await vi.waitFor(() => expect(adapter.sendReply).toHaveBeenCalled());
      expect(adapter.sendReply).toHaveBeenCalledWith("g1", "AI response");
    });

    it("prefixes sender name in group messages", async () => {
      const { bm, hub } = createMocks();

      await bm._handleMessage("telegram", {
        sessionKey: "tg_group_g1@hana",
        text: "hi there",
        senderName: "Bob",
        userId: "user2",
        isGroup: true,
        chatId: "g1",
        agentId: "hana",
      });

      expect(hub.send).toHaveBeenCalledWith(tagged("Bob: hi there"), expect.any(Object));
    });
  });

  // ── DM debounce ──

  describe("DM debounce", () => {
    it("buffers messages and sends merged after 2s", async () => {
      const { bm, hub, adapter } = createMocks();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hello",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });
      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "world",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      expect(hub.send).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2100);

      expect(hub.send).toHaveBeenCalledOnce();
      expect(hub.send).toHaveBeenCalledWith(
        expect.stringMatching(/^<t>\d{2}-\d{2} \d{2}:\d{2}<\/t> hello\nworld$/),
        expect.objectContaining({ sessionKey: "tg_dm_owner123@hana", role: "owner" }),
      );
      expect(adapter.sendReply).toHaveBeenCalledWith("owner123", "AI response");
    });

    it("resets debounce timer on each new message", async () => {
      const { bm, hub } = createMocks();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "first",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(1500);
      expect(hub.send).not.toHaveBeenCalled();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "second",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(1500);
      expect(hub.send).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(600);
      expect(hub.send).toHaveBeenCalledOnce();
      expect(hub.send).toHaveBeenCalledWith(
        expect.stringMatching(/^<t>\d{2}-\d{2} \d{2}:\d{2}<\/t> first\nsecond$/),
        expect.any(Object),
      );
    });

    it("uses owner role for owner DMs", async () => {
      const { bm, hub } = createMocks();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
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
        sessionKey: "tg_dm_stranger@hana",
        text: "hi",
        senderName: "Stranger",
        userId: "stranger",
        chatId: "stranger",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect(hub.send).toHaveBeenCalledWith(
        tagged("Stranger: hi"),
        expect.objectContaining({ role: "guest" }),
      );
    });

    it("passes message_id when downloading feishu image attachments", async () => {
      const { bm, hub } = createMocks();
      const feishuAdapter = {
        sendReply: vi.fn().mockResolvedValue(),
        sendBlockReply: vi.fn().mockResolvedValue(),
        stop: vi.fn(),
        downloadImage: vi.fn().mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      };
      bm._platforms.set("feishu:hana", { adapter: feishuAdapter, status: "connected", agentId: "hana", platform: "feishu" });

      bm._handleMessage("feishu", {
        sessionKey: "fs_dm_owner123@hana",
        text: "",
        userId: "stranger",
        senderName: "Stranger",
        chatId: "oc_123",
        agentId: "hana",
        attachments: [{
          type: "image",
          platformRef: "img_123",
          _messageId: "om_123",
          mimeType: "image/jpeg",
        }],
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect(feishuAdapter.downloadImage).toHaveBeenCalledWith("img_123", "om_123");
      expect(hub.send).toHaveBeenCalledWith(
        tagged("Stranger: "),
        expect.objectContaining({
          images: [expect.objectContaining({ mimeType: "image/png" })],
        }),
      );
    });
  });

  // ── Abort ──

  describe("abort on new message", () => {
    it("uses steer (not abort) when session is streaming", async () => {
      const { bm, engine } = createMocks();
      engine.isBridgeSessionStreaming.mockReturnValue(true);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "new msg",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      // streaming 时 debounce 缩短到 1s（steer 路径），不 abort
      expect(engine.abortBridgeSession).not.toHaveBeenCalled();
    });

    it("does not steer if session is not streaming", async () => {
      const { bm, engine } = createMocks();
      engine.isBridgeSessionStreaming.mockReturnValue(false);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "new msg",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
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
        sessionKey: "tg_dm_owner123@hana",
        text: "hello",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      await bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "/stop",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      expect(engine.abortBridgeSession).toHaveBeenCalledWith("tg_dm_owner123@hana");

      await vi.advanceTimersByTimeAsync(3000);
      expect(hub.send).not.toHaveBeenCalled();
    });

    it("non-owner /stop is treated as regular message", async () => {
      const { bm, engine, hub } = createMocks();
      engine.isBridgeSessionStreaming.mockReturnValue(false);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_stranger@hana",
        text: "/stop",
        senderName: "Stranger",
        userId: "stranger",
        chatId: "stranger",
        agentId: "hana",
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

  // ── Agent isolation ──

  describe("agent isolation via sessionKey", () => {
    it("same userId with different agentId produces different sessionKeys", async () => {
      const { bm, hub, engine } = createMocks();
      // Register a second agent adapter
      const kuroAdapter = { sendReply: vi.fn().mockResolvedValue(), sendBlockReply: vi.fn().mockResolvedValue(), stop: vi.fn() };
      bm._platforms.set("telegram:kuro", { adapter: kuroAdapter, status: "connected", agentId: "kuro", platform: "telegram" });
      engine.getAgent.mockImplementation((id) => {
        if (id === "hana") return { agentName: "TestAgent", config: { bridge: { telegram: { owner: "owner123" } } } };
        if (id === "kuro") return { agentName: "Kuro", config: { bridge: { telegram: { owner: "owner123" } } } };
        return null;
      });

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "msg to hana",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@kuro",
        text: "msg to kuro",
        userId: "owner123",
        chatId: "owner123",
        agentId: "kuro",
      });

      await vi.advanceTimersByTimeAsync(2100);

      // Both messages should have been sent with their respective sessionKeys
      expect(hub.send).toHaveBeenCalledTimes(2);
      expect(hub.send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ sessionKey: "tg_dm_owner123@hana" }),
      );
      expect(hub.send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ sessionKey: "tg_dm_owner123@kuro" }),
      );
    });

    it("messages are properly isolated between agents (debounce per sessionKey)", async () => {
      const { bm, hub, engine } = createMocks();
      // Register a second agent adapter
      const kuroAdapter = { sendReply: vi.fn().mockResolvedValue(), sendBlockReply: vi.fn().mockResolvedValue(), stop: vi.fn() };
      bm._platforms.set("telegram:kuro", { adapter: kuroAdapter, status: "connected", agentId: "kuro", platform: "telegram" });
      engine.getAgent.mockImplementation((id) => {
        if (id === "hana") return { agentName: "TestAgent", config: { bridge: { telegram: { owner: "owner123" } } } };
        if (id === "kuro") return { agentName: "Kuro", config: { bridge: { telegram: { owner: "owner123" } } } };
        return null;
      });

      // Send two messages with different agentIds — they should NOT merge
      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hello hana",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });
      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@kuro",
        text: "hello kuro",
        userId: "owner123",
        chatId: "owner123",
        agentId: "kuro",
      });

      await vi.advanceTimersByTimeAsync(2100);

      // Each agent gets its own message, not merged
      expect(hub.send).toHaveBeenCalledTimes(2);
      const calls = hub.send.mock.calls;
      const hanaCall = calls.find(c => c[1].sessionKey === "tg_dm_owner123@hana");
      const kuroCall = calls.find(c => c[1].sessionKey === "tg_dm_owner123@kuro");
      expect(hanaCall[0]).toMatch(/hello hana/);
      expect(kuroCall[0]).toMatch(/hello kuro/);
      // Neither message contains the other agent's text
      expect(hanaCall[0]).not.toMatch(/hello kuro/);
      expect(kuroCall[0]).not.toMatch(/hello hana/);
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
        sessionKey: "tg_dm_owner123@hana",
        text: "msg1",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });
      await vi.advanceTimersByTimeAsync(2100);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "msg2",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
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
