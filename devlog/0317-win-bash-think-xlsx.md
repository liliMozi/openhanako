# 0317 Windows bash 修复 + think 标签解析 + xlsx/编码支持 (v0.41.0)

## Issue #41: Windows 命令执行失败

**根因**：Windows 上没装 Git Bash 时，`findShell()` fallback 到不存在的 `sh`，所有命令静默失败。

**修复**：
- `scripts/download-git-portable.js` — 换成 MinGit-busybox 变体（自带 sh.exe）
- `desktop/main.cjs` — 修正 PATH 注入路径为 `mingw64/bin` + `cmd`
- `lib/sandbox/win32-exec.js` — `findShell()` 新增内嵌 MinGit 路径检测 + PATH 找 sh.exe + 明确错误提示
- `lib/sandbox/index.js` — full-access 模式 Windows 也用自定义 exec

## Issue #42: 模型输出 `<think>` 思考过程

**根因**：DeepSeek/Qwen 等模型把思考过程作为 `<think>...</think>` 标签嵌入 text_delta，不走 PI SDK 的 thinking 协议，被当普通文本渲染。

**修复**：
- `core/events.js` — 新增 `ThinkTagParser`，和 MoodParser/XingParser 同模式
- `server/routes/chat.js` — 流式链路改为 ThinkTagParser → MoodParser → XingParser，think 内容转 thinking 事件
- `server/routes/sessions.js` — 历史消息 `stripThinkTags()` 剥离文本中的标签（仅 assistant 消息）

## Issue #44: read 不支持 xlsx + CSV 中文乱码

**根因**：PI SDK read tool 硬写 `buffer.toString("utf-8")`，不认二进制格式也不检测编码。

**修复**：
- `lib/sandbox/read-enhanced.js`（新建）— xlsx 用 ExcelJS 解析为纯文本表格 + 编码自动检测（GBK/UTF-8）
- `lib/sandbox/index.js` — 三条路径注入增强 readOps

## 额外修复

- `scripts/launch.js` — 清除 `ELECTRON_RUN_AS_NODE` 环境变量（从 VS Code/Claude Code 终端启动时被污染）

## Codex Review 修复

- `server/routes/chat.js` — turn_end flush 时 thinkTagParser 的 text 事件要走完整 mood → xing 管线（之前用 no-op callback 导致丢数据）
- `server/routes/sessions.js` — `stripThinkTags` 仅作用于 assistant 消息，不误伤 user 消息中的 `<think>`
- `lib/sandbox/read-enhanced.js` — 移除 `.xls`（ExcelJS 不支持旧版二进制格式）
