import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockContactUserGet = vi.fn();
const mockImageGet = vi.fn();
const mockMessageResourceGet = vi.fn();
const mockMessageCreate = vi.fn();
const mockMessageUpdate = vi.fn();
const mockImageCreate = vi.fn();
const mockFileCreate = vi.fn();
const mockWsStart = vi.fn();

let registeredHandlers = {};

vi.mock("@larksuiteoapi/node-sdk", () => {
  class MockEventDispatcher {
    register(handlers) {
      registeredHandlers = handlers;
      return this;
    }
  }

  class MockWSClient {
    constructor() {
      this.wsConfig = { wsInstance: { readyState: 1 } };
    }

    start(...args) {
      return mockWsStart(...args);
    }

    close() {}
  }

  class MockClient {
    constructor() {
      this.contact = {
        user: {
          get: mockContactUserGet,
        },
      };
      this.im = {
        image: {
          get: mockImageGet,
          create: mockImageCreate,
        },
        file: {
          create: mockFileCreate,
        },
        messageResource: {
          get: mockMessageResourceGet,
        },
        message: {
          create: mockMessageCreate,
          update: mockMessageUpdate,
        },
      };
    }
  }

  return {
    Client: MockClient,
    EventDispatcher: MockEventDispatcher,
    WSClient: MockWSClient,
    LoggerLevel: { warn: "warn" },
  };
});

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
}));

import { createFeishuAdapter } from "../lib/bridge/feishu-adapter.js";

describe("createFeishuAdapter", () => {
  beforeEach(() => {
    registeredHandlers = {};
    mockContactUserGet.mockReset();
    mockImageGet.mockReset();
    mockMessageResourceGet.mockReset();
    mockMessageCreate.mockReset();
    mockMessageUpdate.mockReset();
    mockImageCreate.mockReset();
    mockFileCreate.mockReset();
    mockWsStart.mockReset();

    mockWsStart.mockResolvedValue(undefined);
    mockContactUserGet.mockResolvedValue({
      data: {
        user: {
          nickname: "TestUser",
          avatar: { avatar_240: "https://example.com/avatar.png" },
        },
      },
    });
  });

  it("keeps message_id on inbound image attachments", async () => {
    const onMessage = vi.fn();

    createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage,
    });

    await registeredHandlers["im.message.receive_v1"]({
      message: {
        message_id: "om_fake_msg_001",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_fake_key_001" }),
        chat_id: "oc_fake_chat_001",
        chat_type: "p2p",
      },
      sender: {
        sender_type: "user",
        sender_id: {
          open_id: "ou_123",
          user_id: "ou_123",
        },
      },
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      platform: "feishu",
      sessionKey: "fs_dm_ou_123@hana",
      attachments: [
        expect.objectContaining({
          type: "image",
          platformRef: "img_fake_key_001",
          _messageId: "om_fake_msg_001",
        }),
      ],
    }));
  });

  it("downloads inbound images via message resource API", async () => {
    const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockMessageResourceGet.mockResolvedValue(Readable.from([imageBuffer]));
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    const buffer = await adapter.downloadImage(
      "img_fake_key_001",
      "om_fake_msg_001",
    );

    expect(buffer).toEqual(imageBuffer);
    expect(mockMessageResourceGet).toHaveBeenCalledWith({
      path: {
        message_id: "om_fake_msg_001",
        file_key: "img_fake_key_001",
      },
      params: { type: "image" },
    });
    expect(mockImageGet).not.toHaveBeenCalled();
  });

  it("uploads image buffers and sends image_key messages", async () => {
    mockImageCreate.mockResolvedValue({ data: { image_key: "img_key_001" } });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    await adapter.sendMediaBuffer("oc_chat", buffer, {
      mime: "image/png",
      filename: "image.png",
    });

    expect(mockImageCreate).toHaveBeenCalledWith({
      data: { image_type: "message", image: buffer },
    });
    expect(mockMessageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat",
        msg_type: "image",
        content: JSON.stringify({ image_key: "img_key_001" }),
      },
    });
  });

  it("uploads document buffers and sends file_key messages", async () => {
    mockFileCreate.mockResolvedValue({ data: { file_key: "file_key_001" } });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });
    const buffer = Buffer.from("hello");

    await adapter.sendMediaBuffer("oc_chat", buffer, {
      mime: "text/plain",
      filename: "note.txt",
    });

    expect(mockFileCreate).toHaveBeenCalledWith({
      data: {
        file_type: "stream",
        file_name: "note.txt",
        file: buffer,
      },
    });
    expect(mockMessageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat",
        msg_type: "file",
        content: JSON.stringify({ file_key: "file_key_001" }),
      },
    });
  });

  it("declares Feishu edit-message streaming and updates the same text message", async () => {
    mockMessageCreate.mockResolvedValue({ data: { message_id: "om_stream_001" } });
    const adapter = createFeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    expect(adapter.streamingCapabilities).toMatchObject({
      mode: "edit_message",
      scopes: ["dm"],
      maxChars: 150_000,
    });

    const state = await adapter.startStreamReply("oc_chat", "first");
    await adapter.updateStreamReply("oc_chat", state, "second");
    await adapter.finishStreamReply("oc_chat", state, "final");

    expect(state).toEqual({ messageId: "om_stream_001" });
    expect(mockMessageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat",
        msg_type: "text",
        content: JSON.stringify({ text: "first" }),
      },
    });
    expect(mockMessageUpdate).toHaveBeenNthCalledWith(1, {
      path: { message_id: "om_stream_001" },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text: "second" }),
      },
    });
    expect(mockMessageUpdate).toHaveBeenNthCalledWith(2, {
      path: { message_id: "om_stream_001" },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text: "final" }),
      },
    });
  });
});
