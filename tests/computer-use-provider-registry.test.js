import { describe, expect, it } from "vitest";
import { ComputerProviderRegistry } from "../core/computer-use/provider-registry.js";
import { createMockComputerProvider } from "../core/computer-use/providers/mock-provider.js";
import { COMPUTER_USE_ERRORS } from "../core/computer-use/errors.js";

describe("ComputerProviderRegistry", () => {
  it("registers and retrieves providers by id", () => {
    const registry = new ComputerProviderRegistry();
    const provider = createMockComputerProvider({ providerId: "mock" });
    registry.register(provider);

    expect(registry.get("mock")).toBe(provider);
    expect(registry.has("mock")).toBe(true);
    expect(registry.list().map((p) => p.providerId)).toEqual(["mock"]);
  });

  it("normalizes omitted capability fields when registering a provider", () => {
    const registry = new ComputerProviderRegistry();
    const provider = { providerId: "minimal" };
    registry.register(provider);

    expect(registry.get("minimal").capabilities).toMatchObject({
      platform: "sandbox",
      screenshot: false,
      keyboardInput: "unsupported",
      isolated: false,
    });
  });

  it("rejects duplicate provider ids", () => {
    const registry = new ComputerProviderRegistry();
    registry.register(createMockComputerProvider({ providerId: "mock" }));

    expect(() => registry.register(createMockComputerProvider({ providerId: "mock" })))
      .toThrow("Computer provider already registered: mock");
  });

  it("throws PROVIDER_UNAVAILABLE for missing providers", () => {
    const registry = new ComputerProviderRegistry();
    expect(() => registry.require("missing")).toThrow(COMPUTER_USE_ERRORS.PROVIDER_UNAVAILABLE);
  });

  it("mock provider returns deterministic app state", async () => {
    const provider = createMockComputerProvider({ providerId: "mock" });
    const state = await provider.getAppState({}, {
      leaseId: "lease-1",
      appId: "app.notes",
      windowId: "win-1",
    });

    expect(state).toMatchObject({
      appId: "app.notes",
      windowId: "win-1",
      mode: "vision-native",
      display: { width: 800, height: 600, scaleFactor: 1 },
    });
    expect(state.screenshot).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(state.elements[0]).toMatchObject({ elementId: "mock-button", role: "button" });
  });
});
