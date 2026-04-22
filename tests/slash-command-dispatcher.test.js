import { describe, it, expect, beforeEach, vi } from "vitest";
import { SlashCommandRegistry } from "../core/slash-command-registry.js";
import { SlashCommandDispatcher } from "../core/slash-command-dispatcher.js";

function makeCtx(overrides = {}) {
  return {
    sessionRef: { kind: "bridge", agentId: "a1", sessionKey: "tg_dm_x@a1" },
    source: "tg",
    senderId: "u1",
    senderName: "Alice",
    isOwner: true,
    reply: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("SlashCommandDispatcher.parse", () => {
  const d = new SlashCommandDispatcher({ registry: new SlashCommandRegistry() });
  it("parses /cmd", () => { expect(d.parse("/stop")).toEqual({ commandName: "stop", args: "" }); });
  it("parses /cmd args with spaces and newlines", () => {
    expect(d.parse("/compact keep key facts\nabout project")).toEqual({ commandName: "compact", args: "keep key facts\nabout project" });
  });
  it("returns null for non-slash", () => { expect(d.parse("hello")).toBeNull(); });
  it("returns null for bare slash", () => { expect(d.parse("/")).toBeNull(); });
  it("accepts hyphen and uppercase in name", () => {
    expect(d.parse("/Bot-Ping")).toEqual({ commandName: "Bot-Ping", args: "" });
  });
});

describe("SlashCommandDispatcher.tryDispatch", () => {
  let r, d;
  beforeEach(() => {
    r = new SlashCommandRegistry();
    d = new SlashCommandDispatcher({ registry: r, engine: {}, hub: {}, sessionOps: {} });
  });

  it("returns handled=false when text is not a command", async () => {
    const res = await d.tryDispatch("hello", makeCtx());
    expect(res.handled).toBe(false);
  });

  it("returns handled=false when command is not registered", async () => {
    const res = await d.tryDispatch("/unknown", makeCtx());
    expect(res.handled).toBe(false);
  });

  it("silently rejects when permission insufficient (owner cmd from guest)", async () => {
    const handler = vi.fn();
    r.registerCommand({ name: "stop", permission: "owner", handler });
    const ctx = makeCtx({ isOwner: false });
    const res = await d.tryDispatch("/stop", ctx);
    expect(res.handled).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("executes handler and uses CommandResult.reply", async () => {
    r.registerCommand({ name: "ping", permission: "anyone", handler: async () => ({ reply: "pong" }) });
    const ctx = makeCtx();
    const res = await d.tryDispatch("/ping", ctx);
    expect(res.handled).toBe(true);
    expect(ctx.reply).toHaveBeenCalledWith("pong");
  });

  it("wraps handler exception in [命令错误]", async () => {
    r.registerCommand({
      name: "boom", permission: "anyone",
      handler: async () => { throw new Error("kaboom"); },
      usage: "/boom",
    });
    const ctx = makeCtx();
    await d.tryDispatch("/boom", ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("[命令错误] kaboom"));
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("用法：/boom"));
  });

  it("skips reply when result.silent is true", async () => {
    r.registerCommand({ name: "mute", permission: "anyone", handler: async () => ({ silent: true, reply: "ignored" }) });
    const ctx = makeCtx();
    await d.tryDispatch("/mute", ctx);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("uses [命令错误] prefix when result.error present", async () => {
    r.registerCommand({ name: "bad", permission: "anyone", handler: async () => ({ error: "无效参数" }) });
    const ctx = makeCtx();
    await d.tryDispatch("/bad", ctx);
    expect(ctx.reply).toHaveBeenCalledWith("[命令错误] 无效参数");
  });

  it("grants admin role for desktop source", async () => {
    r.registerCommand({ name: "adminonly", permission: "admin", handler: async () => ({ reply: "ok" }) });
    const ctx = makeCtx({ source: "desktop", sessionRef: { kind: "desktop", sessionPath: "/x", agentId: "a1" } });
    await d.tryDispatch("/adminonly", ctx);
    expect(ctx.reply).toHaveBeenCalledWith("ok");
  });

  it("freezes handler ctx (discipline #4)", async () => {
    let seen;
    r.registerCommand({ name: "peek", permission: "anyone", handler: async (c) => { seen = c; return { reply: "ok" }; } });
    await d.tryDispatch("/peek", makeCtx());
    expect(Object.isFrozen(seen)).toBe(true);
  });

  it("times out handlers exceeding timeoutMs (discipline #5, fake timers)", async () => {
    vi.useFakeTimers();
    try {
      const fast = new SlashCommandDispatcher({ registry: r, hub: {}, timeoutMs: 50 });
      r.registerCommand({ name: "slow", permission: "anyone", handler: async () => new Promise(() => {}) });
      const ctx = makeCtx();
      const pending = fast.tryDispatch("/slow", ctx);
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/\[命令错误\].*超时/));
    } finally {
      vi.useRealTimers();
    }
  });

  it("injects hub via setHub setter (M3)", async () => {
    const r2 = new SlashCommandRegistry();
    const later = new SlashCommandDispatcher({ registry: r2 });
    const hub = { send: vi.fn() };
    later.setHub(hub);
    let seen;
    r2.registerCommand({ name: "useh", permission: "anyone", handler: async (c) => { seen = c.hub; return { silent: true }; } });
    await later.tryDispatch("/useh", makeCtx());
    expect(seen).toBe(hub);
  });

  it("throws when tryDispatch is called before hub injection (I4 guard)", async () => {
    const r2 = new SlashCommandRegistry();
    const noHub = new SlashCommandDispatcher({ registry: r2 });
    r2.registerCommand({ name: "nohubcmd", permission: "anyone", handler: async () => ({ reply: "ok" }) });
    await expect(noHub.tryDispatch("/nohubcmd", makeCtx())).rejects.toThrow(/hub not injected/);
  });

  it("tolerates handler returning null (M4)", async () => {
    r.registerCommand({ name: "ret_null", permission: "anyone", handler: async () => null });
    const ctx = makeCtx();
    const res = await d.tryDispatch("/ret_null", ctx);
    expect(res.handled).toBe(true);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("tolerates handler returning undefined (M4)", async () => {
    r.registerCommand({ name: "ret_undef", permission: "anyone", handler: async () => undefined });
    const ctx = makeCtx();
    const res = await d.tryDispatch("/ret_undef", ctx);
    expect(res.handled).toBe(true);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("tolerates handler returning empty object (M4)", async () => {
    r.registerCommand({ name: "ret_empty", permission: "anyone", handler: async () => ({}) });
    const ctx = makeCtx();
    const res = await d.tryDispatch("/ret_empty", ctx);
    expect(res.handled).toBe(true);
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
