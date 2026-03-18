# 工具系统 (lib/tools/)

Agent 通过工具与外部世界交互。每个工具是一个 JSON Schema 定义的函数，AI 模型在对话中决定何时调用哪个工具。

## 工具总览

| 工具名 | 文件 | 功能 | 参数 |
|--------|------|------|------|
| `search_memory` | memory-search.js | 搜索记忆库 | query, tags?, date_from?, date_to? |
| `pin_memory` | pinned-memory.js | 写入置顶记忆 | content |
| `unpin_memory` | pinned-memory.js | 移除置顶记忆 | keyword |
| `recall_experience` | experience.js | 查看经验库 | category? |
| `record_experience` | experience.js | 写入经验 | category, content |
| `web_search` | web-search.js | 网络搜索 | query |
| `web_fetch` | web-fetch.js | 抓取网页内容 | url |
| `todo` | todo.js | 管理待办事项 | action, text?, id? |
| `cron` | cron-tool.js | 管理定时任务 | action, type?, schedule?, prompt?, label? |
| `present_files` | output-file-tool.js | 呈现已创建的文件 | filepaths |
| `create_artifact` | artifact-tool.js | 创建 HTML/代码预览 | type, title, content |
| `channel` | channel-tool.js | 管理频道 | action, channel?, content? |
| `ask_agent` | ask-agent-tool.js | 向其他 Agent 提问 | agent, task |
| `dm` | dm-tool.js | 向其他 Agent 发私信 | to, message |
| `message_agent` | message-agent-tool.js | 发私信并等待回复 | to, message, max_rounds? |
| `browser` | browser-tool.js | 控制浏览器 | action, url?, ref?, text? |
| `install_skill` | install-skill.js | 安装技能 | github_url?, skill_content?, reason |
| `notify` | notify-tool.js | 发送桌面通知 | title, body |
| `delegate` | delegate-tool.js | 委派子任务 | task, model? |

此外还有 Pi SDK 提供的内置工具：`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`（这些会被沙盒包装）。

---

## 记忆相关工具

### search_memory — 搜索记忆

```
参数:
  query: string (必填) — 搜索关键词
  tags: string[] (可选) — 标签过滤
  date_from: string (可选) — 起始日期
  date_to: string (可选) — 结束日期

搜索策略:
  1. 有 tags → 标签精确匹配（最多 15 条）
  2. 标签结果不足 → FTS5 全文搜索补充（最多 10 条）
  3. 合并去重 + 日期过滤
```

### pin_memory / unpin_memory — 置顶记忆

置顶记忆存储在 `pinned.md`，每行一条。写入前做 PII 脱敏。

### recall_experience / record_experience — 经验库

经验按分类存储在 `experience/*.md`，索引在 `experience.md`。
- 无参调用 `recall_experience` 返回分类概览
- 有参返回某分类的详细内容
- `record_experience` 去重后追加

---

## 网络工具

### web_search — 网络搜索

使用 DuckDuckGo 搜索（通过 `duck-duck-scrape` 库），返回搜索结果列表。

### web_fetch — 网页抓取

抓取指定 URL 的文本内容，用于获取网页信息。

---

## 书桌工具

### todo — 待办事项

```
action:
  - list: 列出所有待办
  - add: 添加待办 (text)
  - toggle: 切换完成状态 (id)
  - clear: 清除已完成

状态重建: 从 session 历史中的 toolResult(todo) 重建状态
```

### cron — 定时任务

```
action:
  - list: 列出所有定时任务
  - add: 添加任务
    type: "at" (一次性) | "every" (循环) | "cron" (cron 表达式)
    schedule: 时间字符串或毫秒数
    prompt: 要执行的指令
  - remove: 删除任务 (id)
  - toggle: 启用/禁用 (id)

审批: 未开启 autoApprove 时返回 pending_add 等待用户确认
```

### present_files — 文件呈现

当 Agent 创建了文件（PDF、Word 等），调用此工具让用户可以在对话中直接打开。

### create_artifact — 预览

创建 HTML/代码/Markdown 预览，内容在前端预览面板中渲染，不写磁盘。

---

## 浏览器工具

### browser — 浏览器控制

```
action:
  - start: 启动浏览器
  - stop: 关闭浏览器
  - navigate: 导航到 URL
  - snapshot: 获取 DOM 快照（文本格式，低成本）
  - screenshot: 截图（视觉格式，高成本）
  - click: 点击元素 (ref)
  - type: 输入文本 (ref, text)
  - scroll: 滚动 (direction, amount)
  - select: 选择下拉选项 (ref, value)
  - key: 按键 (key)
  - wait: 等待 (timeout)
  - evaluate: 执行 JavaScript (expression)
  - show: 显示浏览器窗口
```

**工具选择优先级**（在 System Prompt 中强制要求）：
1. `web_search` — 大多数搜索需求
2. `web_fetch` — 已知 URL，提取文本
3. `browser` — 只在需要交互、登录、JS 渲染时使用

浏览器通过 Electron 的 `WebContentsView` 实现，主进程通过 IPC 控制。

---

## 多 Agent 通信工具

### ask_agent — 跨 Agent 提问

```
参数:
  agent: string — 目标 Agent ID
  task: string — 任务描述

特点:
  - 同步执行，等待结果
  - 无记忆（noMemory: true）
  - 只读（readOnly: true）
  - 借用对方 Agent 的模型和人格
```

### dm — 发私信

```
参数:
  to: string — 目标 Agent ID
  message: string — 消息内容

特点:
  - 异步，不等待回复
  - 写入双方的 dm/{peerId}.md
  - 通知 DM Router 处理
```

### message_agent — 发私信并等待回复

```
参数:
  to: string — 目标 Agent ID
  message: string — 消息内容
  max_rounds: number — 最大对话轮次

特点:
  - 同步等待回复
  - 由 Hub 的 AgentMessenger 处理
```

### delegate — 委派子任务

```
参数:
  task: string — 任务描述
  model: string (可选) — 使用的模型

特点:
  - 在隔离环境执行
  - 只允许有限工具（search_memory, web_search, web_fetch 等）
  - 并发上限 3，超时 5 分钟
```

---

## 技能安装工具

### install_skill — 安装技能

```
参数:
  github_url: string (可选) — GitHub 仓库 URL
  skill_content: string (可选) — 直接提供技能内容
  skill_name: string (可选) — 技能名称
  reason: string (必填) — 安装原因

安装流程:
  模式 A (GitHub):
    1. 检查仓库 stars
    2. 拉取 SKILL.md
    3. 安全审查（调用 utility 模型检查 prompt injection）
    4. 写入 learned-skills/{name}/SKILL.md
    5. 触发 reload + sync

  模式 B (直接提供):
    1. 校验 skill_name
    2. 安全审查
    3. 写入
    4. 触发 reload + sync
```

---

## 工具的沙盒包装

所有工具在传给 Session 前会被沙盒包装：

### 路径工具包装 (wrapPathTool)

```
原始 read(path) → 包装后 read(path):
  1. resolvePath(path, cwd) — 解析绝对路径
  2. pathGuard.check(absolutePath, "read") — 权限检查
  3. 通过 → 调用原始 read
  4. 拒绝 → 返回 "[sandbox] 无权限: {reason}"
```

### Bash 工具包装 (wrapBashTool)

```
原始 bash(command) → 包装后 bash(command):
  1. preflight(command) — 检查危险命令（sudo 等）
  2. extractPaths(command) — 提取命令中的路径
  3. pathGuard.check(path, "write") — 检查每个路径
  4. 通过 → 调用沙盒化的 exec（seatbelt/bwrap/win32）
  5. 拒绝 → 返回 "[sandbox] 无权限: {reason}"
```
