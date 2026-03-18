# 服务端 (server/)

Server 层用 Fastify 框架搭建 HTTP + WebSocket 服务，是前端和核心引擎之间的桥梁。

## 文件清单

| 文件 | 职责 |
|------|------|
| index.js | 主入口，启动服务、初始化引擎 |
| boot.cjs | CJS 启动包装器（Electron fork 用） |
| ws-protocol.js | WebSocket 消息协议定义 |
| cli.js | 命令行交互界面 |
| i18n.js | 国际化 |
| session-stream-store.js | Session 流状态存储 |
| routes/*.js | 各路由模块 |

---

## 启动流程 (index.js)

```
1. 创建 Fastify 实例
   ├── CORS 配置
   └── WebSocket 插件

2. 生成安全 Token（随机 hex）

3. 创建 HanaEngine
   └── { hanakoHome, productDir }

4. engine.init(log)
   └── 初始化所有 Agent、模型、技能

5. 创建 Hub
   └── 消息调度中枢

6. 创建 BridgeManager
   └── 外部平台管理

7. 注册所有路由
   ├── chatRoute (WebSocket)
   ├── sessionsRoute
   ├── agentsRoute
   ├── configRoute
   ├── modelsRoute
   ├── providersRoute
   ├── preferencesRoute
   ├── deskRoute
   ├── channelsRoute
   ├── dmRoute
   ├── bridgeRoute
   ├── skillsRoute
   ├── diaryRoute
   ├── fsRoute
   ├── uploadRoute
   ├── avatarRoute
   └── authRoute

8. hub.initSchedulers()
   └── 启动心跳 + Cron

9. fastify.listen({ port, host: "127.0.0.1" })

10. 通知主进程 ready
    └── process.send({ type: "ready", port, token })
```

### 安全机制

- **Token 校验**：所有 HTTP 请求需要 `Authorization: Bearer {token}`
- **本地监听**：只监听 `127.0.0.1`，不对外暴露
- **CORS**：限制来源

---

## WebSocket 协议 (ws-protocol.js)

### 客户端 → 服务端

| 类型 | 字段 | 说明 |
|------|------|------|
| `prompt` | text, images? | 发送消息 |
| `abort` | — | 中止生成 |
| `steer` | text | 插话（流式时注入新消息） |

### 服务端 → 客户端

| 类型 | 字段 | 说明 |
|------|------|------|
| `text_delta` | delta | 文字片段 |
| `thinking_start` | — | 开始思考 |
| `thinking_text` | delta | 思考内容 |
| `thinking_end` | — | 思考结束 |
| `mood_start` | — | 开始情绪 |
| `mood_text` | delta | 情绪内容 |
| `mood_end` | — | 情绪结束 |
| `xing_start` | title | 开始行动 |
| `xing_text` | delta | 行动内容 |
| `xing_end` | — | 行动结束 |
| `tool_start` | name, args | 工具调用开始 |
| `tool_end` | name, result, error? | 工具调用结束 |
| `turn_end` | — | 对话轮次结束 |
| `error` | message | 错误 |
| `session_title` | title | 会话标题更新 |
| `session_switched` | path | 会话切换 |
| `file_output` | files | 文件输出 |
| `browser_status` | running, url, thumbnail? | 浏览器状态 |
| `notification` | title, body | 桌面通知 |
| `artifact` | id, type, title, content | 预览内容 |

---

## 核心路由：chat.js

聊天路由是最核心的路由，负责 WebSocket 连接和消息流转。

### WebSocket 连接

```
GET /ws?token={token}
  │
  ├── 升级为 WebSocket
  │
  ├── 订阅 EventBus
  │   └── 只转发 currentSessionPath 的事件
  │
  ├── 接收客户端消息
  │   ├── prompt → hub.send() 或 engine.prompt()
  │   ├── abort → engine.abort()
  │   └── steer → engine.steer()
  │
  └── 事件处理链
      │
      ├── ThinkTagParser → think_start/text/end
      ├── MoodParser → mood_start/text/end
      ├── XingParser → xing_start/text/end
      │
      └── broadcast(event) → 所有连接的客户端
```

### 消息处理流程

```
客户端发送 { type: "prompt", text: "你好" }
  │
  ├── 1. 检查是否有活跃 Session
  │      └── 没有 → 自动创建
  │
  ├── 2. hub.send({ text, role: "owner" })
  │      └── 路由到 engine.prompt()
  │
  ├── 3. Session 流式输出事件
  │      └── EventBus 广播
  │
  ├── 4. chat.js 的订阅回调处理事件
  │      ├── message_update.text_delta
  │      │   └── ThinkTagParser.feed() → MoodParser.feed() → XingParser.feed()
  │      │       └── 最终输出 text/mood/think/xing 事件
  │      │
  │      ├── message_update.tool_start
  │      │   └── broadcast({ type: "tool_start", name, args })
  │      │
  │      └── turn_end
  │          ├── flush 所有 parser
  │          ├── broadcast({ type: "turn_end" })
  │          └── 异步生成会话标题
  │
  └── 5. 客户端接收并渲染
```

---

## 其他路由

### agents.js — Agent 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/agents | 列出所有 Agent |
| POST | /api/agents | 创建 Agent |
| POST | /api/agents/switch | 切换 Agent |
| DELETE | /api/agents/:id | 删除 Agent |
| GET | /api/agents/:id/config | 获取 Agent 配置 |
| PUT | /api/agents/:id/config | 更新 Agent 配置 |
| GET | /api/agents/:id/identity | 获取身份设定 |
| PUT | /api/agents/:id/identity | 更新身份设定 |
| GET | /api/agents/:id/ishiki | 获取意识设定 |
| PUT | /api/agents/:id/ishiki | 更新意识设定 |

### sessions.js — 会话管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/sessions | 列出所有会话 |
| POST | /api/sessions | 创建新会话 |
| POST | /api/sessions/switch | 切换会话 |
| DELETE | /api/sessions/:path | 关闭会话 |

### models.js — 模型管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/models | 列出可用模型 |
| POST | /api/models/set | 切换模型 |
| POST | /api/models/refresh | 刷新模型列表 |

### skills.js — 技能管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/skills | 列出所有技能 |
| POST | /api/skills/:name/enable | 启用技能 |
| POST | /api/skills/:name/disable | 禁用技能 |
| POST | /api/skills/install | 安装技能（文件夹/zip/.skill） |
| DELETE | /api/skills/:name | 删除技能 |

### bridge.js — 外部平台

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/bridge/status | 获取所有平台状态 |
| POST | /api/bridge/:platform/connect | 连接平台 |
| POST | /api/bridge/:platform/disconnect | 断开平台 |
| GET | /api/bridge/sessions | 获取外部会话列表 |

### desk.js — 书桌

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/desk/files | 列出书桌文件 |
| GET | /api/desk/activities | 获取活动记录 |
| GET | /api/desk/cron | 获取定时任务 |

---

## CLI (cli.js)

独立运行时启动的终端交互界面。

### 连接方式

```
WebSocket → ws://127.0.0.1:{port}/ws?token={token}
```

与 Electron 前端共用同一 WebSocket 协议。

### 斜杠命令

| 命令 | 功能 |
|------|------|
| `/help` | 显示帮助 |
| `/model` | 查看/切换模型 |
| `/config` | 查看配置 |
| `/session new` | 新建会话 |
| `/session list` | 列出会话 |
| `/agent` | 查看当前 Agent |
| `/agent list` | 列出 Agent |
| `/agent switch <id>` | 切换 Agent |
| `/jian` | 查看笺 |
| `/ls` | 列出书桌文件 |
| `/cat <path>` | 查看文件内容 |

### 快捷键

- ESC：中断生成
- Ctrl+C：中断生成或退出
- Ctrl+D：退出

---

## boot.cjs — 启动包装器

因为 Electron 主进程使用 CJS，而项目是 ESM，所以需要一个 CJS 包装器：

```javascript
// boot.cjs
(async () => {
  try {
    await import("./index.js");
  } catch (err) {
    // 捕获 native 模块加载错误并输出诊断信息
    if (err.message.includes("better-sqlite3")) {
      console.error("需要重新编译 better-sqlite3: npm run rebuild");
    }
    process.exit(1);
  }
})();
```
