# Community Plugin Development Guide

> This document is for community developers who want to build user-installable plugins.
> System plugins (built-in features) use the same plugin format, placed in the project's `plugins/` directory and bundled with the app.

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
3. After installation, the Agent can immediately call `my-plugin_hello`
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
├── extensions/            # Pi SDK extension factories (requires full-access)
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

**What you cannot do:** `bus.handle`, routes, extensions, providers, `registerTool`, lifecycle (onload/onunload).

Restricted plugin tool/command code runs in the main process with full Node.js API access. The permission model controls "which system extension points you get", not code-level sandboxing.

### Full-access

Declare `"trust": "full-access"` in manifest:

```json
{
  "id": "my-advanced-plugin",
  "trust": "full-access",
  "minAppVersion": "0.82.0"
}
```

`minAppVersion` (optional) declares the minimum Hanako version required to run the plugin. If the current app version is lower, the plugin will not load and its status is set to `incompatible`. All plugins should declare this field to prevent compatibility issues on older versions.

The user must enable the "Allow full-access plugins" toggle in Settings → Plugins. **When the toggle is off, full-access plugins are not loaded at all** (no partial loading) until the user explicitly enables it.

In addition to restricted capabilities:

| Capability | Description |
|------------|-------------|
| `bus.handle` | Register capabilities for other plugins to call |
| `routes/*.js` | HTTP endpoints |
| `extensions/*.js` | Pi SDK event interception (tool calls, provider requests, etc.) |
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

- Automatically namespaced: `pluginId_name` (e.g. `my-plugin_search`)
- Restricted plugins' `toolCtx.bus` only has `emit/subscribe/request`, not `handle`

#### Media Delivery

When a tool needs to deliver files, declare `media` in the return value's `details`:

```js
return {
  content: [{ type: "text", text: "Image generated" }],
  details: {
    media: { mediaUrls: ["/path/to/image.png"] },
  },
};
```

The framework automatically extracts `details.media.mediaUrls` and delivers them according to context (desktop renders file cards, bridge sends to the other party). The tool itself doesn't need to be aware of the runtime environment.

#### Visual Cards

Tools can automatically render visual cards (iframes) in the chat by declaring `card` in the return value's `details`:

```js
return {
  content: [{ type: "text", text: "Data summary..." }],
  details: {
    card: {
      type: "iframe",
      route: "/card/chart?symbol=sh600519&period=daily",
      title: "Kweichow Moutai Daily K",
      description: "Kweichow Moutai price 1450.00 change +2.11%",
    },
  },
};
```

- `route`: Plugin route path; the iframe fetches data and renders from this path
- `title`: Card title (optional)
- `description`: Plain text summary, used for IM platform fallback and when the plugin is uninstalled
- `pluginId` is auto-injected by the framework; tools don't need to set it
- Cards render immediately when the tool completes, independent of LLM behavior
- Card data is stored in JSONL with the toolResult and auto-restored on session reload

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
    const result = await ctx.bus.request("session:send", {
      text,
      sessionPath: "/path/to/session.jsonl",  // required
    });
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

All three patterns are backward-compatible: plugins that don't use ctx need no changes. `ctx.bus` can directly call built-in session operations: `session:send`, `session:abort`, `session:history`, `session:list`, `agent:list`. All session-related operations must include a `sessionPath` parameter. See the Route Context and Session Bus Handlers sections below for the full API.

### Extensions (Pi SDK Event Interception) ⚡ full-access

Each `.js` file in the `extensions/` directory exports a factory function that receives Pi SDK's `ExtensionAPI` and subscribes to LLM pipeline events:

```js
// extensions/strip-empty-tools.js
export default function(pi) {
  pi.on("before_provider_request", (event) => {
    const p = event.payload;
    if (p && Array.isArray(p.tools) && p.tools.length === 0) {
      delete p.tools;
    }
    return p;
  });
}
```

Common events:

| Event | Timing | What you can do |
|-------|--------|-----------------|
| `tool_call` | Before tool execution | Modify args, block the call |
| `tool_result` | After tool returns | Modify the result |
| `before_provider_request` | Before HTTP request | Rewrite payload |
| `context` | Before each LLM call | Filter/inject messages |
| `before_agent_start` | After user input | Inject system prompt |
| `input` | When user input arrives | Intercept/transform input |

Factory functions are invoked by Pi SDK at session creation time; handlers fire when the corresponding event occurs. See Pi SDK extension documentation for the full event list.

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

### Page (Plugin Page) ⚡ full-access

A plugin can register a full-page view in the top tab bar, at the same level as "Chat/Channel". When the user switches to that tab, the plugin's iframe occupies the entire window space.

Declare in `manifest.json` under `contributes`:

```json
{
  "contributes": {
    "page": {
      "title": { "zh": "金融", "en": "Finance" },
      "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5'><polyline points='22 12 18 12 15 21 9 3 6 12 2 12'/></svg>",
      "route": "/dashboard"
    }
  }
}
```

- `title`: Display name. Accepts a plain string or an i18n object `{ zh, en, ... }`
- `icon`: Strongly recommended to provide an inline SVG (stroke style, `currentColor`). Falls back to the first character of the title if omitted
- `route`: Relative path for the plugin route. The actual URL is `/api/plugins/{pluginId}{route}`
- A plugin can declare both a `page` and a `widget` simultaneously — they are independent
- Hovering over the tab shows the plugin's full name (tooltip)
- When there are more than 5 tabs, extras are collapsed into an overflow dropdown menu; users can drag to reorder

Plugin pages are rendered via iframe. The plugin must send a handshake signal after loading:

```js
window.parent.postMessage({ type: 'ready' }, '*');
```

The host appends `hana-theme` and `hana-css` query parameters to the iframe URL. Plugins can optionally reference the theme CSS for visual consistency:

```html
<link rel="stylesheet" href="${new URLSearchParams(location.search).get('hana-css')}">
```

### Widget (Sidebar Component) ⚡ full-access

A plugin can register a component in the right-side Jian sidebar. A widget and a page can be declared simultaneously in the same plugin — they are independent and do not conflict.

```json
{
  "contributes": {
    "widget": {
      "title": { "zh": "盯盘", "en": "Monitor" },
      "icon": "<svg viewBox='0 0 24 24' .../>",
      "route": "/sidebar"
    }
  }
}
```

Field rules are the same as Page. The widget appears alongside the desk in the Jian sidebar, controlled by a button on the right side of the titlebar. When no widgets are registered, the button area is automatically hidden.

Widgets are also rendered via iframe and must send the `ready` handshake signal.

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

Tool names are auto-prefixed with `pluginId_` and auto-removed on unload via `register()`.

## Forward Compatibility

The system ignores unrecognized directories and manifest fields. Old plugins always work on new systems; new plugins on old systems simply have new contribution types silently ignored. No `manifestVersion` needed, no version migration required.

## Error Isolation

- A single plugin's `onload()` failure does not block other plugins or system startup
- A syntax error in a single tool/route/command file only affects that file
- Failed plugins are marked `status: "failed"` and show error info on the plugins page

## Concurrency

Hana supports multiple sessions and multiple agents running in parallel. Keep the following in mind when developing plugins:

- All session-related EventBus events (`session:send`, `session:abort`, etc.) must include a `sessionPath` parameter to identify the target session
- Tools can obtain the current session path via `ctx.sessionManager.getSessionFile()`
- Do not use `engine.currentSessionPath` or `engine.currentAgentId` (these are UI focus pointers and do not represent the currently executing session)

```js
// Correct: explicitly specify sessionPath
await bus.request("session:send", {
  text: "Hello",
  sessionPath: "/path/to/session.jsonl",
});

await bus.request("session:abort", {
  sessionPath: "/path/to/session.jsonl",
});

// Wrong: omitting sessionPath may target the wrong session under concurrency
await bus.request("session:send", { text: "Hello" });
```
