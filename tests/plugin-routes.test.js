import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createPluginProxyRoute, createPluginsRoute } from "../server/routes/plugins.js";

describe("plugin route proxy", () => {
  it("dispatches to registered plugin route", async () => {
    const routeRegistry = new Map();
    const pluginApp = new Hono();
    pluginApp.get("/hello", (c) => c.json({ msg: "world" }));
    routeRegistry.set("my-plugin", pluginApp);
    const app = new Hono();
    app.route("/api", createPluginProxyRoute(routeRegistry));
    const res = await app.request("/api/plugins/my-plugin/hello");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ msg: "world" });
  });

  it("returns 404 for unknown plugin", async () => {
    const routeRegistry = new Map();
    const app = new Hono();
    app.route("/api", createPluginProxyRoute(routeRegistry));
    const res = await app.request("/api/plugins/nope/hello");
    expect(res.status).toBe(404);
  });

  it("returns 404 after plugin is removed from registry", async () => {
    const routeRegistry = new Map();
    const pluginApp = new Hono();
    pluginApp.get("/test", (c) => c.text("ok"));
    routeRegistry.set("temp", pluginApp);
    const app = new Hono();
    app.route("/api", createPluginProxyRoute(routeRegistry));
    let res = await app.request("/api/plugins/temp/test");
    expect(res.status).toBe(200);
    routeRegistry.delete("temp");
    res = await app.request("/api/plugins/temp/test");
    expect(res.status).toBe(404);
  });
});

// ── Management API tests ──

function mockEngine(overrides = {}) {
  const routeRegistry = new Map();
  const allowFullAccess = overrides.allowFullAccess ?? false;
  return {
    syncPluginExtensions: vi.fn(),
    pluginManager: {
      listPlugins: () => overrides.plugins || [],
      routeRegistry,
      enablePlugin: overrides.enablePlugin || vi.fn(),
      disablePlugin: overrides.disablePlugin || vi.fn(),
      removePlugin: overrides.removePlugin || vi.fn(),
      installPlugin: overrides.installPlugin || vi.fn(),
      setFullAccess: overrides.setFullAccess || vi.fn(),
      getAllConfigSchemas: () => [],
      getConfigSchema: () => null,
      getUserPluginsDir: () => "/user",
      isValidPluginDir: () => true,
      getAllowFullAccess: () => allowFullAccess,
      getRouteApp: (id) => routeRegistry.get(id) || null,
      ...overrides.pm,
    },
  };
}

function createApp(engine) {
  const app = new Hono();
  app.route("/api", createPluginsRoute(engine));
  return app;
}

describe("plugin management API", () => {
  describe("GET /plugins", () => {
    it("returns plugins with trust field", async () => {
      const engine = mockEngine({
        plugins: [
          { id: "a", name: "A", version: "1.0", description: "desc", status: "active", source: "community", trust: "full-access", contributions: {} },
        ],
      });
      const app = createApp(engine);
      const res = await app.request("/api/plugins");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].trust).toBe("full-access");
    });

    it("defaults trust to restricted", async () => {
      const engine = mockEngine({
        plugins: [
          { id: "b", name: "B", version: "1.0", description: "", status: "active", contributions: {} },
        ],
      });
      const app = createApp(engine);
      const res = await app.request("/api/plugins");
      const body = await res.json();
      expect(body[0].trust).toBe("restricted");
      expect(body[0].source).toBe("community");
    });
  });

  describe("DELETE /plugins/:id", () => {
    it("calls removePlugin and returns ok", async () => {
      const removeFn = vi.fn().mockResolvedValue(null);
      const engine = mockEngine({ removePlugin: removeFn });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/my-plugin", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(removeFn).toHaveBeenCalledWith("my-plugin");
    });

    it("returns 404 when plugin not found", async () => {
      const removeFn = vi.fn().mockRejectedValue(new Error("not found"));
      const engine = mockEngine({ removePlugin: removeFn });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/nope", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /plugins/:id/enabled", () => {
    it("enables a plugin", async () => {
      const enableFn = vi.fn().mockResolvedValue();
      const engine = mockEngine({ enablePlugin: enableFn });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/p1/enabled", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(enableFn).toHaveBeenCalledWith("p1");
    });

    it("disables a plugin", async () => {
      const disableFn = vi.fn().mockResolvedValue();
      const engine = mockEngine({ disablePlugin: disableFn });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/p1/enabled", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);
      expect(disableFn).toHaveBeenCalledWith("p1");
    });

    it("returns 404 when plugin not found", async () => {
      const enableFn = vi.fn().mockRejectedValue(new Error("not found"));
      const engine = mockEngine({ enablePlugin: enableFn });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/nope/enabled", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /plugins/settings", () => {
    it("returns allow_full_access setting", async () => {
      const engine = mockEngine({ allowFullAccess: true });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/settings");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ allow_full_access: true });
    });

    it("defaults to false", async () => {
      const engine = mockEngine({ allowFullAccess: false });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/settings");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ allow_full_access: false });
    });
  });

  describe("PUT /plugins/settings", () => {
    it("calls setFullAccess and returns plugin list", async () => {
      const setFn = vi.fn().mockResolvedValue();
      const engine = mockEngine({
        setFullAccess: setFn,
        plugins: [
          { id: "x", name: "X", version: "1.0", description: "", status: "active", source: "community", trust: "restricted", contributions: {} },
        ],
      });
      const app = createApp(engine);
      const res = await app.request("/api/plugins/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allow_full_access: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].trust).toBe("restricted");
      expect(setFn).toHaveBeenCalledWith(true);
    });
  });

  describe("POST /plugins/install", () => {
    it("returns 400 when path is missing", async () => {
      const engine = mockEngine();
      const app = createApp(engine);
      const res = await app.request("/api/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("path is required");
    });

    it("returns 500 when pluginManager is null", async () => {
      const engine = { pluginManager: null };
      const app = createApp(engine);
      const res = await app.request("/api/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/some/dir" }),
      });
      expect(res.status).toBe(500);
    });
  });
});
