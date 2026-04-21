import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockContactUserGet = vi.fn();
const mockImageGet = vi.fn();
const mockMessageResourceGet = vi.fn();
const mockMessageCreate = vi.fn();
const mockImageCreate = vi.fn();
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
        messageResource: {
          get: mockMessageResourceGet,
        },
        message: {
          create: mockMessageCreate,
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
    mockImageCreate.mockReset();
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
});
