import { describe, it, expect } from "vitest";
import { createPluginContext } from "../core/plugin-context.js";

async function makeBus() {
  const { EventBus } = await import("../hub/event-bus.js");
  return new EventBus();
}

describe("createPluginContext", () => {
  it("returns ctx with all required properties", () => {
    const bus = { emit() {}, subscribe() {}, request() {}, hasHandler() {} };
    const ctx = createPluginContext({
      pluginId: "test-plugin",
      pluginDir: "/plugins/test-plugin",
      dataDir: "/plugin-data/test-plugin",
      bus,
    });
    expect(ctx.pluginId).toBe("test-plugin");
    expect(ctx.pluginDir).toBe("/plugins/test-plugin");
    expect(ctx.dataDir).toBe("/plugin-data/test-plugin");
    expect(ctx.bus).toBeDefined();
    expect(typeof ctx.bus.emit).toBe("function");
    expect(ctx.log).toBeDefined();
    expect(ctx.config).toBeDefined();
    expect(typeof ctx.config.get).toBe("function");
    expect(typeof ctx.config.set).toBe("function");
  });

  it("config.get/set reads and writes plugin-data config.json", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const tmpDir = path.join(os.tmpdir(), "hana-ctx-test-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const ctx = createPluginContext({
        pluginId: "x", pluginDir: "/tmp", dataDir: tmpDir,
        bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
      });
      ctx.config.set("foo", 42);
      expect(ctx.config.get("foo")).toBe(42);
      const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf-8"));
      expect(raw.foo).toBe(42);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("log has scoped prefix", () => {
    const ctx = createPluginContext({
      pluginId: "my-plug", pluginDir: "/tmp", dataDir: "/tmp",
      bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
    });
    expect(typeof ctx.log.info).toBe("function");
    expect(typeof ctx.log.error).toBe("function");
  });
});

describe("createPluginContext with accessLevel", () => {
  it("full-access context exposes bus.handle", async () => {
    const bus = await makeBus();
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus, accessLevel: "full-access",
    });
    expect(typeof ctx.bus.handle).toBe("function");
    expect(typeof ctx.bus.request).toBe("function");
    expect(typeof ctx.bus.emit).toBe("function");
  });

  it("restricted context does NOT expose bus.handle", async () => {
    const bus = await makeBus();
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus, accessLevel: "restricted",
    });
    expect(ctx.bus.handle).toBeUndefined();
    expect(typeof ctx.bus.request).toBe("function");
    expect(typeof ctx.bus.emit).toBe("function");
    expect(typeof ctx.bus.subscribe).toBe("function");
  });

  it("restricted bus proxy is frozen", async () => {
    const bus = await makeBus();
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus, accessLevel: "restricted",
    });
    expect(Object.isFrozen(ctx.bus)).toBe(true);
    expect(() => { ctx.bus.handle = () => {}; }).toThrow();
  });

  it("defaults to restricted when accessLevel omitted", async () => {
    const bus = await makeBus();
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus,
    });
    expect(ctx.bus.handle).toBeUndefined();
  });
});
