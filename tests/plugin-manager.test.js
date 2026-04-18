import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { PluginManager } from "../core/plugin-manager.js";

const tmpHome = path.join(os.tmpdir(), "hana-pm-test-" + Date.now());
const pluginsDir = path.join(tmpHome, "plugins");
const dataDir = path.join(tmpHome, "plugin-data");

beforeEach(() => {
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function makeBus() {
  const { EventBus } = await import("../hub/event-bus.js");
  return new EventBus();
}

describe("scan", () => {
  it("discovers plugin from directory with manifest.json", async () => {
    const dir = path.join(pluginsDir, "my-plugin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "my-plugin", name: "My Plugin", version: "1.0.0",
    }));
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    const plugins = pm.scan();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe("my-plugin");
    expect(plugins[0].name).toBe("My Plugin");
  });

  it("infers id from directory name when no manifest", async () => {
    const dir = path.join(pluginsDir, "simple-tool");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "hello.js"),
      'export const name = "hello";\nexport const description = "test";\nexport const parameters = {};\nexport async function execute() { return "hi"; }\n');
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    const plugins = pm.scan();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe("simple-tool");
  });

  it("detects contribution types from subdirectories", async () => {
    const dir = path.join(pluginsDir, "multi");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), "export const name='t';");
    fs.writeFileSync(path.join(dir, "skills", "s.md"), "---\nname: s\n---\n# S");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    const plugins = pm.scan();
    expect(plugins[0].contributions).toContain("tools");
    expect(plugins[0].contributions).toContain("skills");
  });

  it("skips hidden directories and non-directories", async () => {
    fs.mkdirSync(path.join(pluginsDir, ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, "README.md"), "hi");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    expect(pm.scan()).toHaveLength(0);
  });

  it("invalid manifest.json logs error and skips plugin", async () => {
    const dir = path.join(pluginsDir, "bad");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), "NOT JSON");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    expect(pm.scan()).toHaveLength(0);
  });
});

describe("loadAll", () => {
  it("loads plugin with index.js and calls onload", async () => {
    const dir = path.join(pluginsDir, "stateful");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.js"), `
      export default class TestPlugin {
        async onload() { this.loaded = true; }
      }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("stateful");
    expect(entry.status).toBe("loaded");
    expect(entry.instance.loaded).toBe(true);
  });

  it("provides register() on instance and cleans up on unload", async () => {
    const dir = path.join(pluginsDir, "reg-test");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.js"), `
      export default class RegPlugin {
        async onload() {
          this.register(() => { globalThis.__regTestCleanup = true; });
        }
      }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    await pm.unloadPlugin("reg-test");
    expect(globalThis.__regTestCleanup).toBe(true);
    delete globalThis.__regTestCleanup;
  });

  it("failed onload marks plugin as failed, does not block others", async () => {
    const bad = path.join(pluginsDir, "bad-plugin");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "index.js"), `
      export default class Bad { async onload() { throw new Error("boom"); } }
    `);
    const good = path.join(pluginsDir, "good-plugin");
    fs.mkdirSync(path.join(good, "tools"), { recursive: true });
    fs.writeFileSync(path.join(good, "tools", "t.js"), "export const name='t';");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    expect(pm.getPlugin("bad-plugin").status).toBe("failed");
    expect(pm.getPlugin("good-plugin").status).toBe("loaded");
  });

  it("plugin without index.js loads as static (no lifecycle)", async () => {
    const dir = path.join(pluginsDir, "static-only");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), "export const name='t';");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    expect(pm.getPlugin("static-only").status).toBe("loaded");
    expect(pm.getPlugin("static-only").instance).toBeNull();
  });

  it("stores ctx on entry after loading", async () => {
    const dir = path.join(pluginsDir, "ctx-test");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"),
      'export const name = "t";\nexport const description = "test";\nexport const parameters = {};\nexport async function execute() { return "ok"; }\n');
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("ctx-test");
    expect(entry).toBeTruthy();
    expect(entry.ctx).toBeTruthy();
    expect(entry.ctx.pluginId).toBeTruthy();
    expect(entry.ctx.bus).toBeTruthy();
    expect(entry.ctx.config).toBeTruthy();
    expect(entry.ctx.log).toBeTruthy();
  });
});

describe("tool loading", () => {
  it("loads tools from tools/ directory with namespace prefix", async () => {
    const dir = path.join(pluginsDir, "search-plugin");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "web-search.js"), `
      export const name = "web-search";
      export const description = "Search the web";
      export const parameters = { type: "object", properties: { query: { type: "string" } } };
      export async function execute(input) { return "results for " + input.query; }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    const tools = pm.getAllTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("search-plugin_web-search");
    expect(tools[0].description).toBe("Search the web");
  });

  it("skips tool files with invalid exports", async () => {
    const dir = path.join(pluginsDir, "bad-tool");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "bad.js"), "export const x = 1;");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    expect(pm.getAllTools()).toHaveLength(0);
  });
});

describe("skill paths", () => {
  it("getSkillPaths returns skill directories from all plugins", async () => {
    const dir = path.join(pluginsDir, "skill-plug");
    fs.mkdirSync(path.join(dir, "skills", "my-skill"), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: test\n---\n# My Skill");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    const paths = pm.getSkillPaths();
    expect(paths).toHaveLength(1);
    expect(paths[0].dirPath).toContain("skill-plug");
    expect(paths[0].label).toBe("plugin:skill-plug");
  });
});

describe("command loading", () => {
  it("loads commands from commands/ directory", async () => {
    const dir = path.join(pluginsDir, "cmd-plug");
    fs.mkdirSync(path.join(dir, "commands"), { recursive: true });
    fs.writeFileSync(path.join(dir, "commands", "hello.js"), `
      export const name = "hello";
      export const description = "Say hello";
      export async function execute(args, ctx) { return "Hello " + args; }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    const cmds = pm.getAllCommands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe("cmd-plug.hello");
  });
});

describe("extensions", () => {
  it("loads extension factories from extensions/ directory (full-access)", async () => {
    const builtinDir = path.join(tmpHome, "builtin-ext");
    const dir = path.join(builtinDir, "ext-plug");
    fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "extensions", "strip.js"), `
      export default function(pi) {
        pi.on("before_provider_request", (event) => {
          return event.payload;
        });
      }
    `);
    const pm = new PluginManager({
      pluginsDirs: [builtinDir],
      dataDir,
      bus: await makeBus(),
    });
    pm.scan();
    await pm.loadAll();
    const factories = pm.getExtensionFactories();
    expect(factories).toHaveLength(1);
    expect(typeof factories[0]).toBe("function");
  });

  it("skips extension files that don't export a function", async () => {
    const builtinDir = path.join(tmpHome, "builtin-ext-bad");
    const dir = path.join(builtinDir, "bad-ext");
    fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "extensions", "not-a-fn.js"), `
      export const value = 42;
    `);
    const pm = new PluginManager({
      pluginsDirs: [builtinDir],
      dataDir,
      bus: await makeBus(),
    });
    pm.scan();
    await pm.loadAll();
    expect(pm.getExtensionFactories()).toHaveLength(0);
  });

  it("restricted plugins do not load extensions", async () => {
    const builtinDir = path.join(tmpHome, "builtin-ext-r");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-ext-r");
    const dir = path.join(communityDir, "restricted-ext");
    fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "extensions", "e.js"), `
      export default function(pi) { pi.on("tool_call", () => {}); }
    `);
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir],
      dataDir,
      bus: await makeBus(),
    });
    pm.scan();
    await pm.loadAll();
    expect(pm.getExtensionFactories()).toHaveLength(0);
  });

  it("unloadPlugin removes extension factories for that plugin", async () => {
    const builtinDir = path.join(tmpHome, "builtin-ext-unload");
    const dir = path.join(builtinDir, "unload-ext");
    fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "extensions", "e.js"), `
      export default function(pi) { pi.on("tool_call", () => {}); }
    `);
    const pm = new PluginManager({
      pluginsDirs: [builtinDir],
      dataDir,
      bus: await makeBus(),
    });
    pm.scan();
    await pm.loadAll();
    expect(pm.getExtensionFactories()).toHaveLength(1);
    await pm.unloadPlugin("unload-ext");
    expect(pm.getExtensionFactories()).toHaveLength(0);
  });
});

describe("configuration", () => {
  it("reads configuration schema from manifest", async () => {
    const dir = path.join(pluginsDir, "config-plug");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "config-plug", name: "Config Plugin", version: "1.0.0",
      contributes: { configuration: { properties: {
        interval: { type: "number", default: 25, title: "Interval" },
        enabled: { type: "boolean", default: true, title: "Enabled" },
      }}}
    }));
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    const schema = pm.getConfigSchema("config-plug");
    expect(schema.properties.interval.type).toBe("number");
  });

  it("getAllConfigSchemas returns schemas for all plugins", async () => {
    const dir = path.join(pluginsDir, "cfg");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "cfg", name: "C", version: "0.1.0",
      contributes: { configuration: { properties: { x: { type: "string" } } } }
    }));
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    const all = pm.getAllConfigSchemas();
    expect(all).toHaveLength(1);
    expect(all[0].pluginId).toBe("cfg");
  });
});

describe("agent templates", () => {
  it("loads agent templates from agents/ directory", async () => {
    const dir = path.join(pluginsDir, "agent-plug");
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agents", "translator.json"), JSON.stringify({
      name: "Translator", systemPrompt: "You are a translator.", defaultModel: "gpt-4o",
    }));
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    const templates = pm.getAgentTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe("Translator");
    expect(templates[0]._pluginId).toBe("agent-plug");
  });
});

describe("provider declarations", () => {
  it("loads provider plugin data from providers/ directory", async () => {
    const dir = path.join(pluginsDir, "prov-plug");
    fs.mkdirSync(path.join(dir, "providers"), { recursive: true });
    fs.writeFileSync(path.join(dir, "providers", "my-llm.js"), `
      export const id = "my-llm";
      export const displayName = "My LLM";
      export const authType = "api-key";
      export const defaultBaseUrl = "https://api.my-llm.com/v1";
      export const defaultApi = "openai-completions";
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    const providers = pm.getProviderPlugins();
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("my-llm");
  });
});

// ── 权限执行 ─────────────────────────────────────────────────────────────────

describe("permission enforcement", () => {
  it("builtin plugin always gets full-access (routes and extensions loaded)", async () => {
    const builtinDir = path.join(tmpHome, "builtin-plugins");
    const dir = path.join(builtinDir, "core-plug");
    fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "routes", "api.js"), `
      export function register(app) { app.get("/test", (c) => c.text("ok")); }
    `);
    fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "extensions", "ext.js"), `
      export default function(pi) { pi.on("tool_call", () => {}); }
    `);
    const pm = new PluginManager({
      pluginsDirs: [builtinDir],
      dataDir,
      bus: await makeBus(),
    });
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("core-plug");
    expect(entry.status).toBe("loaded");
    expect(entry.accessLevel).toBe("full-access");
    expect(pm.routeRegistry.has("core-plug")).toBe(true);
    expect(pm.getExtensionFactories()).toHaveLength(1);
  });

  it("community restricted plugin skips routes/extensions/providers/lifecycle", async () => {
    const builtinDir = path.join(tmpHome, "builtin-plugins-2");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-plugins");
    const dir = path.join(communityDir, "comm-plug");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test tool";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);
    fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "routes", "api.js"), `
      export function register(app) { app.get("/x", (c) => c.text("x")); }
    `);
    fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "extensions", "e.js"), `
      export default function(pi) { pi.on("tool_call", () => {}); }
    `);
    fs.mkdirSync(path.join(dir, "providers"), { recursive: true });
    fs.writeFileSync(path.join(dir, "providers", "p.js"), `
      export const id = "test-prov";
    `);
    fs.writeFileSync(path.join(dir, "index.js"), `
      export default class Plug { async onload() { this.loaded = true; } }
    `);

    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir],
      dataDir,
      bus: await makeBus(),
    });
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("comm-plug");
    expect(entry.status).toBe("loaded");
    expect(entry.accessLevel).toBe("restricted");
    // Declarative contributions loaded
    expect(pm.getAllTools().some(t => t.name === "comm-plug_t")).toBe(true);
    // System-level extension points NOT loaded
    expect(pm.routeRegistry.has("comm-plug")).toBe(false);
    expect(pm.getProviderPlugins().some(p => p._pluginId === "comm-plug")).toBe(false);
    expect(entry.instance).toBeNull();
    // Extensions not registered
    expect(pm.getExtensionFactories()).toHaveLength(0);
  });

  it("community full-access plugin with global toggle OFF → status 'restricted', not loaded", async () => {
    const builtinDir = path.join(tmpHome, "builtin-plugins-3");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-plugins-3");
    const dir = path.join(communityDir, "fa-plug");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "fa-plug", name: "Full Access Plug", version: "1.0.0",
      trust: "full-access",
    }));
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const mockPrefs = {
      getDisabledPlugins: () => [],
      getAllowFullAccessPlugins: () => false,
    };
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir],
      dataDir,
      bus: await makeBus(),
      preferencesManager: mockPrefs,
    });
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("fa-plug");
    expect(entry.status).toBe("restricted");
    // Nothing loaded
    expect(pm.getAllTools().some(t => t._pluginId === "fa-plug")).toBe(false);
  });

  it("community full-access plugin with global toggle ON → status 'loaded', routes loaded", async () => {
    const builtinDir = path.join(tmpHome, "builtin-plugins-4");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-plugins-4");
    const dir = path.join(communityDir, "fa-plug-on");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "fa-plug-on", name: "FA ON", version: "1.0.0",
      trust: "full-access",
    }));
    fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "routes", "api.js"), `
      export function register(app) { app.get("/y", (c) => c.text("y")); }
    `);

    const mockPrefs = {
      getDisabledPlugins: () => [],
      getAllowFullAccessPlugins: () => true,
    };
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir],
      dataDir,
      bus: await makeBus(),
      preferencesManager: mockPrefs,
    });
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("fa-plug-on");
    expect(entry.status).toBe("loaded");
    expect(entry.accessLevel).toBe("full-access");
    expect(pm.routeRegistry.has("fa-plug-on")).toBe(true);
  });

  it("disabled community plugin → status 'disabled', not loaded", async () => {
    const builtinDir = path.join(tmpHome, "builtin-perm-dis");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-perm-dis");
    const dir = path.join(communityDir, "disabled-plug");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const mockPrefs = {
      getDisabledPlugins: () => ["disabled-plug"],
      getAllowFullAccessPlugins: () => false,
    };
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir],
      dataDir,
      bus: await makeBus(),
      preferencesManager: mockPrefs,
    });
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("disabled-plug");
    expect(entry.status).toBe("disabled");
    // Nothing loaded
    expect(pm.getAllTools().some(t => t._pluginId === "disabled-plug")).toBe(false);
  });

  it("builtin plugin ignores disabled list and always loads", async () => {
    const dir = path.join(pluginsDir, "builtin-always");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const mockPrefs = {
      getDisabledPlugins: () => ["builtin-always"],
      getAllowFullAccessPlugins: () => false,
    };
    const pm = new PluginManager({
      pluginsDir,
      dataDir,
      bus: await makeBus(),
      preferencesManager: mockPrefs,
    });
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("builtin-always");
    expect(entry.status).toBe("loaded");
    expect(entry.source).toBe("builtin");
  });
});

// ── 动态工具注册 ──────────────────────────────────────────────────────────────

describe("addTool (dynamic registration)", () => {
  it("dynamically registered tool appears in getAllTools", async () => {
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    const remove = pm.addTool("mcp-bridge", {
      name: "search",
      description: "MCP search tool",
      execute: async () => "result",
    });
    const tools = pm.getAllTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("mcp-bridge_search");
    expect(tools[0]._dynamic).toBe(true);

    remove();
    expect(pm.getAllTools()).toHaveLength(0);
  });

  it("plugin can register tools via ctx.registerTool in onload", async () => {
    const dir = path.join(pluginsDir, "dyn-plug");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.js"), `
      export default class DynPlugin {
        async onload() {
          this.register(this.ctx.registerTool({
            name: "dynamic-tool",
            description: "Registered at runtime",
            execute: async (input) => "dynamic " + input.x,
          }));
        }
      }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();

    const tools = pm.getAllTools();
    expect(tools.some(t => t.name === "dyn-plug_dynamic-tool")).toBe(true);

    // unload should clean up
    await pm.unloadPlugin("dyn-plug");
    expect(pm.getAllTools().some(t => t.name === "dyn-plug.dynamic-tool")).toBe(false);
  });
});

// ── Hot operations ──────────────────────────────────────────────────────────

function createMockPrefs(overrides = {}) {
  return {
    _data: {
      allow_full_access_plugins: false,
      disabled_plugins: [],
      ...overrides,
    },
    getAllowFullAccessPlugins() { return this._data.allow_full_access_plugins; },
    setAllowFullAccessPlugins(v) { this._data.allow_full_access_plugins = v; },
    getDisabledPlugins() { return this._data.disabled_plugins; },
    setDisabledPlugins(list) { this._data.disabled_plugins = list; },
  };
}

describe("hot operations", () => {
  it("installPlugin loads a new plugin at runtime", async () => {
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    expect(pm.listPlugins()).toHaveLength(0);

    // Create new plugin dir after initial load
    const newDir = path.join(pluginsDir, "hot-plug");
    fs.mkdirSync(path.join(newDir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(newDir, "tools", "greet.js"), `
      export const name = "greet";
      export const description = "Greet someone";
      export const parameters = {};
      export async function execute() { return "hello"; }
    `);

    const entry = await pm.installPlugin(newDir);
    expect(entry.status).toBe("loaded");
    expect(pm.listPlugins()).toHaveLength(1);
    expect(pm.getAllTools().some(t => t.name === "hot-plug_greet")).toBe(true);
  });

  it("installPlugin upgrades an existing plugin (same dirName)", async () => {
    const dir = path.join(pluginsDir, "upgradeable");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "v1.js"), `
      export const name = "v1";
      export const description = "version 1";
      export const parameters = {};
      export async function execute() { return "v1"; }
    `);

    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    expect(pm.getAllTools().some(t => t.name === "upgradeable_v1")).toBe(true);

    // "Upgrade": overwrite tool file
    fs.writeFileSync(path.join(dir, "tools", "v2.js"), `
      export const name = "v2";
      export const description = "version 2";
      export const parameters = {};
      export async function execute() { return "v2"; }
    `);

    await pm.installPlugin(dir);
    // Old tool cleaned up, new tools loaded
    expect(pm.getAllTools().some(t => t.name === "upgradeable_v2")).toBe(true);
  });

  it("removePlugin unloads and removes from registry", async () => {
    const builtinDir = path.join(tmpHome, "builtin-remove");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-remove");
    const dir = path.join(communityDir, "removable");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const pm = new PluginManager({ pluginsDirs: [builtinDir, communityDir], dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    expect(pm.getPlugin("removable")).not.toBeNull();
    expect(pm.getAllTools().some(t => t._pluginId === "removable")).toBe(true);

    const pluginDir = await pm.removePlugin("removable");
    expect(pluginDir).toBe(dir);
    expect(pm.getPlugin("removable")).toBeNull();
    expect(pm.listPlugins()).toHaveLength(0);
    expect(pm.getAllTools().some(t => t._pluginId === "removable")).toBe(false);
  });

  it("removePlugin rejects builtin plugins", async () => {
    const dir = path.join(pluginsDir, "builtin-no-rm");
    fs.mkdirSync(dir, { recursive: true });
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    await expect(pm.removePlugin("builtin-no-rm")).rejects.toThrow("cannot be removed");
  });

  it("removePlugin cleans disabled list in preferencesManager", async () => {
    const builtinDir = path.join(tmpHome, "builtin-rm-dis");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-rm-dis");
    const dir = path.join(communityDir, "rm-disabled");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const mockPrefs = createMockPrefs({ disabled_plugins: ["rm-disabled"] });
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir], dataDir, bus: await makeBus(),
      preferencesManager: mockPrefs,
    });
    pm.scan();
    await pm.loadAll();

    await pm.removePlugin("rm-disabled");
    expect(mockPrefs.getDisabledPlugins()).not.toContain("rm-disabled");
  });

  it("removePlugin throws for unknown pluginId", async () => {
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    await expect(pm.removePlugin("nonexistent")).rejects.toThrow('Plugin "nonexistent" not found');
  });

  it("disablePlugin unloads and marks disabled", async () => {
    // 用双目录构造，让插件落在 community 索引（builtin 插件不可 disable）
    const builtinDir = path.join(tmpHome, "builtin-disable");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-disable");
    const dir = path.join(communityDir, "disableable");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const mockPrefs = createMockPrefs();
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir], dataDir, bus: await makeBus(),
      preferencesManager: mockPrefs,
    });
    pm.scan();
    await pm.loadAll();
    expect(pm.getPlugin("disableable").status).toBe("loaded");

    await pm.disablePlugin("disableable");
    expect(pm.getPlugin("disableable").status).toBe("disabled");
    expect(pm.getAllTools().some(t => t._pluginId === "disableable")).toBe(false);
    expect(mockPrefs.getDisabledPlugins()).toContain("disableable");
  });

  it("disablePlugin rejects builtin plugins", async () => {
    const dir = path.join(pluginsDir, "builtin-no-disable");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    await expect(pm.disablePlugin("builtin-no-disable")).rejects.toThrow("cannot be disabled");
  });

  it("enablePlugin loads previously disabled plugin", async () => {
    // 用双目录构造，让插件落在 community 索引（builtin 插件跳过 disabled 列表）
    const builtinDir = path.join(tmpHome, "builtin-enable");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-enable");
    const dir = path.join(communityDir, "enableable");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const mockPrefs = createMockPrefs({ disabled_plugins: ["enableable"] });
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir], dataDir, bus: await makeBus(),
      preferencesManager: mockPrefs,
    });
    pm.scan();
    await pm.loadAll();
    expect(pm.getPlugin("enableable").status).toBe("disabled");

    await pm.enablePlugin("enableable");
    expect(pm.getPlugin("enableable").status).toBe("loaded");
    expect(pm.getAllTools().some(t => t.name === "enableable_t")).toBe(true);
    expect(mockPrefs.getDisabledPlugins()).not.toContain("enableable");
  });

  it("setFullAccess(true) loads restricted community full-access plugins", async () => {
    const builtinDir = path.join(tmpHome, "builtin-hot-1");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-hot-1");
    const dir = path.join(communityDir, "fa-hot");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "fa-hot", name: "FA Hot", version: "1.0.0",
      trust: "full-access",
    }));
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const mockPrefs = createMockPrefs({ allow_full_access_plugins: false });
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir],
      dataDir, bus: await makeBus(),
      preferencesManager: mockPrefs,
    });
    pm.scan();
    await pm.loadAll();
    expect(pm.getPlugin("fa-hot").status).toBe("restricted");
    expect(pm.getAllTools().some(t => t._pluginId === "fa-hot")).toBe(false);

    await pm.setFullAccess(true);
    expect(pm.getPlugin("fa-hot").status).toBe("loaded");
    expect(pm.getAllTools().some(t => t._pluginId === "fa-hot")).toBe(true);
    expect(mockPrefs.getAllowFullAccessPlugins()).toBe(true);
  });

  it("setFullAccess(false) unloads community full-access plugins", async () => {
    const builtinDir = path.join(tmpHome, "builtin-hot-2");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-hot-2");
    const dir = path.join(communityDir, "fa-hot-off");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "fa-hot-off", name: "FA Hot Off", version: "1.0.0",
      trust: "full-access",
    }));
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const mockPrefs = createMockPrefs({ allow_full_access_plugins: true });
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir],
      dataDir, bus: await makeBus(),
      preferencesManager: mockPrefs,
    });
    pm.scan();
    await pm.loadAll();
    expect(pm.getPlugin("fa-hot-off").status).toBe("loaded");
    expect(pm.getAllTools().some(t => t._pluginId === "fa-hot-off")).toBe(true);

    await pm.setFullAccess(false);
    expect(pm.getPlugin("fa-hot-off").status).toBe("restricted");
    expect(pm.getAllTools().some(t => t._pluginId === "fa-hot-off")).toBe(false);
    expect(mockPrefs.getAllowFullAccessPlugins()).toBe(false);
  });

  it("setFullAccess skips disabled full-access plugins", async () => {
    const builtinDir = path.join(tmpHome, "builtin-hot-3");
    fs.mkdirSync(builtinDir, { recursive: true });
    const communityDir = path.join(tmpHome, "community-hot-3");
    const dir = path.join(communityDir, "fa-disabled");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "fa-disabled", name: "FA Disabled", version: "1.0.0",
      trust: "full-access",
    }));
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const mockPrefs = createMockPrefs({
      allow_full_access_plugins: false,
      disabled_plugins: ["fa-disabled"],
    });
    const pm = new PluginManager({
      pluginsDirs: [builtinDir, communityDir],
      dataDir, bus: await makeBus(),
      preferencesManager: mockPrefs,
    });
    pm.scan();
    await pm.loadAll();
    expect(pm.getPlugin("fa-disabled").status).toBe("disabled");

    await pm.setFullAccess(true);
    // Still disabled, not loaded
    expect(pm.getPlugin("fa-disabled").status).toBe("disabled");
  });

  it("isValidPluginDir detects valid plugin directories", async () => {
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });

    const validDir = path.join(pluginsDir, "valid-check");
    fs.mkdirSync(path.join(validDir, "tools"), { recursive: true });
    expect(pm.isValidPluginDir(validDir)).toBe(true);

    const manifestDir = path.join(pluginsDir, "manifest-check");
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, "manifest.json"), "{}");
    expect(pm.isValidPluginDir(manifestDir)).toBe(true);

    const emptyDir = path.join(pluginsDir, "empty-check");
    fs.mkdirSync(emptyDir, { recursive: true });
    expect(pm.isValidPluginDir(emptyDir)).toBe(false);
  });

  it("operations are serialized through the queue", async () => {
    const dir1 = path.join(pluginsDir, "serial-1");
    fs.mkdirSync(path.join(dir1, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir1, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);
    const dir2 = path.join(pluginsDir, "serial-2");
    fs.mkdirSync(path.join(dir2, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir2, "tools", "t.js"), `
      export const name = "t";
      export const description = "test";
      export const parameters = {};
      export async function execute() { return "ok"; }
    `);

    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });

    // Fire both installs concurrently
    const [e1, e2] = await Promise.all([
      pm.installPlugin(dir1),
      pm.installPlugin(dir2),
    ]);
    expect(e1.status).toBe("loaded");
    expect(e2.status).toBe("loaded");
    expect(pm.listPlugins()).toHaveLength(2);
  });
});

// ── Route context injection ───────────────────────────────────────────────────

describe("route ctx injection", () => {
  function makeBuiltinPluginDir(name) {
    // Routes are full-access only; use pluginsDirs[0] as builtin
    const builtinDir = path.join(tmpHome, `builtin-ctx-${name}`);
    const dir = path.join(builtinDir, name);
    return { builtinDir, dir };
  }

  it("factory function receives ctx as second arg", async () => {
    const { builtinDir, dir } = makeBuiltinPluginDir("factory-ctx");
    fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "routes", "api.js"), `
      export default function(app, ctx) {
        app.get("/test", (c) => c.json({ pluginId: ctx.pluginId }));
      }
    `);

    const pm = new PluginManager({
      pluginsDirs: [builtinDir],
      dataDir,
      bus: await makeBus(),
    });
    pm.scan();
    await pm.loadAll();

    const app = pm.routeRegistry.get("factory-ctx");
    expect(app).toBeTruthy();
    const res = await app.request(new Request("http://x/test"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pluginId).toBe("factory-ctx");
  });

  it("error isolation: handler that throws returns 500 JSON with plugin id", async () => {
    const { builtinDir, dir } = makeBuiltinPluginDir("error-isolation");
    fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "routes", "boom.js"), `
      export default function(app, ctx) {
        app.get("/boom", (c) => { throw new Error("intentional crash"); });
      }
    `);

    const pm = new PluginManager({
      pluginsDirs: [builtinDir],
      dataDir,
      bus: await makeBus(),
    });
    pm.scan();
    await pm.loadAll();

    const app = pm.routeRegistry.get("error-isolation");
    expect(app).toBeTruthy();
    const res = await app.request(new Request("http://x/boom"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Plugin internal error");
    expect(body.plugin).toBe("error-isolation");
  });

  it("register function receives ctx as second arg", async () => {
    const { builtinDir, dir } = makeBuiltinPluginDir("register-ctx");
    fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "routes", "api.js"), `
      export function register(app, ctx) {
        app.get("/who", (c) => c.json({ pluginId: ctx.pluginId }));
      }
    `);

    const pm = new PluginManager({
      pluginsDirs: [builtinDir],
      dataDir,
      bus: await makeBus(),
    });
    pm.scan();
    await pm.loadAll();

    const app = pm.routeRegistry.get("register-ctx");
    expect(app).toBeTruthy();
    const res = await app.request(new Request("http://x/who"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pluginId).toBe("register-ctx");
  });
});
