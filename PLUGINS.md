# 社区插件开发指南

> 本文档面向社区开发者，描述如何开发用户可安装的插件。
> 系统插件（内嵌到 app 的内置功能）使用相同的插件格式，放在项目 `plugins/` 目录下随 app 打包分发。

## 快速开始

1. 创建一个文件夹，放入一个工具文件：

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

2. 打开 Hanako → 设置 → 插件，把文件夹拖进安装区（或压缩成 .zip 拖入）
3. 安装后 Agent 立即可以调用 `my-plugin.hello` 工具
4. 卸载：在插件页面点删除按钮

## 安装与管理

### 安装方式

- **拖拽安装**：将插件文件夹或 .zip 拖入设置 → 插件页面的安装区
- **文件选择器**：点击安装区，通过文件选择器选择插件文件夹或 .zip
- **手动安装**：将插件目录放到 `~/.hanako/plugins/`（开发环境为 `~/.hanako-dev/plugins/`）

### 管理操作

所有操作即时生效，无需重启：

- **启用/禁用**：每个插件有独立开关
- **删除**：移除插件代码，插件数据（`plugin-data/{pluginId}/`）保留
- **升级**：拖入同名新版本会自动替换旧版，需要重启一次以加载新代码

### 插件数据

插件私有数据自动存放在 `~/.hanako/plugin-data/{pluginId}/`（开发环境 `~/.hanako-dev/plugin-data/{pluginId}/`）。删除插件时此目录保留，重新安装后配置还在。

## 目录结构

```text
my-plugin/
├── manifest.json          # 可选，复杂声明才需要
├── tools/                 # 工具（Agent 调用）
│   └── *.js
├── skills/                # 知识注入（Markdown）
│   └── my-skill/
│       └── SKILL.md
├── commands/              # 用户命令（斜杠触发）
│   └── *.js
├── agents/                # Agent 模板（JSON）
│   └── *.json
├── routes/                # HTTP 路由（需要 full-access）
│   └── *.js
├── providers/             # LLM Provider 声明（需要 full-access）
│   └── *.js
├── extensions/            # Pi SDK extension 工厂（需要 full-access）
│   └── *.js
└── index.js               # 可选，有状态 plugin 入口，最后加载（需要 full-access）
```

标注"需要 full-access"的贡献类型，仅在 manifest 声明 `"trust": "full-access"` 且用户开启全权开关后才生效。

## 权限模型

社区插件分两级权限。这个划分决定了插件能使用哪些系统能力。

### Restricted（默认）

不需要在 manifest 里声明，社区插件默认就是 restricted。

**可以做的事：**

| 能力 | 说明 |
|------|------|
| `tools/*.js` | 声明工具供 Agent 调用 |
| `skills/` | Markdown 知识注入 |
| `commands/*.js` | 用户命令 |
| `agents/*.json` | Agent 模板（JSON 声明） |
| `ctx.config` | 读写自己的配置 |
| `ctx.dataDir` | 自己的数据目录 |
| `bus.emit / subscribe / request` | 发布事件、订阅事件、调用别人的能力 |
| `contributes.configuration` | JSON Schema 配置声明 |

**不能做的事：** `bus.handle`、routes、extensions、providers、`registerTool`、lifecycle（onload/onunload）。

restricted 插件的 tool/command 代码在主进程运行，有完整的 Node.js API 访问能力。权限模型管的是"系统给你什么扩展接口"，不是代码级沙盒。

### Full-access

在 manifest 中声明 `"trust": "full-access"`：

```json
{
  "id": "my-advanced-plugin",
  "trust": "full-access"
}
```

用户需要在设置 → 插件页面开启"允许全权插件"开关。**开关关着时，full-access 插件完全不会加载**（不会部分加载），直到用户主动打开开关。

在 restricted 基础上额外获得：

| 能力 | 说明 |
|------|------|
| `bus.handle` | 注册能力供其他 plugin 调用 |
| `routes/*.js` | HTTP 端点 |
| `extensions/*.js` | Pi SDK 事件拦截（tool 调用、provider 请求等） |
| `providers/*.js` | LLM Provider |
| `ctx.registerTool` | 运行时动态注册工具 |
| `onload` / `onunload` | 生命周期钩子 |

**没有声明 `trust` 或声明为其他值的插件，一律按 restricted 处理。**

## 贡献类型详解

### Tools（工具）

`tools/*.js` 每个文件 export：

```js
export const name = "search";           // 必须
export const description = "...";       // 必须
export const parameters = { ... };      // JSON Schema，可选
export async function execute(input, toolCtx) {  // 必须
  // input: 用户传入的参数
  // toolCtx: { pluginId, pluginDir, dataDir, bus, config, log }
  return "result";
}
```

- 自动加命名空间前缀：`pluginId_name`（如 `my-plugin_search`）
- restricted 插件的 `toolCtx.bus` 只有 `emit/subscribe/request`，没有 `handle`

#### 媒体交付

工具需要交付文件时，在返回值的 `details` 中声明 `media`：

```js
return {
  content: [{ type: "text", text: "已生成图片" }],
  details: {
    media: { mediaUrls: ["/path/to/image.png"] },
  },
};
```

框架会自动提取 `details.media.mediaUrls` 并根据上下文投递（桌面渲染文件卡片，bridge 发送给对方）。工具本身不需要感知运行环境。

### Skills（知识注入）

`skills/*/SKILL.md`，标准 frontmatter 格式：

```markdown
---
name: my-skill
description: 这个 skill 做什么
---
# 正文内容
Agent 在需要时会自动加载这段知识。
```

零代码，和 Claude Code 的 skill 模式一致。

### Commands（用户命令）

`commands/*.js` 每个文件 export：

```js
export const name = "focus";
export const description = "Start focus mode";
export async function execute(args, cmdCtx) {
  // args: 用户输入的参数文本
  // cmdCtx: { sessionPath, agentId, bus, config, log }
}
```

### Agents（Agent 模板）

`agents/*.json`：

```json
{
  "name": "Translator",
  "systemPrompt": "You are a translator.",
  "defaultModel": "gpt-4o",
  "defaultTools": ["web-search"]
}
```

### Routes（HTTP 路由）⚡ full-access

`routes/*.js` 支持三种写法，自动挂载到 `/api/plugins/{pluginId}/...`：

**写法 A：工厂函数**（推荐，ctx 作为参数直接可用）

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

**写法 B：静态 Hono app**（通过中间件取 ctx）

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

**写法 C：register 导出**

```js
// routes/status.js
export function register(app, ctx) {
  app.get("/status", (c) => c.json({ pluginId: ctx.pluginId }));
}
```

三种写法向后兼容：不使用 ctx 的老插件无需改动。`ctx.bus` 可直接调用内置 session 操作：`session:send`、`session:abort`、`session:history`、`session:list`、`agent:list`。详见下方 Route Context 和 Session Bus Handlers 章节。

### Extensions（Pi SDK 事件拦截）⚡ full-access

`extensions/` 目录下的每个 `.js` 文件导出一个工厂函数，接收 Pi SDK 的 `ExtensionAPI`，可以订阅 LLM 调用链上的事件：

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

常用事件：

| 事件 | 时机 | 能做什么 |
|------|------|----------|
| `tool_call` | 工具调用前 | 修改参数、block 调用 |
| `tool_result` | 工具返回后 | 修改返回结果 |
| `before_provider_request` | HTTP 请求发出前 | 改写 payload |
| `context` | 每次 LLM 调用前 | 过滤/注入消息 |
| `before_agent_start` | 用户输入后 | 注入 system prompt |
| `input` | 用户输入到达时 | 拦截/变换输入 |

工厂函数在 session 创建时被 Pi SDK 调用，handler 在对应事件触发时执行。完整事件列表参见 Pi SDK extension 文档。

### Providers（LLM Provider）⚡ full-access

`providers/*.js` export ProviderPlugin 数据对象：

```js
export const id = "my-llm";
export const displayName = "My LLM Service";
export const authType = "api-key";
export const defaultBaseUrl = "https://api.my-llm.com/v1";
export const defaultApi = "openai-completions";
```

### Configuration（配置 schema）

在 `manifest.json` 的 `contributes.configuration` 中用 JSON Schema 声明：

```json
{
  "contributes": {
    "configuration": {
      "properties": {
        "interval": { "type": "number", "default": 25, "title": "工作间隔（分钟）" },
        "sound": { "type": "boolean", "default": true, "title": "结束提示音" }
      }
    }
  }
}
```

配置通过 `ctx.config.get(key)` / `ctx.config.set(key, value)` 读写，持久化在 `plugin-data/{pluginId}/config.json`。

### Page（插件页面）⚡ full-access

插件可以在顶部 tab 栏注册一个全页面视图，跟「聊天/频道」同级。切换到该 tab 后，插件的 iframe 占据整个窗口空间。

在 `manifest.json` 的 `contributes` 中声明：

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

- `title`：显示名，支持字符串或 `{ zh, en, ... }` 国际化对象
- `icon`：强烈建议提供内联 SVG（stroke 风格，`currentColor`）。缺省时取 title 首字
- `route`：插件 route 的相对路径，实际 URL 为 `/api/plugins/{pluginId}{route}`
- 一个插件最多声明一个 `page` 或一个 `widget`，不能同时声明
- 悬停 tab 时显示插件全名（tooltip）
- Tab 超过 5 个时自动折叠到 overflow 下拉菜单，用户可拖拽排序

插件页面通过 iframe 渲染，需要在加载完成后发送握手信号：

```js
window.parent.postMessage({ type: 'ready' }, '*');
```

宿主会在 iframe URL 上附加 `hana-theme` 和 `hana-css` 参数，插件可选择引用主题 CSS 以保持视觉一致：

```html
<link rel="stylesheet" href="${new URLSearchParams(location.search).get('hana-css')}">
```

### Widget（侧栏组件）⚡ full-access

插件可以在右侧 Jian 侧栏注册一个组件。Widget 与 Page 可以同时声明，互不冲突。

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

字段规则同 Page。Widget 在 Jian 侧栏的书桌旁显示，由 titlebar 右侧的按钮控制。没有 widget 注册时按钮区域自动隐藏。

Widget 同样通过 iframe 渲染，需要发送 `ready` 握手信号。

## Manifest

大多数 plugin 不需要 manifest。只有以下场景需要：

- 声明 `trust: "full-access"` 获取完整权限
- Configuration schema（JSON Schema 声明）
- Plugin 元信息（名称、版本、描述，给管理 UI 展示）
- 软依赖声明

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

没有 manifest 时，`id` 从目录名推导，其他字段默认空，权限为 restricted。

## 有状态 Plugin（生命周期）⚡ full-access

如果 plugin 需要持久连接、定时任务或 bus handler，创建 `index.js`：

```js
export default class MyPlugin {
  async onload() {
    // ctx 由 PluginManager 注入：
    // this.ctx.bus          — EventBus（完整版：emit/subscribe/request/handle）
    // this.ctx.config       — 配置读写（get/set）
    // this.ctx.dataDir      — 私有数据目录路径
    // this.ctx.log          — 带 pluginId 前缀的 logger
    // this.ctx.pluginId     — plugin id
    // this.ctx.pluginDir    — plugin 安装目录
    // this.ctx.registerTool — 动态注册工具（返回清理函数）

    // register() 注册的资源在卸载时自动清理（逆序）
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
    // register() 注册的东西自动清理，不需要手动 unhandle
    // 只清理框架管不到的资源
    this.ws?.close();
  }
}
```

## 总线通信（bus.request / bus.handle）

Plugin 间通信通过 EventBus 的请求-响应机制。`bus.handle` 需要 full-access 权限，`bus.request` 所有插件都可以用。

```js
// Plugin A（full-access）: 注册能力
this.register(
  this.ctx.bus.handle("bridge:send", async (payload) => {
    if (payload.platform !== "telegram") return EventBus.SKIP;
    await telegramBot.send(payload.chatId, payload.text);
    return { sent: true };
  })
);

// Plugin B（任意权限）: 调用能力
if (this.ctx.bus.hasHandler("bridge:send")) {
  const result = await this.ctx.bus.request("bridge:send", {
    platform: "telegram",
    chatId: "123",
    text: "Hello",
  });
}
```

**命名规范**：`领域:动作`，冒号分隔。如 `bridge:send`、`memory:query`、`timer:schedule`。

**SKIP 链**：同一事件类型可以注册多个 handler。系统按注册顺序调用，直到某个 handler 返回非 `EventBus.SKIP` 的值。返回 `EventBus.SKIP` 表示"我不处理，交给下一个"：

```js
this.register(
  this.ctx.bus.handle("bridge:send", async (payload) => {
    if (payload.platform !== "telegram") return EventBus.SKIP;
    await telegramBot.send(payload.chatId, payload.text);
    return { sent: true };
  })
);
```

**错误处理**：
- 无 handler → 抛 `BusNoHandlerError`
- 超时（默认 30s）→ 抛 `BusTimeoutError`
- handler 业务错误 → 直接透传

**软依赖**：manifest 的 `depends.capabilities` 只是提示，系统不会因缺失而阻止安装。Plugin 代码用 `bus.hasHandler()` 在运行时做优雅降级。

### 动态工具注册 ⚡ full-access

Plugin 可以在 `onload()` 中通过 `ctx.registerTool()` 动态注册工具，适用于运行时才知道有哪些工具的场景（如 MCP bridge）：

```js
this.register(this.ctx.registerTool({
  name: "dynamic-search",
  description: "Dynamically registered tool",
  parameters: { type: "object", properties: { query: { type: "string" } } },
  execute: async (input) => { ... },
}));
```

工具名自动加 `pluginId_` 前缀，通过 `register()` 在卸载时自动移除。

## 前向兼容

系统忽略不认识的目录和 manifest 字段。老 plugin 永远能跑在新系统上，新 plugin 在老系统上只是新贡献类型不生效。不需要 `manifestVersion`，不需要版本迁移。

## 错误隔离

- 单个 plugin 的 `onload()` 失败不阻塞其他 plugin 和系统启动
- 单个 tool/route/command 文件的语法错误只影响该文件
- 失败的 plugin 标记为 `status: "failed"`，在插件页面显示错误信息
