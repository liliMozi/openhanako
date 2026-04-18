import fs from "fs";
import path from "path";
import { createPluginContext } from "./plugin-context.js";
import { freshImport } from "./fresh-import.js";

const KNOWN_CONTRIBUTION_DIRS = [
  "tools", "routes", "skills", "agents", "commands", "providers",
];

/** Semver compare: returns true if a >= b */
function semverGte(a, b) {
  const pa = (a || "0.0.0").split(".").map(Number);
  const pb = (b || "0.0.0").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return true;
}

export class PluginManager {
  /**
   * @param {{ pluginsDirs: string[], dataDir: string, bus: object }} opts
   * pluginsDirs: 多个扫描目录，先内嵌后用户（靠前的优先）
   * 兼容旧签名 { pluginsDir: string } → 自动转为单元素数组
   */
  constructor({ pluginsDirs, pluginsDir, dataDir, bus, preferencesManager, appVersion, getSessionPath }) {
    this._pluginsDirs = pluginsDirs || (pluginsDir ? [pluginsDir] : []);
    this._dataDir = dataDir;
    this._bus = bus;
    this._preferencesManager = preferencesManager || null;
    this._appVersion = appVersion || "0.0.0";
    this._getSessionPath = getSessionPath || (() => null);
    this._plugins = new Map();
    this._scanned = [];
    this._opQueue = Promise.resolve();
    this.routeRegistry = new Map();

    // Contribution registries
    this._tools = [];
    this._commands = [];
    this._skillPaths = [];
    this._agentTemplates = [];
    this._providerPlugins = [];
    this._configSchemas = [];
    // extensionFactories: Array<{ pluginId: string, factory: Function }>
    this._extensionFactories = [];
    this._pages = [];
    this._widgets = [];
  }

  scan() {
    const results = [];
    const seen = new Set();
    for (let i = 0; i < this._pluginsDirs.length; i++) {
      const dir = this._pluginsDirs[i];
      const source = i === 0 ? "builtin" : "community";
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);
        const pluginDir = path.join(dir, entry.name);
        try {
          const desc = this._readPluginDescriptor(pluginDir, entry.name);
          desc.source = source;
          if (seen.has(`id:${desc.id}`)) {
            console.warn(`[plugin-manager] plugin id "${desc.id}" 冲突（目录 "${entry.name}"），跳过`);
            continue;
          }
          seen.add(`id:${desc.id}`);
          results.push(desc);
        } catch (err) {
          console.error(`[plugin-manager] failed to read plugin "${entry.name}":`, err.message);
        }
      }
    }
    this._scanned = results;
    return results;
  }

  _readPluginDescriptor(pluginDir, dirName) {
    const manifestPath = path.join(pluginDir, "manifest.json");
    let manifest = null;
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    }
    const id = manifest?.id || dirName;
    const name = manifest?.name || dirName;
    const version = manifest?.version || "0.0.0";
    const description = manifest?.description || "";
    const contributions = [];
    for (const dir of KNOWN_CONTRIBUTION_DIRS) {
      if (fs.existsSync(path.join(pluginDir, dir))) contributions.push(dir);
    }
    if (fs.existsSync(path.join(pluginDir, "extensions"))) contributions.push("extensions");
    if (fs.existsSync(path.join(pluginDir, "index.js"))) contributions.push("lifecycle");
    const trust = manifest?.trust === "full-access" ? "full-access" : "restricted";
    const hidden = !!manifest?.hidden;
    return { id, name, version, description, pluginDir, manifest, contributions, trust, hidden };
  }

  async loadAll() {
    const descriptors = this._scanned.length > 0 ? this._scanned : this.scan();
    const disabledList = this._preferencesManager?.getDisabledPlugins() || [];
    for (const desc of descriptors) {
      const entry = { ...desc, status: "loading", instance: null, _disposables: [] };

      // builtin 插件不受 disabled 列表和全权开关约束，始终加载
      if (desc.source !== "builtin" && disabledList.includes(desc.id)) {
        entry.status = "disabled";
        this._plugins.set(desc.id, entry);
        continue;
      }

      if (desc.source === "community" && desc.trust === "full-access") {
        const allowed = this._preferencesManager?.getAllowFullAccessPlugins() || false;
        if (!allowed) {
          entry.status = "restricted";
          this._plugins.set(desc.id, entry);
          continue;
        }
      }

      // minAppVersion check
      const minVer = desc.manifest?.minAppVersion;
      if (minVer && !semverGte(this._appVersion, minVer)) {
        entry.status = "incompatible";
        entry.error = `requires app v${minVer}+, current v${this._appVersion}`;
        this._plugins.set(desc.id, entry);
        console.warn(`[plugin-manager] "${desc.id}" skipped: ${entry.error}`);
        continue;
      }

      this._plugins.set(desc.id, entry);
      try {
        await this._loadPlugin(entry);
        entry.status = "loaded";
      } catch (err) {
        entry.status = "failed";
        entry.error = err.message;
        console.error(`[plugin-manager] plugin "${desc.id}" failed to load:`, err.message);
      }
    }
  }

  async _loadPlugin(entry) {
    const accessLevel = (entry.source === "builtin" || entry.trust === "full-access")
      ? "full-access"
      : "restricted";
    entry.accessLevel = accessLevel;

    entry.ctx = createPluginContext({
      pluginId: entry.id,
      pluginDir: entry.pluginDir,
      dataDir: path.join(this._dataDir, entry.id),
      bus: this._bus,
      accessLevel,
    });

    // All plugins: declarative contributions
    await this._loadTools(entry);
    await this._loadSkillPaths(entry);
    await this._loadCommands(entry);
    await this._loadAgentTemplates(entry);  // JSON declaration, no code execution
    this._loadConfiguration(entry);

    // Full-access only: system-level extension points
    if (accessLevel === "full-access") {
      await this._loadRoutes(entry);
      await this._loadExtensions(entry);
      await this._loadProviders(entry);
      this._loadPage(entry);
      this._loadWidget(entry);

      // Lifecycle (index.js)
      const indexPath = path.join(entry.pluginDir, "index.js");
      if (fs.existsSync(indexPath)) {
        const mod = await freshImport(indexPath);
        const PluginClass = mod.default;
        if (PluginClass && typeof PluginClass === "function") {
          const instance = new PluginClass();
          entry.instance = instance;
          instance.ctx = entry.ctx;
          instance.register = (disposable) => {
            if (typeof disposable === "function") entry._disposables.push(disposable);
          };
          instance.ctx.registerTool = (toolDef) => this.addTool(entry.id, toolDef);
          if (typeof instance.onload === "function") await instance.onload();
        }
      }
    }
  }

  // ── Task 5: Tool loader ──────────────────────────────────────────────────

  async _loadTools(entry) {
    const toolsDir = path.join(entry.pluginDir, "tools");
    if (!fs.existsSync(toolsDir)) return;
    const files = fs.readdirSync(toolsDir).filter((f) => f.endsWith(".js"));
    const ctx = entry.ctx;
    for (const file of files) {
      const filePath = path.join(toolsDir, file);
      try {
        const mod = await freshImport(filePath);
        if (!mod.name || !mod.description || typeof mod.execute !== "function") continue;
        const origExecute = mod.execute;
        this._tools.push({
          name: `${entry.id}_${mod.name}`,
          description: mod.description,
          parameters: mod.parameters ?? {},
          ...(mod.promptSnippet ? { promptSnippet: mod.promptSnippet } : {}),
          ...(mod.promptGuidelines ? { promptGuidelines: mod.promptGuidelines } : {}),
          execute: async (_toolCallId, params, runtimeCtx) => {
            // 优先从 Pi SDK runtime ctx 获取 sessionPath，fallback 到焦点回调（过渡期）
            const sessionPath = runtimeCtx?.sessionManager?.getSessionFile?.()
              || this._getSessionPath?.();
            const sessionCtx = { sessionPath };
            const mergedCtx = runtimeCtx
              ? { ...ctx, ...sessionCtx, ...runtimeCtx }
              : { ...ctx, ...sessionCtx };
            const raw = await origExecute(params, mergedCtx);
            // Pi SDK 期望 { content: ContentBlock[], details? }
            // Plugin tool 可能返回纯字符串，需要包装
            let result;
            if (typeof raw === "string") {
              result = { content: [{ type: "text", text: raw }] };
            } else if (raw && raw.content) {
              result = raw;
            } else {
              result = { content: [{ type: "text", text: String(raw ?? "") }] };
            }
            // Plugin Card: auto-inject pluginId
            if (result.details?.card && !result.details.card.pluginId) {
              result.details.card.pluginId = ctx.pluginId;
            }
            return result;
          },
          _pluginId: entry.id,
        });
      } catch (err) {
        console.error(`[plugin-manager] tool "${file}" in "${entry.id}" failed to load:`, err.message);
      }
    }
  }

  /**
   * 动态注册工具（供 plugin 在 onload 中调用，如 MCP bridge）
   * @param {string} pluginId
   * @param {{ name: string, description: string, parameters?: object, execute: Function }} toolDef
   * @returns {Function} 清理函数（调用即移除该工具）
   */
  addTool(pluginId, toolDef) {
    const tool = {
      name: `${pluginId}_${toolDef.name}`,
      description: toolDef.description || "",
      parameters: toolDef.parameters || { type: "object", properties: {} },
      execute: toolDef.execute,
      _pluginId: pluginId,
      _dynamic: true,
    };
    this._tools.push(tool);
    return () => {
      const idx = this._tools.indexOf(tool);
      if (idx !== -1) this._tools.splice(idx, 1);
    };
  }

  getAllTools() {
    return [...this._tools];
  }

  // ── Task 6: Skill paths + Command loader ────────────────────────────────

  async _loadSkillPaths(entry) {
    const skillsDir = path.join(entry.pluginDir, "skills");
    if (!fs.existsSync(skillsDir)) return;
    this._skillPaths.push({
      dirPath: skillsDir,
      label: `plugin:${entry.id}`,
      builtin: entry.source === "builtin",
    });
  }

  getSkillPaths() {
    return [...this._skillPaths];
  }

  async _loadCommands(entry) {
    const cmdsDir = path.join(entry.pluginDir, "commands");
    if (!fs.existsSync(cmdsDir)) return;
    const files = fs.readdirSync(cmdsDir).filter((f) => f.endsWith(".js"));
    for (const file of files) {
      const filePath = path.join(cmdsDir, file);
      try {
        const mod = await freshImport(filePath);
        if (!mod.name || typeof mod.execute !== "function") continue;
        this._commands.push({
          name: `${entry.id}.${mod.name}`,
          description: mod.description ?? "",
          execute: mod.execute,
          _pluginId: entry.id,
        });
      } catch (err) {
        console.error(`[plugin-manager] command "${file}" in "${entry.id}" failed to load:`, err.message);
      }
    }
  }

  getAllCommands() {
    return [...this._commands];
  }

  // ── Task 7: Route loader ─────────────────────────────────────────────────

  async _loadRoutes(entry) {
    const routesDir = path.join(entry.pluginDir, "routes");
    if (!fs.existsSync(routesDir)) return;
    const { Hono } = await import("hono");
    const app = new Hono();
    const ctx = entry.ctx;

    // Error isolation: Hono's onError is the correct hook for handler throws
    app.onError((err, c) => {
      ctx.log.error("route error:", err.message);
      return c.json({ error: "Plugin internal error", plugin: entry.id }, 500);
    });

    // Middleware: inject ctx + agentId (from proxy header)
    app.use("*", async (c, next) => {
      c.set("pluginCtx", ctx);
      const agentId = c.req.header("X-Hana-Agent-Id") || null;
      c.set("agentId", agentId);
      await next();
    });

    const files = fs.readdirSync(routesDir).filter((f) => f.endsWith(".js"));
    for (const file of files) {
      const filePath = path.join(routesDir, file);
      try {
        const mod = await freshImport(filePath);
        if (typeof mod.default === "function") {
          const sub = mod.default;
          if (sub && typeof sub.fetch === "function") {
            // Static Hono app — inject ctx + agentId middleware onto sub-app too
            sub.use("*", async (c, next) => {
              c.set("pluginCtx", ctx);
              const agentId = c.req.header("X-Hana-Agent-Id") || null;
              c.set("agentId", agentId);
              await next();
            });
            const prefix = "/" + path.basename(file, ".js");
            app.route(prefix, sub);
          } else if (typeof sub === "function") {
            // Factory function — pass ctx as second arg
            sub(app, ctx);
          }
        }
        if (mod.register && typeof mod.register === "function") {
          mod.register(app, ctx);
        }
      } catch (err) {
        console.error(`[plugin-manager] route "${file}" in "${entry.id}" failed to load:`, err.message);
      }
    }
    this.routeRegistry.set(entry.id, app);
  }

  // ── Task 8: Extension loader ─────────────────────────────────────────────

  /**
   * 加载 extensions/ 目录下的 Pi SDK extension 工厂函数。
   * 每个 .js 文件导出 (pi: ExtensionAPI) => void，在 session 创建时被 Pi SDK 调用。
   */
  async _loadExtensions(entry) {
    const extDir = path.join(entry.pluginDir, "extensions");
    if (!fs.existsSync(extDir)) return;
    const files = fs.readdirSync(extDir).filter((f) => f.endsWith(".js"));
    for (const file of files) {
      const filePath = path.join(extDir, file);
      try {
        const mod = await freshImport(filePath);
        const factory = mod.default ?? mod;
        if (typeof factory !== "function") {
          console.warn(`[plugin-manager] extension "${file}" in "${entry.id}" does not export a function, skipped`);
          continue;
        }
        this._extensionFactories.push({ pluginId: entry.id, factory });
      } catch (err) {
        console.error(`[plugin-manager] extension "${file}" in "${entry.id}" failed to load:`, err.message);
      }
    }
  }

  // ── Task 9: Configuration loader ─────────────────────────────────────────

  _loadConfiguration(entry) {
    const schema = entry.manifest?.contributes?.configuration;
    if (!schema) return;
    this._configSchemas.push({ pluginId: entry.id, schema });
  }

  getConfigSchema(pluginId) {
    return this._configSchemas.find((s) => s.pluginId === pluginId)?.schema ?? null;
  }

  getAllConfigSchemas() {
    return [...this._configSchemas];
  }

  // ── Page / Widget loader ──────────────────────────────────────────────────

  _loadPage(entry) {
    const page = entry.manifest?.contributes?.page;
    if (!page) return;
    if (entry.accessLevel !== 'full-access') {
      entry.ctx?.log?.warn('page contribution requires full-access, skipping');
      return;
    }
    const routesDir = path.join(entry.pluginDir, 'routes');
    if (!fs.existsSync(routesDir)) {
      entry.ctx?.log?.warn(`page declares route "${page.route}" but routes/ directory not found`);
      return;
    }
    this._pages.push({
      pluginId: entry.id,
      title: page.title || entry.id,
      icon: page.icon || null,
      route: page.route,
    });
  }

  _loadWidget(entry) {
    const widget = entry.manifest?.contributes?.widget;
    if (!widget) return;
    if (entry.accessLevel !== 'full-access') {
      entry.ctx?.log?.warn('widget contribution requires full-access, skipping');
      return;
    }
    const routesDir = path.join(entry.pluginDir, 'routes');
    if (!fs.existsSync(routesDir)) {
      entry.ctx?.log?.warn(`widget declares route "${widget.route}" but routes/ directory not found`);
      return;
    }
    this._widgets.push({
      pluginId: entry.id,
      title: widget.title || entry.id,
      icon: widget.icon || null,
      route: widget.route,
    });
  }

  // ── Task 10: Agent templates + Provider loader ───────────────────────────

  async _loadAgentTemplates(entry) {
    const agentsDir = path.join(entry.pluginDir, "agents");
    if (!fs.existsSync(agentsDir)) return;
    const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(agentsDir, file);
      try {
        const template = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        template._pluginId = entry.id;
        this._agentTemplates.push(template);
      } catch (err) {
        console.error(`[plugin-manager] agent template "${file}" in "${entry.id}" failed to load:`, err.message);
      }
    }
  }

  getAgentTemplates() {
    return [...this._agentTemplates];
  }

  async _loadProviders(entry) {
    const providersDir = path.join(entry.pluginDir, "providers");
    if (!fs.existsSync(providersDir)) return;
    const files = fs.readdirSync(providersDir).filter((f) => f.endsWith(".js"));
    for (const file of files) {
      const filePath = path.join(providersDir, file);
      try {
        const mod = await freshImport(filePath);
        if (!mod.id) continue;
        this._providerPlugins.push({ ...mod, _pluginId: entry.id });
      } catch (err) {
        console.error(`[plugin-manager] provider "${file}" in "${entry.id}" failed to load:`, err.message);
      }
    }
  }

  getProviderPlugins() {
    return [...this._providerPlugins];
  }

  // ── Operation queue ───────────────────────────────────────────────────────

  _enqueue(fn) {
    const op = this._opQueue.then(fn);
    this._opQueue = op.catch(err => {
      console.error("[plugin-manager] op failed:", err);
    });
    return op; // caller gets success/failure
  }

  // ── Hot operations ───────────────────────────────────────────────────────

  async installPlugin(pluginDir) {
    return this._enqueue(async () => {
      const dirName = path.basename(pluginDir);
      // Check for existing (upgrade scenario)
      const existing = [...this._plugins.values()].find(
        p => path.basename(p.pluginDir) === dirName
      );
      if (existing) {
        await this.unloadPlugin(existing.id);
        this._plugins.delete(existing.id);
      }

      const desc = this._readPluginDescriptor(pluginDir, dirName);
      desc.source = "community";
      const disabledList = this._preferencesManager?.getDisabledPlugins() || [];

      const entry = { ...desc, status: "loading", instance: null, _disposables: [] };
      this._plugins.set(desc.id, entry);

      if (disabledList.includes(desc.id)) {
        entry.status = "disabled";
        return entry;
      }

      if (desc.trust === "full-access") {
        const allowed = this._preferencesManager?.getAllowFullAccessPlugins() || false;
        if (!allowed) {
          entry.status = "restricted";
          return entry;
        }
      }

      try {
        await this._loadPlugin(entry);
        entry.status = "loaded";
      } catch (err) {
        entry.status = "failed";
        entry.error = err.message;
      }
      this._bus?.emit({ type: "plugin_ui_changed" });
      return entry;
    });
  }

  async removePlugin(pluginId) {
    return this._enqueue(async () => {
      const entry = this._plugins.get(pluginId);
      if (!entry) throw new Error(`Plugin "${pluginId}" not found`);
      if (entry.source === "builtin") throw new Error(`Builtin plugin "${pluginId}" cannot be removed`);
      if (entry.status === "loaded" || entry.status === "failed") {
        await this.unloadPlugin(pluginId);
      }
      this._plugins.delete(pluginId);
      if (this._preferencesManager) {
        const disabled = this._preferencesManager.getDisabledPlugins();
        this._preferencesManager.setDisabledPlugins(
          disabled.filter(id => id !== pluginId)
        );
      } else {
        console.warn("[plugin-manager] removePlugin: preferencesManager unavailable, disabled list not updated");
      }
      this._bus?.emit({ type: "plugin_ui_changed" });
      return entry.pluginDir;
    });
  }

  async disablePlugin(pluginId) {
    return this._enqueue(async () => {
      const entry = this._plugins.get(pluginId);
      if (!entry) throw new Error(`Plugin "${pluginId}" not found`);
      if (entry.source === "builtin") throw new Error(`Builtin plugin "${pluginId}" cannot be disabled`);
      if (entry.status === "loaded") {
        await this.unloadPlugin(pluginId);
      }
      entry.status = "disabled";
      if (this._preferencesManager) {
        const disabled = this._preferencesManager.getDisabledPlugins();
        if (!disabled.includes(pluginId)) {
          this._preferencesManager.setDisabledPlugins([...disabled, pluginId]);
        }
      } else {
        console.warn("[plugin-manager] disablePlugin: preferencesManager unavailable, preference not persisted");
      }
      this._bus?.emit({ type: "plugin_ui_changed" });
    });
  }

  async enablePlugin(pluginId) {
    return this._enqueue(async () => {
      const entry = this._plugins.get(pluginId);
      if (!entry) throw new Error(`Plugin "${pluginId}" not found`);
      // builtin 插件始终 loaded，跳过偏好写入
      if (entry.source === "builtin") return;
      if (this._preferencesManager) {
        const disabled = this._preferencesManager.getDisabledPlugins();
        this._preferencesManager.setDisabledPlugins(
          disabled.filter(id => id !== pluginId)
        );
      } else {
        console.warn("[plugin-manager] enablePlugin: preferencesManager unavailable, preference not persisted");
      }
      if (entry.trust === "full-access" && entry.source === "community") {
        const allowed = this._preferencesManager?.getAllowFullAccessPlugins() || false;
        if (!allowed) {
          entry.status = "restricted";
          this._bus?.emit({ type: "plugin_ui_changed" });
          return;
        }
      }
      // Guard: unload before re-loading to prevent duplicate tool/command/route registration
      if (entry.status === "loaded") {
        await this.unloadPlugin(pluginId);
      }
      try {
        await this._loadPlugin(entry);
        entry.status = "loaded";
      } catch (err) {
        entry.status = "failed";
        entry.error = err.message;
      }
      this._bus?.emit({ type: "plugin_ui_changed" });
    });
  }

  async setFullAccess(allow) {
    return this._enqueue(async () => {
      if (this._preferencesManager) {
        this._preferencesManager.setAllowFullAccessPlugins(allow);
      } else {
        console.warn("[plugin-manager] setFullAccess: preferencesManager unavailable, preference not persisted");
      }
      for (const entry of this._plugins.values()) {
        if (entry.source !== "community" || entry.trust !== "full-access") continue;
        const disabledList = this._preferencesManager?.getDisabledPlugins() || [];
        if (disabledList.includes(entry.id)) continue;

        if (allow && entry.status === "restricted") {
          try {
            await this._loadPlugin(entry);
            entry.status = "loaded";
          } catch (err) {
            entry.status = "failed";
            entry.error = err.message;
          }
        } else if (!allow && entry.status === "loaded") {
          await this.unloadPlugin(entry.id);
          entry.status = "restricted";
        }
      }
      this._bus?.emit({ type: "plugin_ui_changed" });
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async unloadPlugin(pluginId) {
    const entry = this._plugins.get(pluginId);
    if (!entry) return;

    // 1. 生命周期清理（onunload + disposables）
    if (entry.instance) {
      if (typeof entry.instance.onunload === "function") {
        try { await entry.instance.onunload(); } catch (err) {
          console.error(`[plugin-manager] "${pluginId}" onunload error:`, err.message);
        }
      }
      for (const d of entry._disposables.reverse()) {
        try { d(); } catch (err) {
          console.error(`[plugin-manager] "${pluginId}" disposable error:`, err.message);
        }
      }
      entry._disposables = [];
    }

    // 2. 清理静态贡献（文件约定加载的 tools、commands 等）
    this._tools = this._tools.filter(t => t._pluginId !== pluginId);
    this._commands = this._commands.filter(c => c._pluginId !== pluginId);
    this._skillPaths = this._skillPaths.filter(s => s.label !== `plugin:${pluginId}`);
    this._agentTemplates = this._agentTemplates.filter(t => t._pluginId !== pluginId);
    this._providerPlugins = this._providerPlugins.filter(p => p._pluginId !== pluginId);
    this._configSchemas = this._configSchemas.filter(s => s.pluginId !== pluginId);
    this._extensionFactories = this._extensionFactories.filter(e => e.pluginId !== pluginId);
    this._pages = this._pages.filter(p => p.pluginId !== pluginId);
    this._widgets = this._widgets.filter(w => w.pluginId !== pluginId);
    this.routeRegistry.delete(pluginId);

    entry.status = "unloaded";
  }

  // ── Public getters (route 层通过这些方法访问，不穿透私有字段) ──

  /** 用户（社区）插件目录 */
  getUserPluginsDir() {
    return this._pluginsDirs[this._pluginsDirs.length - 1] || null;
  }

  /** 是否允许 full-access 社区插件 */
  getAllowFullAccess() {
    return this._preferencesManager?.getAllowFullAccessPlugins() || false;
  }

  /** 检测目录是否为合法插件 */
  isValidPluginDir(dirPath) {
    const validMarkers = [
      ...KNOWN_CONTRIBUTION_DIRS,
      "manifest.json", "index.js", "extensions",
    ];
    return validMarkers.some(marker => {
      const p = path.join(dirPath, marker);
      return fs.existsSync(p);
    });
  }

  /** 获取指定插件的路由 app */
  getRouteApp(pluginId) {
    return this.routeRegistry.get(pluginId) || null;
  }

  /** 获取所有活跃插件的 extension 工厂函数（供 Engine 注入 Pi SDK） */
  getExtensionFactories() {
    return this._extensionFactories.map(e => e.factory);
  }

  getPages() { return [...this._pages]; }
  getWidgets() { return [...this._widgets]; }

  getPlugin(id) { return this._plugins.get(id) || null; }
  listPlugins() { return [...this._plugins.values()]; }
}
