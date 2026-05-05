# Full_Agent 详细技术文档

> 编写日期：2026-05-05（修订：P3 bus.emit 修正、正式版验证通过）
> 源码库：`C:\Users\Clyne\Documents\trae_projects\ChangShi\openhanako`
> 适用版本：OpenHanako v0.130.7 源码版

---

## 一、项目概述

`full_agent` 是一个社区插件，允许 Agent 调用另一个**完整能力**的 Agent 执行任务。与内置 `subagent` 的区别：被调用的 Agent 拥有全部工具、记忆、人格。

**核心数据流**：

```
用户 → Agent 调用 full-agent_full_agent {助手ID} {任务}
  → Pi SDK: tool.execute(toolCallId, params, signal, onUpdate, ctx)
    → engine.buildTools 5参数包装器（P1）
      → PluginManager._loadTools 包装器
        → origExecute(params, mergedCtx)  ← pluginCtx 含 bus + sessionPath
          → bus.request("groupchat:execute-agent", ...)
            → EventBus._tryHandlers → 找到 hub handler（P3）
              → engine.executeIsolated(prompt, { agentId, ... })（P2: operate 模式）
                → Pi SDK 独立 session → 子 Agent 执行（全量工具）
                  → DeferredResultStore → block_update → Agent收到结果
```

---

## 二、文件清单

### 2.1 新建文件

#### `plugins/full-agent/manifest.json`

```json
{
  "id": "full-agent",
  "name": "全能力 Agent 调用",
  "version": "0.1.0",
  "description": "调用Agent执行完整任务"
}
```

#### `plugins/full-agent/tools/full_agent.js`

```javascript
export const name = "full_agent";
export const description = "调用另一个完整能力的 Agent 执行任务...";
export const parameters = {
  type: "object",
  properties: {
    agent_id: { type: "string", description: "助手ID：mingjian 或 suetsuki" },
    task: { type: "string", description: "任务描述" }
  },
  required: ["agent_id", "task"]
};

const TIMEOUT = 15 * 60 * 1000;

export async function execute(input, toolCtx) {
  const { agent_id, task } = input;
  const idMap = { mingjian: "mingjian", suetsuki: "suetsuki" };
  const agentId = idMap[agent_id] || agent_id;
  const bus = toolCtx?.bus;

  const taskId = "fa_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);

  bus.request("groupchat:execute-agent", {
    agentId, text: task, parentSessionPath: toolCtx?.sessionPath, taskId
  }, { timeout: TIMEOUT });

  return {
    content: [{ type: "text", text: "已将任务派发给 " + agentId + "（" + taskId + "）" }],
    details: {
      taskId, task,
      taskTitle: task.split(/\r?\n/).map(l => l.trim()).find(Boolean) || agentId,
      agentId, sessionPath: null, streamStatus: "running",
      executorAgentId: agentId, executorAgentNameSnapshot: agentId,
    },
  };
}
```

---

### 2.2 修改文件（共 4 个）

| # | 文件 | 位置 | 改动 |
|---|------|------|------|
| P1 | `core/engine.js` | ~L1115 | 工具包装器：3参数 → 5参数 |
| P2 | `core/session-coordinator.js` | ~L1799, ~L1985 | executeIsolated 权限：ask → operate |
| P3 | `hub/index.js` | ~L383-L443 | 新增 61 行 groupchat:execute-agent handler |
| P4 | `server/block-extractors.js` | ~L144 | 1 行别名注册 |

---

## 三、补丁详解

### P1: `core/engine.js` — 工具包装器 3→5 参数

**位置**：`buildTools()` 方法内，约 L1115

```diff
- execute: (toolCallId, params, runtimeCtx) => t.execute(toolCallId, params, { ...runtimeCtx, agentId }),
+ execute: (toolCallId, params, signal, onUpdate, ctx) => t.execute(toolCallId, params, signal, onUpdate, { ...ctx, agentId }),
```

---

### P2: `core/session-coordinator.js` — operate 权限模式

**位置**：`executeIsolated()` 方法内，约 L1799 和 L1985

**改动 A**（在 `let tempSessionMgr;` 之前插入 3 行）：

```diff
     this._headlessOps.add(opId);
     if (this._headlessOps.size === 1) bm.setHeadless(true);
+    const prevPermissionDefault = this._runtimePermissionModeDefault;
+    this._runtimePermissionModeDefault = "operate";
     let tempSessionMgr;
```

**改动 B**（在 `} finally {` 之后插入 1 行）：

```diff
     } finally {
+      this._runtimePermissionModeDefault = prevPermissionDefault;
       this._headlessOps.delete(opId);
```

`"operate"` 模式下所有工具自动批准，子 Agent 可自由使用 write、pin_memory 等工具。

---

### P3: `hub/index.js` — EventBus Handler

**位置**：`_setupSessionHandlers()` 方法末尾（约 L383-L443）

```javascript
this._sessionHandlerCleanups.push(bus.handle("groupchat:execute-agent",
  async ({ agentId, text, parentSessionPath, taskId }) => {
    if (!agentId || !text) return { error: "agentId and text are required" };

    const agent = engine.getAgent(agentId);
    if (!agent) return { error: `Agent "${agentId}" not found` };

    const store = engine.deferredResults;
    const cwd = engine.getHomeCwd(agentId) || process.cwd();
    const persistDir = path.join(agent.agentDir, "full-agent-sessions");

    store.defer(taskId, parentSessionPath, {
      type: "subagent",
      summary: String(text).substring(0, 80),
      agentId,
      agentName: agent.agentName || agentId,
    });

    (async () => {
      try {
        const result = await engine.executeIsolated(text, {
          agentId, cwd, emitEvents: true, persist: persistDir,
          onSessionReady: (sp) => {
            bus.emit({ type: "block_update", taskId,
              patch: { streamKey: sp, streamStatus: "running" } }, parentSessionPath);
          },
        });

        const replyText = result?.replyText || "";
        if (result?.error) {
          store.fail(taskId, result.error);
          bus.emit({ type: "block_update", taskId,
            patch: { streamStatus: "failed", summary: String(result.error).slice(0, 200) } }, parentSessionPath);
        } else {
          store.resolve(taskId, replyText);
          bus.emit({ type: "block_update", taskId,
            patch: { streamStatus: "done", summary: replyText.slice(0, 200) } }, parentSessionPath);
        }
      } catch (err) {
        store.fail(taskId, err.message);
        bus.emit({ type: "block_update", taskId,
          patch: { streamStatus: "failed", summary: err.message?.slice(0, 200) } }, parentSessionPath);
      }
    })();

    return { agentId, taskId, started: true };
}));
```

**关键点**：事件发送使用 `bus.emit()`，不是 `engine.emitEvent()`（engine 上不存在此方法）。

**Handler 依赖的 engine API**：

| 调用 | 用途 |
|------|------|
| `engine.getAgent(agentId)` | 查询 Agent 实例 |
| `engine.deferredResults` | 获取 DeferredResultStore |
| `engine.getHomeCwd(agentId)` | 获取 Agent 工作目录 |
| `engine.executeIsolated(prompt, opts)` | 创建独立 session 执行 |
| `bus.emit(event, sessionPath)` | 发送 block_update 事件 |

---

### P4: `server/block-extractors.js` — UI 卡片注册

**位置**：第 144 行

```diff
 BLOCK_EXTRACTORS.present_files = BLOCK_EXTRACTORS.stage_files;
+BLOCK_EXTRACTORS["full-agent_full_agent"] = BLOCK_EXTRACTORS.subagent;
```

---

## 四、Git Diff 摘要

```
 core/engine.js              |  2 +-
 core/session-coordinator.js |  3 +++
 hub/index.js                | 61 +++++++++++++++++++++++++++++++++++++++++++++
 server/block-extractors.js  |  1 +
 4 files changed, 66 insertions(+), 1 deletion(-)
```

新建文件（未纳入 git）：

```
 plugins/full-agent/manifest.json       |  6 +++
 plugins/full-agent/tools/full_agent.js | 34 +++++++++++++++++++
```

---

## 五、插件加载路径

### 5.1 目录结构

```
openhanako/
├── plugins/
│   ├── image-gen/
│   └── full-agent/
│       ├── manifest.json
│       └── tools/
│           └── full_agent.js
├── core/
│   ├── engine.js              ← P1
│   ├── session-coordinator.js ← P2
│   └── plugin-manager.js
├── hub/
│   └── index.js               ← P3
├── server/
│   ├── block-extractors.js    ← P4
│   └── bootstrap.js
└── desktop/
```

### 5.2 加载链路

```
main.cjs → HANA_ROOT = <project_root>/
server/index.js → builtinPluginsDir = <project_root>/plugins
PluginManager.scan() → 遍历 pluginsDirs → 发现 full-agent/
_readPluginDescriptor() → manifest.json → id="full-agent"
_loadTools() → freshImport(tools/full_agent.js)
```

### 5.3 环境变量

| 变量 | 值 |
|------|-----|
| `HANA_HOME` | `~/.hanako-dev` |
| `HANA_ROOT` | `<project_root>/` |

---

## 六、实测验证记录（2026-05-05）

### 6.1 源码版调用链路验证

| 测试项 | 结果 |
|--------|:--:|
| agent → full_agent 调用Agent追加文件 | ✅ |
| agent → full_agent 同时调用Agent1+Agent2追加表情 | ⚠️ 竞态覆盖 |
| agent → full_agent 串行调用：Agent1→Agent2追加 1,2 | ✅ |
| Agent1/Agent2 → 各自列出可用工具 | ✅ |

### 6.2 并发写入行为

两个 Agent 同时写同一个文件时，存在竞态：
- 时序差足够大 → 后写者读到前者的修改 → 自然串行 → 两份追加均保留
- 几乎同时写入 → 后写者的修改可能覆盖前者 → 仅一份保留

**建议**：对同一文件的操作尽量串行派发。

### 6.3 主代理与子代理工具差异

| 工具 | Agent（主） | Agent1/Agent2（full_agent） |
|------|:--:|:--:|
| 27 工具 | ✅ | ✅ |

子代理通过 full_agent 调用时拥有 27 个工具，覆盖 pin_memory、cron、channel 等平台级工具。

---

## 七、文件索引

| 路径 | 说明 |
|------|------|
| `plugins/full-agent/manifest.json` | 插件声明 |
| `plugins/full-agent/tools/full_agent.js` | 工具实现 |
| `core/engine.js#L1115` | P1: 5参数包装器 |
| `core/session-coordinator.js#L1799,#L1985` | P2: operate 权限模式 |
| `hub/index.js#L383-L443` | P3: groupchat:execute-agent handler |
| `server/block-extractors.js#L144` | P4: UI 卡片 extractor |
| `C:\Users\Clyne\.hanako-dev\logs\` | 运行日志 |

---

> **许可**：与 OpenHanako 项目保持一致（Apache-2.0）。

---

## 八、正式版部署记录（2026-05-05）

正式版路径：`C:\Users\Clyne\Documents\trae_projects\ChangShi\Hanako`
正式版版本：v0.125.0（Electron 打包）

### 8.1 架构差异

与源码版的关键差异：

| 项目 | 源码版 | 正式版 |
|------|--------|--------|
| Engine 代码 | `core/engine.js` 等独立文件 | 打包为 `resources/server/bundle/index.js`（35k行单文件） |
| 前端代码 | `desktop/src/` | 打包为 `app.asar` → `dist-renderer/` |
| 插件目录 | `<project>/plugins/` | `resources/server/plugins/` |
| Block 提取器 | `server/block-extractors.js` | 内联在 `bundle/index.js` 的 `yo` 对象中 |
| Hub handler | `hub/index.js` | 内联在 `bundle/index.js` 的 `ke.eventBus.handle(...)` 区域 |

正式版无需 P1 补丁（5参数包装器已内置），无需 P2 补丁（session-coordinator 在 bundle 中），P3 和 P4 对应的代码位于 bundle 内部。

### 8.2 bundle/index.js 三处改动

#### B1: groupchat:execute-agent bus handler（~L35160）

在 `ke.eventBus.handle("task:abort", ...)` 之后插入。功能与源码版 P3 一致，使用正式版的变量名：
- `K` = HanaEngine
- `Wt` = DeferredResultStore
- `ke` = Hub
- `g` = path 模块

```javascript
ke.eventBus.handle("groupchat:execute-agent", async ({ agentId: t, text: e, parentSessionPath: n, taskId: r }) => {
  if (!t || !e) return { error: "agentId and text are required" };
  const s = K.getAgent(t);
  if (!s) return { error: `Agent "${t}" not found` };
  if (!Wt) return { error: "DeferredResultStore not available" };
  const i = K.getHomeCwd(t) || process.cwd(), o = g.join(s.agentDir, "full-agent-sessions");
  Wt.defer(r, n, {
    type: "subagent", summary: String(e).substring(0, 80),
    agentId: t, agentName: s.agentName || t,
  });
  (async () => {
    try {
      const a = await K.executeIsolated(e, {
        agentId: t, cwd: i, emitEvents: !0, persist: o,
        onSessionReady: (l) => {
          ke.eventBus.emit({ type: "block_update", taskId: r,
            patch: { streamKey: l, streamStatus: "running" } }, n);
        },
      });
      const c = a?.replyText || "";
      a?.error ? (Wt.fail(r, a.error), ke.eventBus.emit({ type: "block_update", taskId: r,
        patch: { streamStatus: "failed", summary: String(a.error).slice(0, 200) } }, n))
      : (Wt.resolve(r, c), ke.eventBus.emit({ type: "block_update", taskId: r,
        patch: { streamStatus: "done", summary: c.slice(0, 200) } }, n));
    } catch (a) {
      Wt.fail(r, a.message), ke.eventBus.emit({ type: "block_update", taskId: r,
        patch: { streamStatus: "failed", summary: a.message?.slice(0, 200) } }, n);
    }
  })();
  return { agentId: t, taskId: r, started: !0 };
});
```

#### B2: 块提取器映射（~L24601）

在 `yo.present_files = yo.stage_files;` 之后插入：

```javascript
yo["full-agent_full_agent"] = yo.subagent;
```

功能等同源码版 P4，让前端识别 `full-agent_full_agent` 工具结果并渲染子代理小卡片。

#### B3: 子代理权限修复（~L19034）

**问题**：`getPermissionMode()` 对不在 sessions map 中的子代理 session 返回 `"ask"`，导致 write/edit/bash 等写入工具被权限拦截（子代理无审批 UI）。

**修复**：孤儿 session 直接返回 `"operate"`。

```diff
 getPermissionMode(e = this.currentSessionPath) {
   if (!e) return this._pendingPermissionMode || this._getDefaultPermissionMode();
   const n = this._sessions.get(e);
-  return De(n || { permissionMode: this._getDefaultPermissionMode() });
+  return n ? De(n) : Ee.OPERATE;
 }
```

### 8.3 插件文件安装

```
resources/server/plugins/full-agent/
├── manifest.json        ← 从源码版复制
└── tools/
    └── full_agent.js    ← 从源码版复制
```

插件由 PluginManager 自动扫描加载，无需额外配置。工具名自动加前缀 → `full-agent_full_agent`。

### 8.4 实测验证

| 测试项 | 结果 |
|--------|:--:|
| 插件被 PluginManager 扫描发现 | ✅ |
| full_agent 工具在 Agent 工具列表中可见 | ✅ |
| 派发任务后子代理（明鉴/素月）正常执行 | ✅ |
| 子代理写入工具不再被权限拦截 | ✅ |
| 任务小卡片正常显示 | ✅ |
| 子代理执行结果通过 block_update 回到主对话 | ✅ |

### 8.5 正式版改动速查

| # | 文件 | 位置 | 改动 |
|---|------|------|------|
| B1 | `resources/server/bundle/index.js` | ~L35160 | 新增 groupchat:execute-agent handler |
| B2 | `resources/server/bundle/index.js` | ~L24601 | 新增 full-agent_full_agent → subagent extractor 映射 |
| B3 | `resources/server/bundle/index.js` | ~L19034 | getPermissionMode 孤儿 session 返回 operate |
| — | `resources/server/plugins/full-agent/` | 新建目录 | 复制 manifest.json + tools/full_agent.js |
