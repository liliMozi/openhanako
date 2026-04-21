import { Hono } from "hono";
import fs from "fs";
import path from "path";
import os from "os";
import { extractZip } from "../../lib/extract-zip.js";
import { resolveAgent } from "../utils/resolve-agent.js";
import { fromRoot } from "../../shared/hana-root.js";

/**
 * 代理分发：将 /plugins/:pluginId/* 的请求转发到对应 plugin 子 app。
 * @param {import("hono").Context} c
 * @param {import("hono").Hono} pluginApp
 * @param {string} pluginId
 * @param {string} [agentId] - 当前 agent id，注入到子请求的 X-Hana-Agent-Id header
 */
async function proxyToPlugin(c, pluginApp, pluginId, agentId) {
  const url = new URL(c.req.url);
  const prefix = `/plugins/${pluginId}`;
  const prefixIndex = url.pathname.indexOf(prefix);
  const subPath = prefixIndex !== -1
    ? url.pathname.slice(prefixIndex + prefix.length) || "/"
    : "/";
  url.pathname = subPath;

  const headers = new Headers(c.req.raw.headers);
  if (agentId) headers.set("X-Hana-Agent-Id", agentId);

  const subReq = new Request(url.toString(), {
    method: c.req.method,
    headers,
    body: c.req.method !== "GET" && c.req.method !== "HEAD"
      ? c.req.raw.body
      : undefined,
  });
  return pluginApp.fetch(subReq);
}

/**
 * Standalone route proxy (for tests).
 * @param {Map<string, import("hono").Hono>} routeRegistry
 */
export function createPluginProxyRoute(routeRegistry) {
  const route = new Hono();
  route.all("/plugins/:pluginId/*", async (c) => {
    const pluginId = c.req.param("pluginId");
    const pluginApp = routeRegistry.get(pluginId);
    if (!pluginApp) return c.json({ error: `Plugin "${pluginId}" not found` }, 404);
    return proxyToPlugin(c, pluginApp, pluginId);
  });
  return route;
}

/**
 * Plugin management REST API + route proxy (combined).
 * @param {import('../../core/engine.js').HanaEngine} engine
 */
export function createPluginsRoute(engine) {
  const route = new Hono();

  /**
   * 可见插件过滤 + 序列化（单一出口，所有返回插件列表的端点共用）。
   * hidden 插件（系统插件）永远不暴露给前端管理页。
   * @param {object} [opts]
   * @param {string} [opts.source] - 按 source 过滤（"community" | "builtin"）
   */
  function visiblePlugins(pm, opts = {}) {
    let plugins = pm.listPlugins().filter(p => !p.hidden);
    if (opts.source) plugins = plugins.filter(p => p.source === opts.source);
    return plugins.map(p => ({
      id: p.id, name: p.name, version: p.version,
      description: p.description, status: p.status,
      source: p.source || "community", trust: p.trust || "restricted",
      contributions: p.contributions,
      error: p.error || null,
    }));
  }

  // ── Management API (specific routes first) ──

  route.get("/plugins", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    return c.json(visiblePlugins(pm, { source: c.req.query("source") }));
  });

  route.get("/plugins/config-schemas", (c) => {
    const pm = engine.pluginManager;
    return c.json(pm?.getAllConfigSchemas() || []);
  });

  route.get("/plugins/:id/config-schema", (c) => {
    const pm = engine.pluginManager;
    const schema = pm?.getConfigSchema(c.req.param("id"));
    if (!schema) return c.json({ error: "not found" }, 404);
    return c.json(schema);
  });

  // ── Plugin install ──
  route.post("/plugins/install", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const { path: sourcePath } = await c.req.json();
    if (!sourcePath) return c.json({ error: "path is required" }, 400);

    try {
      const stat = fs.statSync(sourcePath);
      let targetDir;
      const userPluginsDir = pm.getUserPluginsDir();
      // Ensure plugins directory exists
      fs.mkdirSync(userPluginsDir, { recursive: true });

      if (sourcePath.endsWith(".zip")) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-install-"));
        extractZip(sourcePath, tmpDir);
        const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
        const pluginSrc = entries.length === 1 && entries[0].isDirectory()
          ? path.join(tmpDir, entries[0].name)
          : tmpDir;
        const dirName = path.basename(pluginSrc);
        targetDir = path.join(userPluginsDir, dirName);
        // Atomic install: copy to temp target, then rename
        const tmpTarget = targetDir + ".installing";
        if (fs.existsSync(tmpTarget)) fs.rmSync(tmpTarget, { recursive: true });
        fs.cpSync(pluginSrc, tmpTarget, { recursive: true });
        if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true });
        fs.renameSync(tmpTarget, targetDir);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } else if (stat.isDirectory()) {
        const dirName = path.basename(sourcePath);
        targetDir = path.join(userPluginsDir, dirName);
        const tmpTarget = targetDir + ".installing";
        if (fs.existsSync(tmpTarget)) fs.rmSync(tmpTarget, { recursive: true });
        fs.cpSync(sourcePath, tmpTarget, { recursive: true });
        if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true });
        fs.renameSync(tmpTarget, targetDir);
      } else {
        return c.json({ error: "Path must be a .zip file or directory" }, 400);
      }

      if (!pm.isValidPluginDir(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
        return c.json({ error: "Not a valid plugin directory" }, 400);
      }

      const entry = await pm.installPlugin(targetDir);
      engine.syncPluginExtensions();
      return c.json(entry);
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── Plugin delete ──
  route.delete("/plugins/:id", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const id = c.req.param("id");
    try {
      const pluginDir = await pm.removePlugin(id);
      engine.syncPluginExtensions();
      if (pluginDir && fs.existsSync(pluginDir)) {
        fs.rmSync(pluginDir, { recursive: true, force: true });
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 404);
    }
  });

  // ── Plugin enable/disable ──
  route.put("/plugins/:id/enabled", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const id = c.req.param("id");
    const { enabled } = await c.req.json();
    try {
      if (enabled) {
        await pm.enablePlugin(id);
      } else {
        await pm.disablePlugin(id);
      }
      engine.syncPluginExtensions();
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 404);
    }
  });

  // ── Global plugin settings ──
  route.get("/plugins/settings", (c) => {
    const pm = engine.pluginManager;
    return c.json({
      allow_full_access: pm?.getAllowFullAccess() || false,
      plugins_dir: pm?.getUserPluginsDir() || "",
    });
  });

  route.put("/plugins/settings", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const { allow_full_access } = await c.req.json();
    if (typeof allow_full_access === "boolean") {
      await pm.setFullAccess(allow_full_access);
      engine.syncPluginExtensions();
    }
    return c.json(visiblePlugins(pm, { source: "community" }));
  });

  // ── Plugin UI panel endpoints ──

  route.get("/plugins/pages", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    const pages = pm.getPages().map(p => ({
      pluginId: p.pluginId,
      title: p.title,
      icon: p.icon,
      routeUrl: `/api/plugins/${p.pluginId}${p.route}`,
    }));
    return c.json(pages);
  });

  route.get("/plugins/widgets", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    const widgets = pm.getWidgets().map(w => ({
      pluginId: w.pluginId,
      title: w.title,
      icon: w.icon,
      routeUrl: `/api/plugins/${w.pluginId}${w.route}`,
    }));
    return c.json(widgets);
  });

  route.get("/plugins/theme.css", (c) => {
    const theme = c.req.query("theme") || "warm-paper";
    // Sanitize theme name to prevent path traversal
    const safeName = path.basename(theme).replace(/[^a-zA-Z0-9_-]/g, "");
    const candidates = [
      fromRoot("desktop", "src", "themes", `${safeName}.css`),
      fromRoot("desktop", "dist-renderer", "themes", `${safeName}.css`),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) {
      c.header("Content-Type", "text/css");
      return c.body("/* theme not found */");
    }
    let css = fs.readFileSync(found, "utf-8");
    // Flatten selectors for iframe consumption:
    // [data-theme="xxx"], :root:not([data-theme]) → :root
    // [data-theme="xxx"] → :root
    css = css.replace(/\[data-theme="[^"]*"\](?:,\s*:root:not\(\[data-theme\]\))?/g, ":root");
    c.header("Content-Type", "text/css");
    c.header("Cache-Control", "public, max-age=300");
    return c.body(css);
  });

  // ── Plugin route proxy (catch-all last) ──

  route.all("/plugins/:pluginId/*", async (c) => {
    const pluginId = c.req.param("pluginId");
    const pluginApp = engine.pluginManager?.getRouteApp(pluginId);
    if (!pluginApp) return c.json({ error: `Plugin "${pluginId}" not found` }, 404);
    const agent = resolveAgent(engine, c);
    const agentId = agent?.id || null;
    return proxyToPlugin(c, pluginApp, pluginId, agentId);
  });

  return route;
}
