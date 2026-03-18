# 核心引擎层 (core/)

core/ 是整个系统的"大脑"，14 个 JS 文件，扁平结构，无子目录。

## 文件清单

| 文件 | 导出 | 职责 |
|------|------|------|
| engine.js | `HanaEngine` | 核心引擎，Thin Facade，持有所有 Manager |
| agent.js | `Agent` | 单个 AI 助手实例 |
| agent-manager.js | `AgentManager` | 多 Agent 生命周期管理 |
| session-coordinator.js | `SessionCoordinator` | Session 生命周期管理 |
| config-coordinator.js | `ConfigCoordinator` | 配置读写、模型、搜索 |
| model-manager.js | `ModelManager` | 模型发现、切换、凭证解析 |
| skill-manager.js | `SkillManager` | 技能加载、过滤、同步 |
| channel-manager.js | `ChannelManager` | 频道 CRUD、成员管理 |
| bridge-session-manager.js | `BridgeSessionManager` | 外部平台 Session 管理 |
| preferences-manager.js | `PreferencesManager` | 全局偏好读写 |
| events.js | `MoodParser`, `ThinkTagParser`, `XingParser` | 流式文本解析器 |
| first-run.js | `ensureFirstRun` | 首次运行播种 |
| llm-utils.js | 多个工具函数 | 标题摘要、技能翻译、活动摘要 |
| sync-favorites.js | `syncFavoritesToModelsJson` | 收藏模型同步到 Pi SDK |

---

## HanaEngine — 核心引擎

### 设计模式：Thin Facade

HanaEngine 本身不包含业务逻辑，它是一个"薄门面"（Thin Facade），将所有操作委托给内部的 Manager。这样做的好处是：

- 外部只需要和一个对象打交道
- 各 Manager 职责单一，可独立测试
- 依赖通过构造器注入，避免循环引用

### 构造器

```javascript
constructor({ hanakoHome, productDir, agentId })
```

| 参数 | 含义 |
|------|------|
| `hanakoHome` | 用户数据根目录，如 `~/.hanako/` |
| `productDir` | 产品模板目录（包含 yuan、ishiki、identity 模板） |
| `agentId` | 可选，指定启动时的焦点 Agent |

### 初始化流程 `init()`

```
init()
  │
  ├── 0. Provider 迁移（旧版 agent config → 全局 providers.yaml）
  │
  ├── 1. 初始化所有 Agent
  │      ├── 焦点 Agent 先初始化（阻塞）
  │      └── 其余 Agent 并行初始化
  │
  ├── 2. Pi SDK 初始化
  │      ├── AuthStorage.create(auth.json)
  │      └── new ModelRegistry(authStorage, models.json)
  │
  ├── 3. ResourceLoader + Skills
  │      ├── DefaultResourceLoader（扫描 skills 目录）
  │      └── SkillManager.init()（合并内置 + 自学技能）
  │
  ├── 4. 模型发现
  │      ├── syncModelsAndRefresh()（favorites → models.json）
  │      ├── refreshAvailable()（扫描可用模型）
  │      └── 设置 defaultModel
  │
  ├── 5. 迁移 favorites（一次性）
  │
  ├── 6. 同步 Skills + 监听 skillsDir
  │
  ├── 7. Bridge 孤儿清理
  │
  └── 8. 沙盒状态日志
```

### 工具构建 `buildTools()`

```javascript
buildTools(cwd, customTools, opts)
```

调用 `lib/sandbox/createSandboxedTools()`，根据沙盒开关和平台选择安全策略：

- 沙盒开启 → `standard` 模式（PathGuard + OS 沙盒）
- 沙盒关闭 → `full-access` 模式（无限制）

### 事件系统

- `subscribe(listener)` — 订阅事件
- `_emitEvent(event, sessionPath)` — 发射事件
- 有 EventBus 时委托给 EventBus，否则直接通知 listeners

---

## Agent — AI 助手实例

每个 Agent 是一个独立的 AI 角色，拥有自己的身份、记忆、工具和 System Prompt。

### 数据目录结构

```
agents/{agent-id}/
├── config.yaml          # 配置（名字、yuan 类型、模型、技能等）
├── identity.md          # 身份设定（"你是谁"）
├── ishiki.md            # 意识/行为准则（"你怎么做"）
├── pinned.md            # 置顶记忆（用户主动要求记住的）
├── memory/
│   ├── facts.db         # SQLite FTS5 元事实数据库
│   ├── memory.md        # 编译后的记忆（注入 system prompt）
│   ├── today.md         # 今天的记忆
│   ├── week.md          # 本周的记忆
│   ├── longterm.md      # 长期记忆
│   ├── facts.md         # 重要事实
│   └── summaries/       # 每个 session 的滚动摘要
├── sessions/            # 对话记录（JSONL 格式）
├── desk/                # 书桌系统
├── experience/          # 经验库
├── learned-skills/      # 自学技能
└── avatars/             # 头像
```

### 初始化流程 `init()`

```
init()
  │
  ├── 0. 兼容性检查（目录、数据库、配置文件）
  ├── 1. 加载 config.yaml
  ├── 2. 设置身份（userName, agentName）
  ├── 3. 初始化 Web 搜索
  ├── 4. 记忆系统
  │      ├── FactStore（SQLite FTS5）
  │      ├── SessionSummaryManager
  │      ├── v1→v2 迁移（旧 memories.db → facts.db）
  │      └── MemoryTicker（定时编译记忆）
  ├── 5. 后台首次 tick（不阻塞启动）
  ├── 6. 启动记忆定时调度
  ├── 7. 创建工具
  │      ├── search_memory, pin_memory, unpin_memory
  │      ├── recall_experience, record_experience
  │      ├── web_search, web_fetch
  │      ├── todo, cron, notify
  │      ├── present_files, create_artifact
  │      ├── channel, ask_agent, dm
  │      ├── browser, install_skill, delegate
  │      └── ...
  ├── 8. Desk 系统（DeskManager, CronStore）
  ├── 9. 频道工具 + 私信工具
  ├── 10. install_skill 工具
  ├── 11. delegate 工具
  └── 12. 组装 System Prompt
```

### System Prompt 组装 `buildSystemPrompt()`

System Prompt 是发送给 AI 模型的"系统指令"，决定了 Agent 的行为方式。组装顺序：

```
1. 人格（identity + yuan + ishiki）
   │  identity.md — "你是 Hanako，一个..."
   │  yuan 模板 — MOOD 意识流框架
   │  ishiki.md — 行为准则
   │
2. 用户档案
   │  user.md — 用户的自我描述
   │
3. 记忆（仅在记忆开启时注入）
   │  ├── 记忆使用规则（不要说"我记得"）
   │  ├── 置顶记忆（pinned.md）
   │  └── 编译后的记忆（memory.md）
   │
4. 技能（已启用的 SKILL.md 内容）
   │
5. 文件呈现规则 / Artifact 规则 / 浏览器规则
   │
6. 主动技能获取引导（可选）
   │
7. 书桌路径
   │
8. 当前日期时间
```

### 记忆开关机制

Agent 有两层记忆开关：

| 层级 | 控制 | 说明 |
|------|------|------|
| Master 开关 | `config.yaml memory.enabled` | Agent 级别总开关 |
| Session 开关 | `session-meta.json` | 每个对话可单独关闭记忆 |

只有两个开关都开启时，记忆才会注入 System Prompt，记忆工具才会可用。

### 工具列表

Agent 的 `tools` getter 返回所有可用工具：

```javascript
get tools() {
  const memTools = this.memoryEnabled ? [
    search_memory, pin_memory, unpin_memory,
    recall_experience, record_experience,
  ] : [];
  return [
    ...memTools,
    web_search, web_fetch,
    todo, cron,
    present_files, create_artifact,
    channel, ask_agent, dm,
    browser, install_skill, notify, delegate,
  ].filter(Boolean);
}
```

---

## AgentManager — 多 Agent 管理

### 核心职责

- 扫描 `agents/` 目录，发现所有 Agent
- 初始化、创建、切换、删除 Agent
- 维护 `agents` Map 和 `activeAgentId`
- 每个 Agent 有独立的 ActivityStore

### 创建 Agent 流程

```
createAgent({ name, id, yuan })
  │
  ├── 1. 生成 agentId（调用 LLM 或 fallback 到时间戳）
  ├── 2. 创建目录结构（memory/, sessions/, avatars/）
  ├── 3. 从模板生成 config.yaml
  ├── 4. 从模板生成 identity.md
  ├── 5. 复制 ishiki.md
  ├── 6. 设置频道
  ├── 7. 初始化 Agent 实例
  │      └── 失败时回滚（删除已创建的目录）
  ├── 8. 启动 Cron
  └── 9. 注入 DM 回调
```

### 切换 Agent 流程

```
switchAgent(agentId)
  │
  ├── 1. pauseForAgentSwitch()（暂停 Hub 调度）
  ├── 2. cleanupSession()（关闭当前所有 Session）
  ├── 3. 切换 activeAgentId
  ├── 4. 设置 defaultModel（从新 Agent 的 config 读取）
  ├── 5. resumeAfterAgentSwitch()（恢复 Hub 调度）
  ├── 6. syncAgentSkills()（同步技能）
  ├── 7. savePrimaryAgent()（持久化）
  └── 8. createSession()（创建新 Session）
```

---

## SessionCoordinator — Session 管理

### 核心概念

- **Session** = 一次对话，包含消息历史和工具调用记录
- **SessionManager** = Pi SDK 提供的 Session 持久化管理器
- Session 存储为 JSONL 文件（每行一个 JSON 对象）

### Session 创建

```javascript
async createSession(sessionMgr, cwd, memoryEnabled)
```

1. 确定工作目录（cwd → homeCwd → process.cwd()）
2. 设置记忆开关
3. 构建沙盒工具
4. 调用 Pi SDK `createAgentSession()`
5. 订阅 session 事件（转发到 EventBus）
6. 存入 sessions Map（最多缓存 20 个）

### Isolated Execution

`executeIsolated()` 用于后台任务（心跳、Cron、Agent 间通信）：

- 创建临时 Session
- 只允许白名单工具（默认：search_memory, web_search, web_fetch, todo, cron, notify, present_files, message_agent）
- 支持 abort signal
- 执行完毕后删除临时 Session 文件（除非 `persist` 选项）
- 浏览器自动切换到 headless 模式

---

## 流式解析器 (events.js)

### 三种解析器

| 解析器 | 标签 | 对应人格 | 输出事件 |
|--------|------|----------|----------|
| ThinkTagParser | `<think>...</think>` | DeepSeek/Qwen 等模型 | think_start / think_text / think_end |
| MoodParser | `<mood>`, `<pulse>`, `<reflect>` | Hanako / Butter / Ming | mood_start / mood_text / mood_end |
| XingParser | `<xing title="...">...</xing>` | 反省/行动 | xing_start / xing_text / xing_end |

### 解析链

```
AI 模型输出 (streaming)
  │
  ▼
ThinkTagParser（最外层）
  ├── <think>...</think> → think_start/think_text/think_end
  └── 其他文本 → text
       │
       ▼
     MoodParser
       ├── <mood>...</mood> → mood_start/mood_text/mood_end
       └── 其他文本 → text
            │
            ▼
          XingParser
            ├── <xing>...</xing> → xing_start/xing_text/xing_end
            └── 其他文本 → text（最终输出给用户）
```

### 流式解析的难点

AI 模型是逐字输出的，一个标签可能被拆成多个 delta：

```
delta 1: "Hello <mo"
delta 2: "od>\nVibe: happy"
delta 3: "\n</mood>\nHow are"
```

解析器通过 **buffer + trailing prefix 检测** 解决这个问题：
1. 每次 feed 一个 delta，追加到 buffer
2. 检查 buffer 中是否有完整的开始/结束标签
3. 如果 buffer 末尾是某个标签的前缀（如 `<mo`），则保留不输出，等待更多数据
4. 确认不是标签前缀后，才输出为普通文本

---

## ModelManager — 模型管理

### 两层模型

| 层 | 用途 | 持久化 |
|----|------|--------|
| defaultModel | 设置页面选的，Bridge 也用 | 是（config.yaml） |
| sessionModel | 聊天页面临时切的 | 否（仅内存） |

`currentModel` = sessionModel || defaultModel

### 模型发现流程

```
1. AuthStorage.create(auth.json) — 加载认证信息
2. new ModelRegistry(authStorage, models.json) — 创建注册表
3. syncFavoritesToModelsJson() — 将收藏模型写入 models.json
4. modelRegistry.getAvailable() — 扫描所有可用模型
5. 设置 defaultModel
```

### Provider 凭证解析优先级

```
1. 全局 providers.yaml（~/.hanako/providers.yaml）
2. Agent config.yaml 的 providers 块
3. auth.json（Pi SDK 管理的认证）
```

---

## SkillManager — 技能管理

### 技能来源

| 来源 | 位置 | 说明 |
|------|------|------|
| 内置 | `skills2set/` → `~/.hanako/skills/` | 随产品分发 |
| 自学 | `agents/{id}/learned-skills/` | Agent 通过 install_skill 安装 |

### 技能格式

每个技能是一个目录，包含 `SKILL.md` 文件：

```markdown
---
name: quiet-musing
description: "Deep reasoning framework..."
---

# 技能内容（Markdown）
```

### 技能同步流程

```
1. ResourceLoader.getSkills() — 从 skills 目录加载
2. scanLearnedSkills() — 扫描每个 Agent 的 learned-skills
3. syncAgentSkills(agent) — 将启用的技能注入 Agent 的 system prompt
4. watch(skillsDir) — 监听文件变化，自动 reload（debounce 1s）
```

### Per-Agent 隔离

自学技能有 `_agentId` 标记，只对学习它的 Agent 可见。内置技能对所有 Agent 可见。
