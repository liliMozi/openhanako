import { describe, expect, it, vi } from "vitest";
import { wrapWithSessionPermission } from "../lib/tools/session-permission-wrapper.js";

const ctx = {
  sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
};

function makeTool(name = "write") {
  return {
    name,
    execute: vi.fn(async () => ({
      content: [{ type: "text", text: "executed" }],
      details: { executed: true },
    })),
  };
}

describe("session permission wrapper", () => {
  it("blocks side-effect tools in read-only mode", async () => {
    const tool = makeTool("write");
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "read_only",
    });

    const result = await wrapped.execute("call-1", { path: "x" }, null, null, ctx);

    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.errorCode).toBe("ACTION_BLOCKED_BY_READ_ONLY");
  });

  it("asks before running side-effect tools in ask mode", async () => {
    const tool = makeTool("write");
    const emitted = [];
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm-tool-1",
        promise: Promise.resolve({ action: "confirmed" }),
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "ask",
      getConfirmStore: () => confirmStore,
      emitEvent: (event, sessionPath) => emitted.push({ event, sessionPath }),
    });

    const result = await wrapped.execute("call-1", { path: "x" }, null, null, ctx);

    expect(confirmStore.create).toHaveBeenCalledWith(
      "tool_action_approval",
      expect.objectContaining({ toolName: "write" }),
      "/tmp/session.jsonl",
    );
    expect(emitted[0]).toMatchObject({
      sessionPath: "/tmp/session.jsonl",
      event: {
        type: "session_confirmation",
        request: {
          type: "session_confirmation",
          kind: "tool_action_approval",
          status: "pending",
        },
      },
    });
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("does not run side-effect tools when ask mode is rejected", async () => {
    const tool = makeTool("write");
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm-tool-1",
        promise: Promise.resolve({ action: "rejected" }),
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "ask",
      getConfirmStore: () => confirmStore,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { path: "x" }, null, null, ctx);

    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.confirmed).toBe(false);
  });
});
