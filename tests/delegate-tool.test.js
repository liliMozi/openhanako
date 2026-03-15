import { describe, expect, it, vi } from "vitest";
import { createDelegateTool } from "../lib/tools/delegate-tool.js";

describe("delegate-tool", () => {
  it("passes the expected filters to isolated execution", async () => {
    const executeIsolated = vi.fn().mockResolvedValue({
      replyText: "done",
      error: null,
    });

    const tool = createDelegateTool({
      executeIsolated,
      resolveUtilityModel: () => "utility-model",
      readOnlyBuiltinTools: ["read", "grep", "find", "ls"],
    });

    const result = await tool.execute("call_1", { task: "查一下项目状态" });

    expect(executeIsolated).toHaveBeenCalledWith(
      expect.stringContaining("任务：\n查一下项目状态"),
      expect.objectContaining({
        model: "utility-model",
        toolFilter: ["search_memory", "recall_experience", "web_search", "web_fetch"],
        builtinFilter: ["read", "grep", "find", "ls"],
      }),
    );
    // signal 应该是一个 AbortSignal（含超时）
    const callOpts = executeIsolated.mock.calls[0][1];
    expect(callOpts.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({
      content: [{ type: "text", text: "done" }],
    });
  });

  it("rejects new work when the concurrency limit is reached", async () => {
    const releases = [];
    const executeIsolated = vi.fn().mockImplementation(() => new Promise((resolve) => {
      releases.push(resolve);
    }));

    const tool = createDelegateTool({
      executeIsolated,
      resolveUtilityModel: () => "utility-model",
      readOnlyBuiltinTools: ["read"],
    });

    const running = [
      tool.execute("call_1", { task: "任务 1" }),
      tool.execute("call_2", { task: "任务 2" }),
      tool.execute("call_3", { task: "任务 3" }),
    ];

    const blocked = await tool.execute("call_4", { task: "任务 4" });

    expect(blocked).toEqual({
      content: [{ type: "text", text: "当前已有 3 个子任务在运行，请等待完成后再发起新任务。" }],
    });

    for (const release of releases) {
      release({ replyText: "ok", error: null });
    }
    await Promise.all(running);
    expect(executeIsolated).toHaveBeenCalledTimes(3);
  });
});
