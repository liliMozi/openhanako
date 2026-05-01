import { describe, expect, it } from "vitest";
import { ComputerHost } from "../core/computer-use/computer-host.js";
import { ComputerProviderRegistry } from "../core/computer-use/provider-registry.js";
import { createMockComputerProvider } from "../core/computer-use/providers/mock-provider.js";
import { COMPUTER_USE_ERRORS } from "../core/computer-use/errors.js";

function makeHost(provider = createMockComputerProvider({ providerId: "mock" })) {
  const providers = new ComputerProviderRegistry();
  providers.register(provider);
  return {
    host: new ComputerHost({
      providers,
      defaultProviderId: "mock",
      getSettings: () => ({ enabled: true }),
    }),
    provider,
  };
}

const ctx = {
  sessionPath: "/tmp/session.jsonl",
  agentId: "hana",
  model: { id: "gpt-5.5", provider: "openai", input: ["text", "image"] },
};

describe("ComputerHost", () => {
  it("blocks text-only models before creating a lease", async () => {
    const { host } = makeHost();
    await expect(host.createLease({
      ...ctx,
      model: { id: "deepseek-v4-pro", provider: "deepseek", input: ["text"] },
    }, { appId: "app.notes" })).rejects.toMatchObject({
      code: COMPUTER_USE_ERRORS.REQUIRES_VISION_MODEL,
    });
  });

  it("creates a lease and returns a snapshot with screenshot content", async () => {
    const { host } = makeHost();
    const lease = await host.createLease(ctx, { appId: "app.notes", windowId: "win-1" });
    const snapshot = await host.getAppState(ctx, lease.leaseId);

    expect(snapshot).toMatchObject({
      leaseId: lease.leaseId,
      providerId: "mock",
      mode: "vision-native",
      appId: "app.notes",
      allowedActions: expect.arrayContaining(["click_element"]),
    });
    expect(snapshot.snapshotId).toBeTruthy();
    expect(snapshot.screenshot.type).toBe("image");
  });

  it("selects a platform provider from settings and keeps provider-owned state on the lease", async () => {
    const providers = new ComputerProviderRegistry();
    providers.register(createMockComputerProvider({ providerId: "mock" }));
    providers.register(createMockComputerProvider({ providerId: "windows:uia" }));
    const host = new ComputerHost({
      providers,
      defaultProviderId: "mock",
      platform: "win32",
      getSettings: () => ({ enabled: true, provider_by_platform: { win32: "windows:uia" } }),
    });

    const status = await host.getStatus(ctx);
    const lease = await host.createLease(ctx, { appId: "app.notes" });

    expect(status.selectedProviderId).toBe("windows:uia");
    expect(lease.providerId).toBe("windows:uia");
    expect(lease.providerState).toMatchObject({ mock: true });
  });

  it("rejects stale snapshot actions", async () => {
    const { host } = makeHost();
    const lease = await host.createLease(ctx, { appId: "app.notes" });
    await host.getAppState(ctx, lease.leaseId);

    await expect(host.performAction(ctx, lease.leaseId, {
      type: "click_element",
      snapshotId: "old",
      elementId: "mock-button",
    })).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.STALE_SNAPSHOT });
  });

  it("rejects unsupported provider capabilities", async () => {
    const provider = createMockComputerProvider({ providerId: "mock" });
    provider.capabilities.elementActions = false;
    const { host } = makeHost(provider);
    const lease = await host.createLease(ctx, { appId: "app.notes" });
    const snapshot = await host.getAppState(ctx, lease.leaseId);

    await expect(host.performAction(ctx, lease.leaseId, {
      type: "click_element",
      snapshotId: snapshot.snapshotId,
      elementId: "mock-button",
    })).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.CAPABILITY_UNSUPPORTED });
  });

  it("uses a dedicated keyboard capability for press_key", async () => {
    const provider = createMockComputerProvider({ providerId: "mock" });
    provider.capabilities.keyboardInput = "unsupported";
    const { host } = makeHost(provider);
    const lease = await host.createLease(ctx, { appId: "app.notes" });
    const snapshot = await host.getAppState(ctx, lease.leaseId);

    await expect(host.performAction(ctx, lease.leaseId, {
      type: "press_key",
      snapshotId: snapshot.snapshotId,
      key: "return",
    })).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.CAPABILITY_UNSUPPORTED });
  });

  it("accepts explicit foreground capability values for Windows-style raw input", async () => {
    const provider = createMockComputerProvider({ providerId: "mock" });
    provider.capabilities.pointClick = "foreground";
    provider.capabilities.drag = "foreground";
    provider.capabilities.keyboardInput = "foreground";
    provider.createLease = async (_ctx, target) => ({
      appId: target?.appId || "app.notes",
      windowId: target?.windowId || "win-1",
      allowedActions: ["click_point", "drag", "press_key", "stop"],
      providerState: {},
    });
    const { host } = makeHost(provider);
    const lease = await host.createLease(ctx, { appId: "app.notes" });
    const snapshot = await host.getAppState(ctx, lease.leaseId);

    await expect(host.performAction(ctx, lease.leaseId, {
      type: "click_point",
      snapshotId: snapshot.snapshotId,
      x: 10,
      y: 20,
    })).resolves.toMatchObject({ ok: true, action: "click_point" });
    await expect(host.performAction(ctx, lease.leaseId, {
      type: "press_key",
      snapshotId: snapshot.snapshotId,
      key: "Return",
    })).resolves.toMatchObject({ ok: true, action: "press_key" });
  });

  it("marks native-cursor providers as provider-rendered for action presentation", async () => {
    const provider = createMockComputerProvider({ providerId: "mock" });
    provider.capabilities.nativeCursor = true;
    const { host } = makeHost(provider);
    const lease = await host.createLease(ctx, { appId: "app.notes" });

    expect(host.getActionPresentation(ctx, lease.leaseId, "click_element")).toMatchObject({
      providerId: "mock",
      inputMode: "background",
      visualSurface: "provider",
    });
  });

  it("requires app approval for non-isolated providers", async () => {
    const provider = createMockComputerProvider({ providerId: "mock" });
    provider.capabilities.isolated = false;
    const providers = new ComputerProviderRegistry();
    providers.register(provider);
    const host = new ComputerHost({
      providers,
      defaultProviderId: "mock",
      getSettings: () => ({ enabled: true }),
    });

    await expect(host.createLease(ctx, { appId: "app.notes" }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.APP_APPROVAL_REQUIRED });
  });

  it("allows non-isolated providers after app approval", async () => {
    const provider = createMockComputerProvider({ providerId: "mock" });
    provider.capabilities.isolated = false;
    const providers = new ComputerProviderRegistry();
    providers.register(provider);
    const host = new ComputerHost({
      providers,
      defaultProviderId: "mock",
      getSettings: () => ({
        enabled: true,
        app_approvals: [{ providerId: "mock", appId: "app.notes", approvedAt: "2026-05-01T00:00:00.000Z" }],
      }),
    });

    const lease = await host.createLease(ctx, { appId: "app.notes" });
    expect(lease.providerId).toBe("mock");
  });

  it("stops and releases a lease", async () => {
    const { host } = makeHost();
    const lease = await host.createLease(ctx, { appId: "app.notes" });
    await host.stop(ctx, lease.leaseId);

    await expect(host.getAppState(ctx, lease.leaseId))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.LEASE_RELEASED });
  });

  it("fails closed when the global switch is off", async () => {
    const providers = new ComputerProviderRegistry();
    providers.register(createMockComputerProvider({ providerId: "mock" }));
    const host = new ComputerHost({
      providers,
      defaultProviderId: "mock",
      getSettings: () => ({ enabled: false }),
    });

    const status = await host.getStatus(ctx);
    expect(status.enabled).toBe(false);
    await expect(host.listApps(ctx)).rejects.toMatchObject({
      code: COMPUTER_USE_ERRORS.DISABLED,
      details: { reason: "global-disabled" },
    });
  });

  it("allows only the main agent to use the computer", async () => {
    const { host } = makeHost();
    host._getPrimaryAgentId = () => "main";

    await expect(host.listApps({ ...ctx, agentId: "sidecar" })).rejects.toMatchObject({
      code: COMPUTER_USE_ERRORS.DISABLED,
      details: { reason: "not-primary-agent" },
    });
  });

  it("blocks computer use in read-only sessions", async () => {
    const providers = new ComputerProviderRegistry();
    providers.register(createMockComputerProvider({ providerId: "mock" }));
    const host = new ComputerHost({
      providers,
      defaultProviderId: "mock",
      getSettings: () => ({ enabled: true }),
      getAccessMode: () => "read_only",
    });

    await expect(host.listApps(ctx)).rejects.toMatchObject({
      code: COMPUTER_USE_ERRORS.DISABLED,
      details: { reason: "read-only-session" },
    });
  });

  it("allows only one active computer lease at a time", async () => {
    const { host } = makeHost();
    await host.createLease(ctx, { appId: "app.notes" });

    const next = await host.createLease({
      ...ctx,
      sessionPath: "/tmp/other-session.jsonl",
    }, { appId: "app.notes" });

    expect(next.sessionPath).toBe("/tmp/other-session.jsonl");
    await expect(host.getAppState(ctx))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.LEASE_RELEASED });
  });

  it("reuses the active lease for the same session and target", async () => {
    const provider = createMockComputerProvider({ providerId: "mock" });
    let createLeaseCalls = 0;
    const originalCreateLease = provider.createLease;
    provider.createLease = async (...args) => {
      createLeaseCalls += 1;
      return originalCreateLease(...args);
    };
    const { host } = makeHost(provider);

    const first = await host.createLease(ctx, { appId: "app.notes" });
    const second = await host.createLease(ctx, { appId: "app.notes" });

    expect(second.leaseId).toBe(first.leaseId);
    expect(createLeaseCalls).toBe(1);
  });

  it("resolves missing lease and snapshot ids from the current session lease", async () => {
    const { host, provider } = makeHost();
    const lease = await host.createLease(ctx, { appId: "app.notes" });
    const snapshot = await host.getAppState(ctx);

    expect(snapshot.leaseId).toBe(lease.leaseId);

    await host.performAction(ctx, undefined, {
      type: "click_element",
      elementId: "mock-button",
    });
    await host.stop(ctx);

    expect(provider.actions.at(-2)).toMatchObject({
      leaseId: lease.leaseId,
      action: {
        type: "click_element",
        snapshotId: snapshot.snapshotId,
        elementId: "mock-button",
      },
    });
    expect(provider.actions.at(-1)).toMatchObject({ action: { type: "stop" } });
    await expect(host.getAppState(ctx, lease.leaseId))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.LEASE_RELEASED });
  });

  it("passes snapshot-bound element metadata to providers before element actions", async () => {
    const { host, provider } = makeHost();
    const lease = await host.createLease(ctx, { appId: "app.notes" });
    const snapshot = await host.getAppState(ctx, lease.leaseId);

    await host.performAction(ctx, lease.leaseId, {
      type: "click_element",
      snapshotId: snapshot.snapshotId,
      elementId: "mock-button",
    });

    expect(provider.actions.at(-1)).toMatchObject({
      action: {
        type: "click_element",
        snapshotId: snapshot.snapshotId,
        elementId: "mock-button",
        snapshotElement: {
          elementId: "mock-button",
          role: "button",
          label: "Continue",
        },
        snapshotDisplay: { width: 800, height: 600, scaleFactor: 1 },
      },
    });
  });
});
