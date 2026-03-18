# OpenHanako 深度工程文档

本文档是对 OpenHanako 仓库的深度系统讲解，面向希望理解项目全貌的开发者。

## 文档目录

| 编号 | 文档 | 内容 |
|------|------|------|
| 01 | [项目概览](./01-项目概览.md) | 项目介绍、技术栈、目录结构、运行命令、数据目录 |
| 02 | [整体架构](./02-整体架构.md) | 分层架构图、数据流、启动流程、进程模型 |
| 03 | [核心引擎 (core/)](./03-核心引擎-core.md) | HanaEngine、Agent、AgentManager、SessionCoordinator、流式解析器 |
| 04 | [记忆系统 (lib/memory/)](./04-记忆系统-memory.md) | FactStore、滚动摘要、四阶段编译、深度记忆、搜索工具 |
| 05 | [沙盒安全 (lib/sandbox/)](./05-沙盒安全-sandbox.md) | PathGuard、seatbelt、bwrap、Windows 适配、安全策略 |
| 06 | [工具系统 (lib/tools/)](./06-工具系统-tools.md) | 15+ 工具详解：记忆、网络、书桌、浏览器、多 Agent 通信 |
| 07 | [消息调度 (hub/)](./07-消息调度-hub.md) | Hub 路由、EventBus、Scheduler、频道、Agent 间通信 |
| 08 | [服务端 (server/)](./08-服务端-server.md) | Fastify 启动、WebSocket 协议、REST API、CLI |
| 09 | [桌面应用 (desktop/)](./09-桌面应用-desktop.md) | Electron 主进程、React 前端、Zustand 状态管理、设置页面 |
| 10 | [外部平台 (lib/bridge/)](./10-外部平台-bridge.md) | Telegram、飞书、QQ 适配器、消息收发、主人/访客 |
| 11 | [人格与技能](./11-人格与技能-yuan-skills.md) | Yuan 人格模板、MOOD 框架、内置技能、书桌系统 |
| 12 | [关键设计决策](./12-关键设计决策.md) | 12 个重要架构决策及其原因 |

## 阅读建议

**如果你是完全的新手**，建议按以下顺序阅读：

1. 先读 **01-项目概览** — 了解项目是什么、能做什么
2. 再读 **02-整体架构** — 理解各模块如何协作
3. 然后按兴趣深入：
   - 对 AI 感兴趣 → **03-核心引擎** + **04-记忆系统** + **11-人格与技能**
   - 对安全感兴趣 → **05-沙盒安全**
   - 对前端感兴趣 → **09-桌面应用**
   - 对后端感兴趣 → **07-消息调度** + **08-服务端**
4. 最后读 **12-关键设计决策** — 理解"为什么这样做"

## 核心概念速查

| 概念 | 解释 |
|------|------|
| Agent | 一个 AI 角色，有独立的身份、记忆、工具 |
| Session | 一次对话，包含消息历史 |
| Yuan | Agent 的"源"人格类型（Hanako/Butter/Ming） |
| MOOD | Hanako 人格的意识流思维框架 |
| Ishiki | Agent 的行为准则和意识设定 |
| Skill | Agent 可学习的技能（Markdown 格式） |
| 书桌 | Agent 的工作空间（文件系统目录） |
| 笺 | 放在书桌上的 Markdown 指令文件 |
| Bridge | 外部平台接入（Telegram/飞书/QQ） |
| Hub | 消息调度中枢 |
| FactStore | 元事实数据库（SQLite FTS5） |
| Pi SDK | 底层 AI Agent 运行时 |
