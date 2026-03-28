# Community Plugin Development Guide

> This document is for community developers who want to build user-installable plugins.
> For system plugins (built-in features bundled with the app), see `.docs/SYSTEM-PLUGINS.md`.

## Quick Start

1. Create a folder with a tool file:

```text
my-plugin/
└── tools/
    └── hello.js
```

```js
// tools/hello.js
export const name = "hello";
export const description = "Say hello to someone";
export const parameters = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
};
export async function execute(input) {
  return `Hello, ${input.name}!`;
}
```

2. Open Hanako → Settings → Plugins, drag the folder into the install area (or drag a .zip)
3. After installation, the Agent can immediately call `my-plugin.hello`
4. Uninstall: click the delete button on the plugins page

## Installation & Management

### Installation Methods

- **Drag-and-drop**: Drag a plugin folder or .zip into Settings → Plugins install area
- **File picker**: Click the install area and select a plugin folder or .zip via the file picker
- **Manual**: Place the plugin directory in `~/.hanako/plugins/` (dev environment: `~/.hanako-dev/plugins/`)

### Management

All operations take effect immediately, no restart required:

- **Enable/Disable**: Each plugin has its own toggle
- **Delete**: Removes plugin code; plugin data (`plugin-data/{pluginId}/`) is preserved
- **Upgrade**: Dragging in a new version with the same name automatically replaces the old one (requires one restart to load new code)

### Plugin Data

Plugin private data is stored in `~/.hanako/plugin-data/{pluginId}/` (dev: `~/.hanako-dev/plugin-data/{pluginId}/`). This directory is preserved when the plugin is deleted, so config persists across reinstalls.

## Directory Structure

```text
my-plugin/
├── manifest.json          # Optional, only needed for complex declarations
├── tools/                 # Tools (called by Agent)
│   └── *.js
├── skills/                # Knowledge injection (Markdown)
│   └── my-skill/
│       └── SKILL.md
├── commands/              # User commands (slash-triggered)
│   └── *.js
├── agents/                # Agent templates (JSON)
│   └── *.json
├── routes/                # HTTP routes (requires full-access)
│   └── *.js
├── providers/             # LLM Provider declarations (requires full-access)
│   └── *.js
├── hooks.json             # Event interception mapping (requires full-access)
├── hooks/                 # Hook handler scripts (requires full-access)
│   └── *.js
└── index.js               # Optional, stateful plugin entry point, loaded last (requires full-access)
```

Contribution types marked "requires full-access" only take effect when the manifest declares `"trust": "full-access"` and the user enables the full-access toggle.

## Permission Model

Community plugins have two permission levels. This determines which system capabilities a plugin can access.

### Restricted (default)

No manifest declaration needed; community plugins default to restricted.

**What you can do:**

| Capability | Description |
|------------|-------------|
| `tools/*.js` | Declare tools for Agent to call |
| `skills/` | Markdown knowledge injection |
| `commands/*.js` | User commands |
| `agents/*.json` | Agent templates (JSON declarations) |
| `ctx.config` | Read/write own configuration |
| `ctx.dataDir` | Own data directory |
| `bus.emit / subscribe / request` | Publish events, subscribe to events, call others' capabilities |
| `contributes.configuration` | JSON Schema config declarations |

**What you cannot do:** `bus.handle`, routes, hooks, providers, `registerTool`, lifecycle (onload/onunload).

Restricted plugin tool/command code runs in the main process with full Node.js API access. The permission model controls "which system extension points you get", not code-level sandboxing.

### Full-access

Declare `"trust": "full-access"` in manifest:

```json
{
  "id": "my-advanced-plugin",
  "trust": "full-access"
}
```

The user must enable the "Allow full-access plugins" toggle in Settings → Plugins. **When the toggle is off, full-access plugins are not loaded at all** (no partial loading) until the user explicitly enables it.

In addition to restricted capabilities:

| Capability | Description |
|------------|-------------|
| `bus.handle` | Register capabilities for other plugins to call |
| `routes/*.js` | HTTP endpoints |
| `hooks.json` | Intercept system events |
| `providers/*.js` | LLM Providers |
| `ctx.registerTool` | Dynamically register tools at runtime |
| `onload` / `onunload` | Lifecycle hooks |

**Plugins without `trust` or with any other value are treated as restricted.**

## Contribution Types

### Tools

`tools/*.js` each file exports:

```js
export const name = "search";           // required
export const description = "...";       // required
export const parameters = { ... };      // JSON Schema, optional
export async function execute(input, toolCtx) {  // required
  // input: user-provided parameters
  // toolCtx: { pluginId, pluginDir, dataDir, bus, config, log }
  return "result";
}
```

- Automatically namespaced: `pluginId.name`
- Restricted plugins' `toolCtx.bus` only has `emit/subscribe/request`, not `handle`

### Skills (Knowledge Injection)

`skills/*/SKILL.md`, standard frontmatter format:

```markdown
---
name: my-skill
description: What this skill does
---
# Content
The Agent loads this knowledge automatically when needed.
```

Zero code, same pattern as Claude Code skills.

### Commands (User Commands)

`commands/*.js` each file exports:

```js
export const name = "focus";
export const description = "Start focus mode";
export async function execute(args, cmdCtx) {
  // args: user input text
  // cmdCtx: { sessionPath, agentId, bus, config, log }
}
```

### Agents (Agent Templates)

`agents/*.json`:

```json
{
  "name": "Translator",
  "systemPrompt": "You are a translator.",
  "defaultModel": "gpt-4o",
  "defaultTools": ["web-search"]
}
```

### Routes (HTTP Routes) ⚡ full-access

`routes/*.js` supports three patterns, auto-mounted at `/api/plugins/{pluginId}/...`:

**Pattern A: Factory function** (recommended, ctx available as parameter)

```js
// routes/chat.js
export default function (app, ctx) {
  app.post("/send", async (c) => {
    const { text } = await c.req.json();
    const result = await ctx.bus.request("session:send", { text });
    return c.json(result);
  });
}
```

**Pattern B: Static Hono app** (get ctx via middleware)

```js
// routes/webhook.js
import { Hono } from "hono";
const route = new Hono();
route.get("/webhook", (c) => {
  const ctx = c.get("pluginCtx");
  return c.json({ ok: true, plugin: ctx.pluginId });
});
export default route;
```

**Pattern C: Register export**

```js
// routes/status.js
export function register(app, ctx) {
  app.get("/status", (c) => c.json({ pluginId: ctx.pluginId }));
}
```

All three patterns are backward-compatible: plugins that don't use ctx need no changes. `ctx.bus` can directly call built-in session operations: `session:send`, `session:abort`, `session:history`, `session:list`, `agent:list`. See the Route Context and Session Bus Handlers sections in `.docs/PLUGIN-DEV.md` for the full API.

### Hooks (Event Interception) ⚡ full-access

`hooks.json` maps event types to handler scripts:

```json
{
  "session:before-send": "./hooks/inject.js",
  "agent:init": "./hooks/setup.js"
}
```

Hook event types come in two flavors:

- **before-\* types** (e.g. `session:before-send`): Intercept and optionally modify the event
  - Return `null` → cancel the event (no further handlers execute)
  - Return a new object → replace the event, continue to next handler
  - Return `undefined` → pass through unchanged
- **Regular types** (e.g. `agent:init`): Observe the event; the last handler returning non-`undefined` determines the final result

Handler signature:

```js
// hooks/inject.js
export default async function(event, hookCtx) {
  // hookCtx: { pluginId, eventType, bus }
  return event;
}
```

### Providers (LLM Provider) ⚡ full-access

`providers/*.js` export a ProviderPlugin data object:

```js
export const id = "my-llm";
export const displayName = "My LLM Service";
export const authType = "api-key";
export const defaultBaseUrl = "https://api.my-llm.com/v1";
export const defaultApi = "openai-completions";
```

### Configuration (Config Schema)

Declare in `manifest.json` under `contributes.configuration` using JSON Schema:

```json
{
  "contributes": {
    "configuration": {
      "properties": {
        "interval": { "type": "number", "default": 25, "title": "Work interval (minutes)" },
        "sound": { "type": "boolean", "default": true, "title": "Completion sound" }
      }
    }
  }
}
```

Read/write config via `ctx.config.get(key)` / `ctx.config.set(key, value)`, persisted in `plugin-data/{pluginId}/config.json`.

## Manifest

Most plugins don't need a manifest. Only required for:

- Declaring `trust: "full-access"` for full permissions
- Configuration schema (JSON Schema declarations)
- Plugin metadata (name, version, description for the management UI)
- Soft dependency declarations

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "trust": "full-access",
  "contributes": {
    "configuration": { ... }
  },
  "depends": {
    "capabilities": ["bridge:send"]
  }
}
```

Without a manifest, `id` is derived from the directory name, other fields default to empty, and permission is restricted.

## Stateful Plugins (Lifecycle) ⚡ full-access

If a plugin needs persistent connections, scheduled tasks, or bus handlers, create `index.js`:

```js
export default class MyPlugin {
  async onload() {
    // ctx is injected by PluginManager:
    // this.ctx.bus          — EventBus (full: emit/subscribe/request/handle)
    // this.ctx.config       — Config read/write (get/set)
    // this.ctx.dataDir      — Private data directory path
    // this.ctx.log          — Logger with pluginId prefix
    // this.ctx.pluginId     — Plugin ID
    // this.ctx.pluginDir    — Plugin installation directory
    // this.ctx.registerTool — Dynamic tool registration (returns cleanup function)

    // Resources registered via register() are auto-cleaned on unload (reverse order)
    this.register(
      this.ctx.bus.handle("bridge:send", async (payload) => {
        if (payload.platform !== "feishu") return EventBus.SKIP;
        await this.sendToFeishu(payload);
        return { sent: true };
      })
    );

    this.ws = await this.connect();
  }

  async onunload() {
    // Resources from register() are auto-cleaned, no manual unhandle needed
    // Only clean up things the framework can't manage
    this.ws?.close();
  }
}
```

## Bus Communication (bus.request / bus.handle)

Inter-plugin communication uses EventBus request-response. `bus.handle` requires full-access permission; `bus.request` is available to all plugins.

```js
// Plugin A (full-access): register a capability
this.register(
  this.ctx.bus.handle("bridge:send", async (payload) => {
    if (payload.platform !== "telegram") return EventBus.SKIP;
    await telegramBot.send(payload.chatId, payload.text);
    return { sent: true };
  })
);

// Plugin B (any permission): call the capability
if (this.ctx.bus.hasHandler("bridge:send")) {
  const result = await this.ctx.bus.request("bridge:send", {
    platform: "telegram",
    chatId: "123",
    text: "Hello",
  });
}
```

**Naming convention**: `domain:action`, colon-separated. E.g. `bridge:send`, `memory:query`, `timer:schedule`.

**SKIP chain**: Multiple handlers can be registered for the same event type. The system calls them in registration order until one returns a value other than `EventBus.SKIP`. Returning `EventBus.SKIP` means "I don't handle this, pass it on":

```js
this.register(
  this.ctx.bus.handle("bridge:send", async (payload) => {
    if (payload.platform !== "telegram") return EventBus.SKIP;
    await telegramBot.send(payload.chatId, payload.text);
    return { sent: true };
  })
);
```

**Error handling**:
- No handler → throws `BusNoHandlerError`
- Timeout (default 30s) → throws `BusTimeoutError`
- Handler business errors → propagated directly

**Soft dependencies**: `depends.capabilities` in manifest is advisory only; the system won't block installation if capabilities are missing. Plugin code uses `bus.hasHandler()` for graceful degradation at runtime.

### Dynamic Tool Registration ⚡ full-access

Plugins can dynamically register tools in `onload()` via `ctx.registerTool()`, useful when tools are discovered at runtime (e.g. MCP bridge):

```js
this.register(this.ctx.registerTool({
  name: "dynamic-search",
  description: "Dynamically registered tool",
  parameters: { type: "object", properties: { query: { type: "string" } } },
  execute: async (input) => { ... },
}));
```

Tool names are auto-prefixed with `pluginId.` and auto-removed on unload via `register()`.

## Forward Compatibility

The system ignores unrecognized directories and manifest fields. Old plugins always work on new systems; new plugins on old systems simply have new contribution types silently ignored. No `manifestVersion` needed, no version migration required.

## Error Isolation

- A single plugin's `onload()` failure does not block other plugins or system startup
- A syntax error in a single tool/route/command file only affects that file
- Failed plugins are marked `status: "failed"` and show error info on the plugins page
