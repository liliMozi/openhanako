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
import { createSlashSystem } from "../core/slash-commands/index.js";

// ── Helpers ──

/** 匹配 timeTag 前缀（<t>MM-DD HH:mm</t> ）后跟预期文本 */
const tagged = (text) => expect.stringMatching(new RegExp(`^<t>\\d{2}-\\d{2} \\d{2}:\\d{2}</t> ${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));

function createMocks() {
  const adapter = {
    sendReply: vi.fn().mockResolvedValue(),
    sendBlockReply: vi.fn().mockResolvedValue(),
    sendTypingIndicator: vi.fn().mockResolvedValue(),
    stop: vi.fn(),
  };

  const engine = {
    getAgent: vi.fn().mockImplementation((id) => {
      if (id === "hana") return { agentName: "TestAgent", config: { bridge: { telegram: { owner: "owner123" } } }, sessionDir: os.tmpdir() };
      return null;
    }),
    getBridgeReceiptEnabled: vi.fn().mockReturnValue(true),
    isBridgeSessionStreaming: vi.fn().mockReturnValue(false),
    abortBridgeSession: vi.fn().mockResolvedValue(false),
    steerBridgeSession: vi.fn().mockReturnValue(false),
    bridgeSessionManager: {
      injectMessage: vi.fn(() => true),
      readIndex: () => ({}),
      writeIndex: () => {},
    },
    agentName: "TestAgent",
    hanakoHome: os.tmpdir(),
    currentAgentId: "hana",
  };

  const hub = {
    send: vi.fn().mockResolvedValue("AI response"),
    eventBus: { emit: vi.fn() },
  };

  // 注入真实 slashSystem（Phase 3 接入 bridge-manager 后必需）
  const slashSystem = createSlashSystem({ engine, hub });
  engine.slashDispatcher = slashSystem.dispatcher;
  engine.slashRegistry = slashSystem.registry;

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

      await vi.waitFor(() => expect(hub.send).toHaveBeenCalledOnce());
      expect(hub.send).toHaveBeenCalledWith(tagged("Bob: hi there"), expect.any(Object));
    });

    it("serializes group messages for the same sessionKey", async () => {
      const { bm, hub } = createMocks();

      let resolveFirst;
      hub.send.mockImplementationOnce(() =>
        new Promise((resolve) => { resolveFirst = resolve; })
      );

      await bm._handleMessage("telegram", {
        sessionKey: "tg_group_g1@hana",
        text: "first",
        senderName: "Alice",
        userId: "user1",
        isGroup: true,
        chatId: "g1",
        agentId: "hana",
      });
      await vi.waitFor(() => expect(hub.send).toHaveBeenCalledTimes(1));

      await bm._handleMessage("telegram", {
        sessionKey: "tg_group_g1@hana",
        text: "second",
        senderName: "Bob",
        userId: "user2",
        isGroup: true,
        chatId: "g1",
        agentId: "hana",
      });

      expect(hub.send).toHaveBeenCalledTimes(1);

      resolveFirst("response 1");
      await vi.waitFor(() => expect(hub.send).toHaveBeenCalledTimes(2));

      expect(hub.send).toHaveBeenNthCalledWith(
        1,
        tagged("Alice: first"),
        expect.objectContaining({ sessionKey: "tg_group_g1@hana", role: "guest", isGroup: true }),
      );
      expect(hub.send).toHaveBeenNthCalledWith(
        2,
        tagged("Bob: second"),
        expect.objectContaining({ sessionKey: "tg_group_g1@hana", role: "guest", isGroup: true }),
      );
    });
  });

  // ── DM debounce ──

  describe("DM debounce", () => {
    it("sends the pre-reply receipt prompt only when the LLM reply starts", async () => {
      const { bm, adapter } = createMocks();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hello",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      expect(adapter.sendReply).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2100);

      expect(adapter.sendReply).toHaveBeenNthCalledWith(1, "owner123", "（TestAgent正在输入...）");
      expect(adapter.sendReply).toHaveBeenLastCalledWith("owner123", "AI response");
    });

    it("does not send any pre-reply receipt prompt when globally disabled", async () => {
      const { bm, adapter, engine } = createMocks();
      engine.getBridgeReceiptEnabled.mockReturnValue(false);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hello",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      expect(adapter.sendReply).not.toHaveBeenCalledWith("owner123", "（TestAgent正在输入...）");
      expect(adapter.sendTypingIndicator).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2100);

      expect(adapter.sendReply).toHaveBeenCalledWith("owner123", "AI response");
      expect(adapter.sendTypingIndicator).not.toHaveBeenCalled();
    });

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
          inboundFiles: [expect.objectContaining({
            type: "image",
            filename: "image.png",
            mimeType: "image/png",
            buffer: expect.any(Buffer),
          })],
        }),
      );
    });

    it("reads wechat text file attachments through the platform-specific file downloader", async () => {
      const { bm, hub } = createMocks();
      const wechatAdapter = {
        sendReply: vi.fn().mockResolvedValue(),
        sendBlockReply: vi.fn().mockResolvedValue(),
        stop: vi.fn(),
        downloadFileByRef: vi.fn().mockResolvedValue(Buffer.from("hello from wechat txt", "utf-8")),
      };
      bm._platforms.set("wechat:hana", { adapter: wechatAdapter, status: "connected", agentId: "hana", platform: "wechat" });

      bm._handleMessage("wechat", {
        sessionKey: "wx_dm_owner123@hana",
        text: "",
        userId: "owner123",
        chatId: "wx_123",
        agentId: "hana",
        attachments: [{
          type: "file",
          filename: "notes.txt",
          platformRef: "{\"encrypt_query_param\":\"abc\",\"aes_key\":\"def\"}",
          size: 21,
        }],
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect(wechatAdapter.downloadFileByRef).toHaveBeenCalledWith("{\"encrypt_query_param\":\"abc\",\"aes_key\":\"def\"}");
      expect(hub.send).toHaveBeenCalledWith(
        expect.stringContaining("hello from wechat txt"),
        expect.objectContaining({
          sessionKey: "wx_dm_owner123@hana",
          inboundFiles: [expect.objectContaining({
            type: "file",
            filename: "notes.txt",
            mimeType: "text/plain",
            buffer: expect.any(Buffer),
          })],
        }),
      );
    });
  });

  describe("streaming delivery", () => {
    it("uses Telegram draft streaming for deltas and sends one final message", async () => {
      const { bm, hub, adapter, engine } = createMocks();
      engine.getBridgeReceiptEnabled.mockReturnValue(false);
      adapter.streamingCapabilities = {
        mode: "draft",
        scopes: ["dm"],
        minIntervalMs: 0,
        maxChars: 4096,
      };
      adapter.sendDraft = vi.fn().mockResolvedValue();
      hub.send.mockImplementation(async (_text, opts) => {
        opts.onDelta("Hel", "Hel");
        opts.onDelta("lo", "Hello");
        return "Hello";
      });

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);
      await vi.waitFor(() => expect(adapter.sendReply).toHaveBeenCalledWith("owner123", "Hello"));

      expect(adapter.sendDraft).toHaveBeenCalled();
      expect(adapter.sendBlockReply).not.toHaveBeenCalled();
      const draftIds = adapter.sendDraft.mock.calls.map(call => call[2]?.draftId);
      expect(new Set(draftIds).size).toBe(1);
    });

    it("updates one Feishu stream message instead of sending block replies", async () => {
      const { bm, hub, engine } = createMocks();
      engine.getBridgeReceiptEnabled.mockReturnValue(false);
      const feishuAdapter = {
        streamingCapabilities: {
          mode: "edit_message",
          scopes: ["dm"],
          minIntervalMs: 0,
          maxChars: 150_000,
        },
        startStreamReply: vi.fn().mockResolvedValue({ messageId: "om_stream_001" }),
        updateStreamReply: vi.fn().mockResolvedValue(),
        finishStreamReply: vi.fn().mockResolvedValue(),
        sendReply: vi.fn().mockResolvedValue(),
        sendBlockReply: vi.fn().mockResolvedValue(),
        stop: vi.fn(),
      };
      bm._platforms.set("feishu:hana", { adapter: feishuAdapter, status: "connected", agentId: "hana", platform: "feishu" });
      hub.send.mockImplementation(async (_text, opts) => {
        opts.onDelta("Hel", "Hel");
        opts.onDelta("lo", "Hello");
        return "Hello";
      });

      bm._handleMessage("feishu", {
        sessionKey: "fs_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "oc_chat",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);
      await vi.waitFor(() => expect(feishuAdapter.finishStreamReply).toHaveBeenCalledWith(
        "oc_chat",
        { messageId: "om_stream_001" },
        "Hello",
        expect.any(Object),
      ));

      expect(feishuAdapter.startStreamReply).toHaveBeenCalledWith("oc_chat", "Hel", expect.any(Object));
      expect(feishuAdapter.updateStreamReply).toHaveBeenCalledWith(
        "oc_chat",
        { messageId: "om_stream_001" },
        "Hello",
        expect.any(Object),
      );
      expect(feishuAdapter.sendBlockReply).not.toHaveBeenCalled();
      expect(feishuAdapter.sendReply).not.toHaveBeenCalledWith("oc_chat", "Hello");
    });

    it("does not use legacy block streaming without an explicit streaming capability", async () => {
      const { bm, hub, adapter, engine } = createMocks();
      engine.getBridgeReceiptEnabled.mockReturnValue(false);
      bm.blockStreaming = true;
      hub.send.mockImplementation(async (_text, opts) => {
        expect(opts.onDelta).toBeUndefined();
        return "final only";
      });

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect(adapter.sendBlockReply).not.toHaveBeenCalled();
      expect(adapter.sendReply).toHaveBeenCalledWith("owner123", "final only");
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

    it("non-owner /slash-like text flows to LLM as plain text (Phase 2-F: guest slash not eaten by dispatcher)", async () => {
      // 新 spec：guest 发的 /stop 不再被 dispatcher 静默吞掉——直接当文本进 LLM，
      // agent 可以正常回应。这样群里的其他人发 /xxx 不会像消息消失一样。
      const { bm, engine, hub, adapter } = createMocks();
      engine.isBridgeSessionStreaming.mockReturnValue(false);

      await bm._handleMessage("telegram", {
        sessionKey: "tg_dm_stranger@hana",
        text: "/stop",
        senderName: "Stranger",
        userId: "stranger",  // 非 owner（config.bridge.telegram.owner === "owner123"）
        chatId: "stranger",
        agentId: "hana",
      });

      // abort 不应被调用（不是真正的斜杠命令路径）
      expect(engine.abortBridgeSession).not.toHaveBeenCalled();
      // 2s debounce 后，消息进 LLM
      await vi.advanceTimersByTimeAsync(2100);
      expect(hub.send).toHaveBeenCalledOnce();
      // hub.send 的 text 参数包含 "/stop" 原文（会带 timeTag 前缀和 sender prefix）
      expect(hub.send.mock.calls[0][0]).toContain("/stop");
      // agent 的回复送回 adapter
      await vi.waitFor(() => expect(adapter.sendReply).toHaveBeenCalled());
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
