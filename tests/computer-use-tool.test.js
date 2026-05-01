import { describe, expect, it, vi } from "vitest";
import { ComputerHost } from "../core/computer-use/computer-host.js";
import { ComputerProviderRegistry } from "../core/computer-use/provider-registry.js";
import { createMockComputerProvider } from "../core/computer-use/providers/mock-provider.js";
import { createComputerUseTool } from "../lib/tools/computer-use-tool.js";
import { COMPUTER_USE_ERRORS } from "../core/computer-use/errors.js";
import { approveComputerUseApp } from "../core/computer-use/settings.js";

function makeTool(
  model = { id: "gpt-5.5", provider: "openai", input: ["text", "image"] },
  { enabled = true } = {},
) {
  const providers = new ComputerProviderRegistry();
  providers.register(createMockComputerProvider({ providerId: "mock" }));
  const host = new ComputerHost({
    providers,
    defaultProviderId: "mock",
    getSettings: () => ({ enabled: true }),
  });
  const emitted = [];
  const tool = createComputerUseTool({
    getComputerHost: () => host,
    getSessionModel: () => model,
    getAgentId: () => "hana",
    isAgentToolEnabled: () => enabled,
    emitEvent: (event, sessionPath) => emitted.push({ event, sessionPath }),
  });
  const ctx = {
    sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
    agentId: "hana",
    model,
  };
  return { tool, ctx, emitted };
}

function makeForegroundTool() {
  const provider = createMockComputerProvider({ providerId: "windows:uia" });
  provider.capabilities.pointClick = "foreground";
  provider.createLease = async (_ctx, target) => ({
    appId: target?.appId || "pid:12",
    windowId: target?.windowId || "123",
    allowedActions: ["click_point", "stop"],
    providerState: {},
  });
  const providers = new ComputerProviderRegistry();
  providers.register(provider);
  const host = new ComputerHost({
    providers,
    defaultProviderId: "windows:uia",
    getSettings: () => ({ enabled: true }),
  });
  const emitted = [];
  const tool = createComputerUseTool({
    getComputerHost: () => host,
    getSessionModel: () => ({ id: "gpt-5.5", provider: "openai", input: ["text", "image"] }),
    getAgentId: () => "hana",
    isAgentToolEnabled: () => true,
    emitEvent: (event, sessionPath) => emitted.push({ event, sessionPath }),
  });
  const ctx = {
    sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
    agentId: "hana",
    model: { id: "gpt-5.5", provider: "openai", input: ["text", "image"] },
  };
  return { tool, ctx, emitted };
}

function makeNativeCursorTool() {
  const provider = createMockComputerProvider({ providerId: "macos:cua" });
  provider.capabilities.nativeCursor = true;
  const providers = new ComputerProviderRegistry();
  providers.register(provider);
  const host = new ComputerHost({
    providers,
    defaultProviderId: "macos:cua",
    getSettings: () => ({ enabled: true }),
  });
  const emitted = [];
  const tool = createComputerUseTool({
    getComputerHost: () => host,
    getSessionModel: () => ({ id: "gpt-5.5", provider: "openai", input: ["text", "image"] }),
    getAgentId: () => "hana",
    isAgentToolEnabled: () => true,
    emitEvent: (event, sessionPath) => emitted.push({ event, sessionPath }),
  });
  const ctx = {
    sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
    agentId: "hana",
    model: { id: "gpt-5.5", provider: "openai", input: ["text", "image"] },
  };
  return { tool, ctx, emitted };
}

function makeCoordinateOnlyTool() {
  const provider = createMockComputerProvider({ providerId: "macos:cua" });
  provider.createLease = async (_ctx, target) => ({
    providerId: "macos:cua",
    appId: target?.appId || "app.notes",
    windowId: target?.windowId || "win-1",
    allowedActions: ["click_point", "double_click", "type_text", "press_key", "scroll", "drag", "stop"],
    providerState: {},
  });
  const providers = new ComputerProviderRegistry();
  providers.register(provider);
  const host = new ComputerHost({
    providers,
    defaultProviderId: "macos:cua",
    getSettings: () => ({ enabled: true }),
  });
  const emitted = [];
  const tool = createComputerUseTool({
    getComputerHost: () => host,
    getSessionModel: () => ({ id: "gpt-5.5", provider: "openai", input: ["text", "image"] }),
    getAgentId: () => "hana",
    isAgentToolEnabled: () => true,
    emitEvent: (event, sessionPath) => emitted.push({ event, sessionPath }),
  });
  const ctx = {
    sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
    agentId: "hana",
    model: { id: "gpt-5.5", provider: "openai", input: ["text", "image"] },
  };
  return { tool, ctx, emitted };
}

function makeApprovalTool(confirmAction = "confirmed") {
  const provider = createMockComputerProvider({ providerId: "mock" });
  provider.capabilities.isolated = false;
  const providers = new ComputerProviderRegistry();
  providers.register(provider);
  let settings = { enabled: true, app_approvals: [] };
  const host = new ComputerHost({
    providers,
    defaultProviderId: "mock",
    getSettings: () => settings,
  });
  const emitted = [];
  const approve = vi.fn((approval) => {
    settings = approveComputerUseApp(settings, approval, {
      now: () => "2026-05-01T00:00:00.000Z",
    });
    return settings;
  });
  const confirmStore = {
    create: vi.fn((_kind, _payload, _sessionPath) => ({
      confirmId: "confirm-computer-1",
      promise: Promise.resolve({ action: confirmAction }),
    })),
  };
  const model = { id: "gpt-5.5", provider: "openai", input: ["text", "image"] };
  const tool = createComputerUseTool({
    getComputerHost: () => host,
    getSessionModel: () => model,
    getAgentId: () => "hana",
    getConfirmStore: () => confirmStore,
    approveComputerUseApp: approve,
    isAgentToolEnabled: () => true,
    emitEvent: (event, sessionPath) => emitted.push({ event, sessionPath }),
  });
  const ctx = {
    sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
    agentId: "hana",
    model,
  };
  return { tool, ctx, emitted, confirmStore, approve };
}

describe("computer tool", () => {
  it("creates a lease and reads app state", async () => {
    const { tool, ctx } = makeTool();
    const started = await tool.execute("call-1", {
      action: "start",
      appId: "app.notes",
      windowId: "win-1",
    }, null, null, ctx);

    expect(started.details.leaseId).toBeTruthy();
    const state = await tool.execute("call-2", {
      action: "get_app_state",
      leaseId: started.details.leaseId,
    }, null, null, ctx);

    expect(state.content[0].type).toBe("text");
    expect(state.content[1].type).toBe("image");
    expect(state.details.snapshotId).toBeTruthy();
    expect(state.details.elements[0].elementId).toBe("mock-button");
  });

  it("includes a concise element summary in app state results", async () => {
    const { tool, ctx } = makeTool();
    await tool.execute("call-1", {
      action: "start",
      appId: "app.notes",
      windowId: "win-1",
    }, null, null, ctx);

    const state = await tool.execute("call-2", {
      action: "get_app_state",
    }, null, null, ctx);

    expect(state.content[0]).toMatchObject({
      type: "text",
    });
    expect(state.content[0].text).toContain("Current Computer Use state");
    expect(state.content[0].text).toContain("mock-button");
    expect(state.content[0].text).toContain("Continue");
    expect(state.content[1].type).toBe("image");
  });

  it("tells the model to use screenshot coordinates when element actions are not lease-allowed", async () => {
    const { tool, ctx } = makeCoordinateOnlyTool();
    await tool.execute("call-1", {
      action: "start",
      appId: "app.notes",
      windowId: "win-1",
    }, null, null, ctx);

    const state = await tool.execute("call-2", {
      action: "get_app_state",
    }, null, null, ctx);

    expect(state.content[0].text).toContain("Use screenshot coordinates with click_point or double_click");
    expect(state.content[0].text).toContain("Element ids are for reading only");
    expect(state.content[0].text).not.toContain("Use element ids with click_element");
    expect(state.details.allowedActions).toEqual(["click_point", "double_click", "type_text", "press_key", "scroll", "drag", "stop"]);
  });

  it("continues with the current session lease when ids are omitted", async () => {
    const { tool, ctx } = makeTool();
    const started = await tool.execute("call-1", {
      action: "start",
      appId: "app.notes",
      windowId: "win-1",
    }, null, null, ctx);

    const state = await tool.execute("call-2", {
      action: "get_app_state",
    }, null, null, ctx);
    const action = await tool.execute("call-3", {
      action: "click_element",
      elementId: "mock-button",
    }, null, null, ctx);
    const stopped = await tool.execute("call-4", {
      action: "stop",
    }, null, null, ctx);

    expect(state.details.leaseId).toBe(started.details.leaseId);
    expect(action.details.errorCode).toBeUndefined();
    expect(action.details.result.action).toBe("click_element");
    expect(stopped.details.leaseId).toBe(started.details.leaseId);
  });

  it("returns the current lease when start is repeated for the same app", async () => {
    const { tool, ctx } = makeTool();
    const first = await tool.execute("call-1", {
      action: "start",
      appId: "app.notes",
      windowId: "win-1",
    }, null, null, ctx);
    const second = await tool.execute("call-2", {
      action: "start",
      appId: "app.notes",
      windowId: "win-1",
    }, null, null, ctx);

    expect(second.details.errorCode).toBeUndefined();
    expect(second.details.leaseId).toBe(first.details.leaseId);
  });

  it("lets a newer session take over the active computer lease", async () => {
    const { tool, ctx } = makeTool();
    const first = await tool.execute("call-1", {
      action: "start",
      appId: "app.notes",
      windowId: "win-1",
    }, null, null, ctx);
    const nextCtx = {
      ...ctx,
      sessionManager: { getSessionFile: () => "/tmp/other-session.jsonl" },
    };

    const second = await tool.execute("call-2", {
      action: "start",
      appId: "app.notes",
      windowId: "win-1",
    }, null, null, nextCtx);
    const oldState = await tool.execute("call-3", {
      action: "get_app_state",
    }, null, null, ctx);

    expect(second.details.errorCode).toBeUndefined();
    expect(second.details.leaseId).not.toBe(first.details.leaseId);
    expect(second.details.sessionPath).toBe("/tmp/other-session.jsonl");
    expect(oldState.details.errorCode).toBe(COMPUTER_USE_ERRORS.LEASE_RELEASED);
  });

  it("returns a typed error for text-only models", async () => {
    const { tool, ctx } = makeTool({ id: "deepseek-v4-pro", provider: "deepseek", input: ["text"] });
    const result = await tool.execute("call-1", { action: "list_apps" }, null, null, ctx);

    expect(result.details.errorCode).toBe(COMPUTER_USE_ERRORS.REQUIRES_VISION_MODEL);
    expect(result.content[0].text).toContain("Computer Use requires a model with image input support");
  });

  it("fails closed when the Agent tool switch is disabled", async () => {
    const { tool, ctx } = makeTool(undefined, { enabled: false });
    const result = await tool.execute("call-1", { action: "list_apps" }, null, null, ctx);

    expect(result.details.errorCode).toBe(COMPUTER_USE_ERRORS.DISABLED);
    expect(result.content[0].text).toContain("Computer Use is disabled for this agent");
  });

  it("emits session-scoped overlay events around actions", async () => {
    const { tool, ctx, emitted } = makeTool();
    const started = await tool.execute("call-1", {
      action: "start",
      appId: "app.notes",
      windowId: "win-1",
    }, null, null, ctx);
    const state = await tool.execute("call-2", {
      action: "get_app_state",
      leaseId: started.details.leaseId,
    }, null, null, ctx);

    await tool.execute("call-3", {
      action: "click_element",
      leaseId: started.details.leaseId,
      snapshotId: state.details.snapshotId,
      elementId: "mock-button",
    }, null, null, ctx);

    const overlayEvents = emitted.map((entry) => entry.event);
    expect(overlayEvents.map((event) => event.phase)).toEqual([
      "running",
      "done",
      "preview",
      "running",
      "done",
    ]);
    expect(overlayEvents.every((event) => event.type === "computer_overlay")).toBe(true);
    expect(overlayEvents.every((event) => event.sessionPath === "/tmp/session.jsonl")).toBe(true);
    expect(overlayEvents.every((event) => event.agentId === "hana")).toBe(true);
    expect(overlayEvents.at(-1)).toMatchObject({
      action: "click_element",
      leaseId: started.details.leaseId,
      snapshotId: state.details.snapshotId,
      target: { coordinateSpace: "element", elementId: "mock-button" },
    });
  });

  it("marks foreground input actions in overlay events", async () => {
    const { tool, ctx, emitted } = makeForegroundTool();
    const started = await tool.execute("call-1", {
      action: "start",
      appId: "pid:12",
      windowId: "123",
    }, null, null, ctx);
    const state = await tool.execute("call-2", {
      action: "get_app_state",
      leaseId: started.details.leaseId,
    }, null, null, ctx);

    await tool.execute("call-3", {
      action: "click_point",
      leaseId: started.details.leaseId,
      snapshotId: state.details.snapshotId,
      x: 20,
      y: 30,
    }, null, null, ctx);

    const actionEvents = emitted.map((entry) => entry.event).filter((event) => event.action === "click_point");
    expect(actionEvents.map((event) => event.phase)).toEqual(["preview", "running", "done"]);
    expect(actionEvents.every((event) => event.inputMode === "foreground-input")).toBe(true);
    expect(actionEvents.every((event) => event.requiresForeground === true)).toBe(true);
    expect(actionEvents.every((event) => event.interruptKey === "Escape")).toBe(true);
  });

  it("marks overlay events as provider-rendered when the provider owns the cursor", async () => {
    const { tool, ctx, emitted } = makeNativeCursorTool();
    const started = await tool.execute("call-1", {
      action: "start",
      appId: "app.notes",
      windowId: "win-1",
    }, null, null, ctx);
    const state = await tool.execute("call-2", {
      action: "get_app_state",
      leaseId: started.details.leaseId,
    }, null, null, ctx);

    await tool.execute("call-3", {
      action: "click_element",
      leaseId: started.details.leaseId,
      snapshotId: state.details.snapshotId,
      elementId: "mock-button",
    }, null, null, ctx);

    const overlayEvents = emitted.map((entry) => entry.event)
      .filter((event) => event.type === "computer_overlay");
    expect(overlayEvents).not.toHaveLength(0);
    expect(overlayEvents.every((event) => event.visualSurface === "provider")).toBe(true);
  });

  it("accepts secondary element actions", async () => {
    const { tool, ctx } = makeTool();
    const started = await tool.execute("call-1", {
      action: "start",
      appId: "app.notes",
      windowId: "win-1",
    }, null, null, ctx);
    const state = await tool.execute("call-2", {
      action: "get_app_state",
      leaseId: started.details.leaseId,
    }, null, null, ctx);

    const result = await tool.execute("call-3", {
      action: "perform_secondary_action",
      leaseId: started.details.leaseId,
      snapshotId: state.details.snapshotId,
      elementId: "mock-button",
    }, null, null, ctx);

    expect(result.details.errorCode).toBeUndefined();
    expect(result.details.action).toBe("perform_secondary_action");
  });

  it("accepts double click actions for media/list targets", async () => {
    const { tool, ctx } = makeTool();
    await tool.execute("call-1", {
      action: "start",
      appId: "app.notes",
      windowId: "win-1",
    }, null, null, ctx);
    await tool.execute("call-2", {
      action: "get_app_state",
    }, null, null, ctx);

    const result = await tool.execute("call-3", {
      action: "double_click",
      elementId: "mock-button",
    }, null, null, ctx);

    expect(result.details.errorCode).toBeUndefined();
    expect(result.details.action).toBe("double_click");
  });

  it("asks for app approval and retries start after confirmation", async () => {
    const { tool, ctx, emitted, confirmStore, approve } = makeApprovalTool("confirmed");

    const result = await tool.execute("call-approval", {
      action: "start",
      appId: "app.notes",
      appName: "Mock Notes",
      windowId: "win-1",
    }, null, null, ctx);

    expect(result.details.leaseId).toBeTruthy();
    expect(result.details.confirmation.status).toBe("confirmed");
    expect(confirmStore.create).toHaveBeenCalledWith(
      "computer_app_approval",
      expect.objectContaining({
        approval: expect.objectContaining({ providerId: "mock", appId: "app.notes" }),
      }),
      "/tmp/session.jsonl",
    );
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "mock",
      appId: "app.notes",
    }));
    expect(emitted[0].event).toMatchObject({
      type: "session_confirmation",
      request: {
        type: "session_confirmation",
        kind: "computer_app_approval",
        surface: "input",
        status: "pending",
        confirmId: "confirm-computer-1",
      },
    });
  });

  it("resolves appName to appId before asking for app approval", async () => {
    const { tool, ctx, confirmStore, approve } = makeApprovalTool("confirmed");

    const result = await tool.execute("call-approval", {
      action: "start",
      appName: "Mock Notes",
    }, null, null, ctx);

    expect(result.details.leaseId).toBeTruthy();
    expect(result.details.confirmation.status).toBe("confirmed");
    expect(confirmStore.create).toHaveBeenCalledWith(
      "computer_app_approval",
      expect.objectContaining({
        approval: expect.objectContaining({
          providerId: "mock",
          appId: "app.notes",
          appName: "Mock Notes",
        }),
      }),
      "/tmp/session.jsonl",
    );
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "mock",
      appId: "app.notes",
      appName: "Mock Notes",
    }));
  });

  it("does not approve or retry when app approval is rejected", async () => {
    const { tool, ctx, approve } = makeApprovalTool("rejected");

    const result = await tool.execute("call-approval", {
      action: "start",
      appId: "app.notes",
      appName: "Mock Notes",
      windowId: "win-1",
    }, null, null, ctx);

    expect(result.details.leaseId).toBeUndefined();
    expect(result.details.confirmation.status).toBe("rejected");
    expect(result.details.confirmed).toBe(false);
    expect(approve).not.toHaveBeenCalled();
  });
});
