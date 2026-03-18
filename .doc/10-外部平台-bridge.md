# 外部平台接入 (lib/bridge/)

Bridge 系统让 Hanako 能够接入 Telegram、飞书、QQ 等外部消息平台。

## 架构

```
外部平台
  │
  ├── Telegram (telegram-adapter.js)
  ├── 飞书 (feishu-adapter.js)
  └── QQ (qq-adapter.js)
  │
  ▼
BridgeManager (bridge-manager.js)
  │
  ├── 消息缓冲 + debounce
  ├── StreamCleaner（去除内部标签）
  ├── BlockChunker（分块发送）
  │
  ▼
hub.send(sessionKey, role, text)
  │
  ▼
engine.executeExternalMessage() / GuestHandler
```

---

## BridgeManager — 统一管理器

### 消息接收流程

```
adapter.onMessage(msg)
  │
  ├── 群聊消息
  │   └── _flushGroupMessage() → 直接 hub.send()
  │
  └── 私聊消息
      │
      ├── /stop 或 /abort
      │   └── abort 当前 session，清空 pending
      │
      └── 入 _pending 缓冲
          └── debounce 2s（streaming 时 1s）后 _flushPending()
              │
              ├── 正在 streaming?
              │   └── steerBridgeSession()（插话注入）
              │
              └── 否 → hub.send()（新消息）
```

### 消息发送流程

```
AI 流式输出
  │
  ├── StreamCleaner
  │   └── 去除 <mood>, <pulse>, <reflect>, <tool_code> 等内部标签
  │
  ├── BlockChunker
  │   └── 按行/结构块分批（多气泡效果）
  │
  └── adapter.sendReply() / sendBlockReply()
```

### StreamCleaner

AI 输出中包含很多内部标签（如 `<mood>` 情绪区块），这些不应该发送给外部平台用户：

```
输入: "Hello <mood>Vibe: happy</mood> How are you?"
输出: "Hello  How are you?"
```

### BlockChunker

将长消息按结构分块发送，模拟多条消息的效果：

```
输入: "# 标题\n\n第一段...\n\n第二段...\n\n```code```"
输出:
  气泡1: "# 标题\n\n第一段..."
  气泡2: "第二段..."
  气泡3: "```code```"
```

---

## Telegram 适配器

### 连接方式

```javascript
createTelegramAdapter({ token, onMessage, onStatus })
```

使用 `node-telegram-bot-api` 库，WebSocket 长轮询方式接收消息。

### 消息收发

| 方向 | 方式 |
|------|------|
| 收 | `bot.on("message", ...)` |
| 发 | `bot.sendMessage(chatId, text)` |

- 单条消息最大 4096 字符，超长自动分段
- 支持 `sendBlockReply`（多气泡）和 `sendDraft`（草稿预览）

### Session Key 格式

```
tg-dm-{chatId}     — 私聊
tg-group-{chatId}  — 群聊
```

---

## 飞书适配器

### 连接方式

```javascript
createFeishuAdapter({ appId, appSecret, onMessage, onStatus })
```

使用 `@larksuiteoapi/node-sdk`，WebSocket 长连接。

### 消息收发

| 方向 | 方式 |
|------|------|
| 收 | 事件 `im.message.receive_v1` |
| 发 | `client.im.message.create()` |

### Session Key 格式

```
feishu-dm-{chatId}     — 私聊
feishu-group-{chatId}  — 群聊
```

---

## QQ 适配器

### 连接方式

```javascript
createQQAdapter({ appID, appSecret, onMessage, dmGuildMap, onDmGuildDiscovered, onStatus })
```

使用 QQ 官方 API，WebSocket 连接。

### 消息类型

| 事件 | 说明 |
|------|------|
| `C2C_MESSAGE_CREATE` | 私聊消息 |
| `GROUP_AT_MESSAGE_CREATE` | 群 @ 消息 |
| `AT_MESSAGE_CREATE` | 频道 @ 消息 |
| `DIRECT_MESSAGE_CREATE` | 频道私信 |

### 消息发送

| 场景 | API |
|------|-----|
| 私聊 | `POST /v2/users/{chatId}/messages` |
| 群聊 | `POST /v2/groups/{chatId}/messages` |
| 频道 | `POST /channels/{chatId}/messages` |

### Session Key 格式

```
qq-dm-{chatId}       — 私聊
qq-group-{chatId}    — 群聊
qq-guild-{chatId}    — 频道
```

---

## Session Key 解析

```javascript
parseSessionKey("tg-dm-12345")
// → { platform: "telegram", chatType: "dm", chatId: "12345" }

parseSessionKey("feishu-group-abc")
// → { platform: "feishu", chatType: "group", chatId: "abc" }
```

### 前缀映射

| 前缀 | 平台 | 类型 |
|------|------|------|
| `tg-dm-` | Telegram | 私聊 |
| `tg-group-` | Telegram | 群聊 |
| `feishu-dm-` | 飞书 | 私聊 |
| `feishu-group-` | 飞书 | 群聊 |
| `qq-dm-` | QQ | 私聊 |
| `qq-group-` | QQ | 群聊 |
| `qq-guild-` | QQ | 频道 |

---

## 主人 vs 访客

Bridge 系统区分"主人"和"访客"：

| 角色 | 判断方式 | 处理 |
|------|----------|------|
| 主人 | chatId 在 `preferences.json` 的 `bridge.owner` 中 | 完整 Agent 能力 |
| 访客 | 不在 owner 列表中 | 有限能力，消息加前缀 |

### 访客限制

- 消息前加 `[来自 xxx]` 前缀
- 使用 public-ishiki.md（对外意识，而非完整 ishiki）
- 只允许只读工具
