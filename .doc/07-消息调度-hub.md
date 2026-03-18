# 消息调度中枢 (hub/)

Hub 是整个系统的"交换机"，负责消息的路由、事件的广播、定时任务的调度。

## 文件清单

| 文件 | 导出 | 职责 |
|------|------|------|
| index.js | `Hub` | 消息调度主入口 |
| event-bus.js | `EventBus` | 发布/订阅事件总线 |
| scheduler.js | `Scheduler` | 心跳 + Cron 调度 |
| channel-router.js | `ChannelRouter` | 频道消息路由 |
| guest-handler.js | `GuestHandler` | 访客消息处理 |
| agent-messenger.js | `AgentMessenger` | Agent 间私聊 |
| dm-router.js | `DmRouter` | 私信路由 |
| agent-executor.js | `runAgentSession` | Agent 临时会话执行 |

---

## Hub — 消息调度主入口

### 核心方法 `send()`

`hub.send()` 是所有消息的统一入口，根据消息的来源、角色、上下文路由到不同的处理器：

```
hub.send(message)
  │
  ├── 有 from && to → AgentMessenger（Agent 间私聊）
  │   例：Agent A 给 Agent B 发消息
  │
  ├── 无 sessionKey && role === "owner" → engine.prompt()
  │   例：用户在桌面端发送消息
  │
  ├── 有 sessionKey && role === "guest" → GuestHandler
  │   例：Telegram 上的非主人用户发消息
  │
  ├── 有 sessionKey && !ephemeral → engine.executeExternalMessage()
  │   例：Telegram 上的主人发消息
  │
  └── ephemeral → engine.executeIsolated()
      例：临时执行（心跳、Cron 等）
```

### 生命周期

```javascript
// 初始化
const hub = new Hub(engine);
hub.initSchedulers();  // 启动心跳 + Cron

// Agent 切换时
await hub.pauseForAgentSwitch();   // 暂停调度
// ... 切换 Agent ...
hub.resumeAfterAgentSwitch();      // 恢复调度
```

---

## EventBus — 事件总线

### 发布/订阅模式

```javascript
// 订阅
const unsub = eventBus.subscribe((event, sessionPath) => {
  if (event.type === "text_delta") {
    console.log(event.delta);
  }
}, {
  sessionPath: "/path/to/session.jsonl",  // 可选过滤
  types: ["text_delta", "tool_start"],     // 可选过滤
});

// 发射
eventBus.emit({ type: "text_delta", delta: "Hello" }, sessionPath);

// 取消订阅
unsub();
```

### 事件类型

| 类型 | 来源 | 说明 |
|------|------|------|
| text_delta | Session | 文字片段 |
| mood_start/text/end | MoodParser | 情绪标签 |
| think_start/text/end | ThinkTagParser | 思考标签 |
| xing_start/text/end | XingParser | 行动标签 |
| tool_start/end | Session | 工具调用 |
| turn_end | Session | 对话轮次结束 |
| error | Session | 错误 |
| session_title | Server | 会话标题更新 |
| notification | Agent | 桌面通知 |
| browser_status | Browser | 浏览器状态变化 |
| browser_bg_status | Session | 后台浏览器状态 |
| devlog | Engine | 开发日志 |
| file_output | Tool | 文件输出 |

---

## Scheduler — 调度器

### 两种调度

#### 1. Heartbeat（心跳巡检）

```
触发: 每 17 分钟（可配置）
对象: 当前活跃 Agent
内容:
  Phase 1: 检查工作空间文件变化 + Overwatch
  Phase 2: 扫描 jian.md 目录，指纹比对后执行有变化的笺
```

**笺（jian）** 是用户放在书桌上的 Markdown 文件，Agent 会定期检查并执行其中的指令。

#### 2. Cron（定时任务）

```
触发: 每 60 秒检查一次
对象: 所有 Agent（各自独立）
内容: 执行到期的 cron 任务

任务类型:
  - at: 一次性（指定时间执行）
  - every: 循环（每隔 N 毫秒）
  - cron: cron 表达式
```

### 执行方式

调度器通过 `engine.executeIsolated()` 执行任务：
- 创建临时 Session
- 只允许白名单工具
- 结果写入 ActivityStore
- 通过 EventBus 广播

---

## ChannelRouter — 频道路由

频道是多个 Agent 的公共聊天空间。

### 工作流程

```
1. 轮询 channel-ticker（每 30 秒）
2. 检查每个频道的新消息
3. Triage: 调用 utility 模型判断是否需要回复
   │
   ├── 不需要 → 跳过
   │
   └── 需要 → 生成回复
       ├── 第一轮: 读取频道上下文 + 生成回复
       ├── 第二轮: 精炼回复
       └── 写入频道文件
4. 记忆摘要: 将频道对话写入 FactStore
```

### Triage 判断

用 utility 模型判断：
- 消息是否与该 Agent 相关？
- 是否需要回复？
- 回复的紧迫程度？

---

## GuestHandler — 访客处理

处理非主人的消息（如 Telegram 上的其他用户）：

```
1. 在消息前加前缀: [来自 xxx]
2. 注入上下文标签
3. 调用 engine.executeExternalMessage()
```

---

## AgentMessenger — Agent 间私聊

```
fromAgent ↔ toAgent 双向对话

防循环机制:
  - maxRounds: 最大对话轮次
  - <done/>: Agent 可以主动结束对话
  - 冷却期: 防止频繁触发
```

---

## DmRouter — 私信路由

```
Agent 收到 DM 后:
  1. 读取聊天记录（dm/{peerId}.md）
  2. 生成回复
  3. 写入双方的 dm/ 文件

安全机制:
  - 轮次限制
  - 防重入
  - 冷却期
```

---

## AgentExecutor — Agent 临时会话

```javascript
runAgentSession(agentId, rounds, opts)
```

用于需要临时借用某个 Agent 能力的场景：
- 频道回复
- DM 回复
- ask_agent 工具
- 心跳巡检

支持选项：
- `capture`: 捕获回复文本
- `noTools`: 不使用工具
- `readOnly`: 只读模式
- `systemAppend`: 追加系统提示
- `noMemory`: 不使用记忆

---

## 消息流完整路径

### 桌面端用户消息

```
用户 → WebSocket → chat.js → hub.send(role:"owner")
  → engine.prompt() → Session → AI 模型
  → 流式事件 → EventBus → chat.js → WebSocket → 前端渲染
```

### Telegram 主人消息

```
Telegram → telegram-adapter → BridgeManager._flushPending()
  → hub.send(role:"owner", sessionKey:"tg-dm-xxx")
  → engine.executeExternalMessage() → Session → AI 模型
  → 流式事件 → BridgeManager → StreamCleaner → telegram-adapter.sendReply()
```

### Telegram 访客消息

```
Telegram → telegram-adapter → BridgeManager._flushPending()
  → hub.send(role:"guest", sessionKey:"tg-dm-xxx")
  → GuestHandler → engine.executeExternalMessage()
  → 流式事件 → BridgeManager → telegram-adapter.sendReply()
```

### Agent 间通信

```
Agent A 调用 message_agent(to:"B", message:"xxx")
  → hub.send(from:"A", to:"B")
  → AgentMessenger.send()
  → runAgentSession(agentId:"B")
  → Agent B 生成回复
  → 回复返回给 Agent A
```

### 定时任务

```
Scheduler.checkJobs() → 发现到期任务
  → engine.executeIsolated(prompt)
  → 临时 Session → AI 模型
  → 结果写入 ActivityStore
  → EventBus 广播
```
