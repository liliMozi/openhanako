import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createPreferencesRoute } from "../server/routes/preferences.js";

function makeApp(engine) {
  const app = new Hono();
  app.route("/api", createPreferencesRoute(engine));
  return app;
}

function makeEngine(options = {}) {
  const computerUseSettings = options.computerUseSettings || {
    enabled: true,
    provider_by_platform: { darwin: "macos:cua", win32: "windows:uia", linux: "mock" },
    allow_windows_input_injection: false,
    app_approvals: [],
  };
  const computerHost = {
    getStatus: vi.fn(async () => ({ selectedProviderId: "mock", providers: [] })),
    requestPermissions: vi.fn(async () => ({ providerId: "mock", available: true, permissions: [] })),
  };
  return {
    getSharedModels: vi.fn(() => ({})),
    getSearchConfig: vi.fn(() => ({})),
    getUtilityApi: vi.fn(() => ({})),
    setSharedModels: vi.fn(),
    setSearchConfig: vi.fn(),
    setUtilityApi: vi.fn(),
    currentAgentId: "hana",
    emitEvent: vi.fn(),
    getComputerUseSettings: vi.fn(() => computerUseSettings),
    setComputerUseSettings: vi.fn((settings) => settings),
    approveComputerUseApp: vi.fn((approval) => ({ app_approvals: [approval] })),
    revokeComputerUseApp: vi.fn(() => ({ app_approvals: [] })),
    getComputerHost: vi.fn(() => computerHost),
    computerHost,
  };
}

describe("Computer Use preference routes", () => {
  it("returns settings and provider status", async () => {
    const engine = makeEngine();
    const app = makeApp(engine);

    const res = await app.request("/api/preferences/computer-use");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.selectedProviderId).toBe("mock");
    expect(body.settings.provider_by_platform.darwin).toBe("macos:cua");
  });

  it("does not initialize or probe ComputerHost while Computer Use is disabled", async () => {
    const engine = makeEngine({
      computerUseSettings: {
        enabled: false,
        provider_by_platform: { darwin: "macos:cua", win32: "windows:uia", linux: "mock" },
        allow_windows_input_injection: false,
        app_approvals: [],
      },
    });
    const app = makeApp(engine);

    const res = await app.request("/api/preferences/computer-use");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(engine.getComputerHost).not.toHaveBeenCalled();
    expect(engine.computerHost.getStatus).not.toHaveBeenCalled();
    expect(body.status).toMatchObject({
      enabled: false,
      providers: [],
      activeLease: null,
    });
    expect(body.selectedProviderId).toBe(body.settings.provider_by_platform[process.platform] || null);
  });

  it("updates settings", async () => {
    const engine = makeEngine();
    const app = makeApp(engine);

    const res = await app.request("/api/preferences/computer-use", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_by_platform: { darwin: "mock" } }),
    });

    expect(res.status).toBe(200);
    expect(engine.setComputerUseSettings).toHaveBeenCalledWith({ provider_by_platform: { darwin: "mock" } });
  });

  it("approves and revokes apps", async () => {
    const engine = makeEngine();
    const app = makeApp(engine);
    const approval = { providerId: "macos:cua", appId: "com.apple.calculator", appName: "Calculator" };

    const approved = await app.request("/api/preferences/computer-use/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(approval),
    });
    const revoked = await app.request("/api/preferences/computer-use/approvals", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "macos:cua", appId: "com.apple.calculator" }),
    });

    expect(approved.status).toBe(200);
    expect(revoked.status).toBe(200);
    expect(engine.approveComputerUseApp).toHaveBeenCalledWith(approval);
    expect(engine.revokeComputerUseApp).toHaveBeenCalledWith({ providerId: "macos:cua", appId: "com.apple.calculator" });
  });

  it("requests system permissions through the selected provider", async () => {
    const engine = makeEngine();
    const app = makeApp(engine);

    const res = await app.request("/api/preferences/computer-use/request-permissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "mock" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.result.providerId).toBe("mock");
    expect(engine.computerHost.requestPermissions).toHaveBeenCalledWith({}, "mock");
  });

});
