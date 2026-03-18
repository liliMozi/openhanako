# 桌面应用 (desktop/)

桌面应用由 Electron 主进程 + React 前端组成。

## 目录结构

```
desktop/
├── main.cjs              # Electron 主进程入口（2100+ 行）
├── preload.cjs           # Preload 脚本（contextBridge）
├── src/
│   ├── index.html        # 主窗口 HTML
│   ├── main.tsx          # React 入口
│   ├── settings.html     # 设置窗口 HTML
│   ├── splash.html       # 启动画面
│   ├── onboarding.html   # 首次配置向导
│   ├── app.js            # 旧前端主入口（Vanilla JS，逐步迁移中）
│   ├── styles.css        # 全局样式
│   ├── lib/              # 前端库（i18n, theme, markdown-it）
│   ├── locales/          # 国际化（en.json, zh.json）
│   ├── themes/           # 8 套主题 CSS
│   ├── modules/          # 旧模块（platform, icons, utils）
│   └── react/            # React 组件和状态管理
│       ├── App.tsx            # React 根组件
│       ├── bridge.ts          # 旧代码 ↔ Zustand 桥接
│       ├── types.ts           # 类型定义
│       ├── components/        # UI 组件
│       ├── hooks/             # 自定义 Hooks
│       ├── stores/            # Zustand 状态切片
│       ├── settings/          # 设置页面
│       └── shims/             # 旧代码兼容层
```

---

## Electron 主进程 (main.cjs)

### 核心职责

1. **启动流程管理** — Splash → Server fork → 主窗口
2. **多窗口管理** — 主窗口、设置、DevTools、技能预览、浏览器查看器、编辑器、Onboarding
3. **Server 生命周期** — fork、复用、监控、崩溃重启
4. **嵌入式浏览器** — WebContentsView 的创建、导航、快照、交互
5. **系统集成** — 托盘、通知、文件选择、原生拖拽

### 启动流程

```
app.whenReady()
  │
  ├── 1. 创建 Splash 窗口
  │
  ├── 2. first-run 检查
  │      └── 首次运行：创建 ~/.hanako/，复制默认 Agent
  │
  ├── 3. startServer()
  │      ├── 检查是否有已运行的 Server（端口复用）
  │      ├── fork("server/boot.cjs")
  │      ├── 等待 IPC { type: "ready", port, token }
  │      └── monitorServer()（监控崩溃）
  │
  ├── 4. 收到 ready
  │      ├── 关闭 Splash
  │      ├── isSetupComplete()?
  │      │   ├── 否 → 打开 Onboarding
  │      │   └── 是 → createMainWindow()
  │      └── 创建托盘图标
  │
  └── 5. 主窗口
         ├── 恢复窗口位置/大小（window-state.json）
         ├── 加载前端
         │   ├── 开发模式：http://localhost:5173
         │   └── 生产模式：dist-renderer/index.html
         └── 注册 IPC handlers
```

### 嵌入式浏览器

AI Agent 可以通过 `browser` 工具控制一个嵌入在 Electron 中的浏览器。

```
Server 发送 IPC: { type: "browser-cmd", cmd: "launch", params: { url: "..." } }
  │
  ├── 主进程创建 WebContentsView
  │   └── session: "persist:hana-browser"（持久化 cookie 等）
  │
  ├── 挂载到主窗口
  │
  └── 支持的命令:
      ├── launch — 创建并导航
      ├── close — 关闭
      ├── navigate — 导航到新 URL
      ├── snapshot — 生成 DOM 快照
      │   └── 注入 SNAPSHOT_SCRIPT，为可交互元素打 data-hana-ref
      ├── screenshot — 截图（capturePage）
      ├── click — 点击元素（通过 ref）
      ├── type — 输入文本
      ├── scroll — 滚动
      ├── select — 选择下拉选项
      ├── pressKey — 按键
      ├── wait — 等待
      ├── evaluate — 执行 JavaScript
      ├── suspend — 挂起（切换 Session 时）
      └── resume — 恢复
```

### 多 Session 浏览器管理

```
_browserViews: Map<sessionPath, WebContentsView>

切换 Session 时:
  1. suspend 当前浏览器视图
  2. 从 Map 中查找目标 Session 的视图
  3. 有 → resume
  4. 无 → 等待 Agent 调用 browser(action: "start")
```

### 崩溃恢复

```
monitorServer()
  │
  ├── Server 进程退出
  │   ├── 正常退出（code 0）→ 不重启
  │   └── 崩溃退出
  │       ├── writeCrashLog()（写入 ~/.hanako/crash.log）
  │       ├── 已重启过？
  │       │   ├── 是 → 显示错误对话框，退出
  │       │   └── 否 → 自动重启一次
  │       └── 重启 Server
  │
  └── 重启后重新连接
```

---

## Preload 脚本 (preload.cjs)

通过 `contextBridge.exposeInMainWorld("hana")` 暴露安全 API：

### API 分组

| 分组 | API | 用途 |
|------|-----|------|
| Server 连接 | `getServerPort()`, `getServerToken()` | 获取端口和 Token |
| 文件系统 | `readFile()`, `writeFile()`, `watchFile()` | 读写、监听 |
| 格式转换 | `readFileBase64()`, `readDocxHtml()`, `readXlsxHtml()` | 图片/文档预览 |
| 窗口 | `openSettings()`, `openBrowserViewer()`, `openEditorWindow()` | 打开各类窗口 |
| 系统 | `selectFolder()`, `selectSkill()`, `showNotification()` | 系统对话框、通知 |
| 事件 | `onSettingsChanged()`, `onBrowserUpdate()` | 主进程推送 |
| 窗口控制 | `windowMinimize()`, `windowMaximize()`, `windowClose()` | 无框窗口标题栏 |

### 安全边界

- Preload 只暴露有限的 IPC 通道
- 业务数据不经过 Preload，前端直接用 HTTP/WS 访问 Server
- Preload 只负责窗口管理、文件系统、系统对话框等 Electron 能力

---

## React 前端

### 状态管理 — Zustand

使用 Zustand 的 slice 模式组合多个领域状态：

| Slice | 状态 | 说明 |
|-------|------|------|
| ConnectionSlice | serverPort, serverToken, connected | 连接信息 |
| SessionSlice | sessions, currentSession | 会话列表和状态 |
| StreamingSlice | isStreaming | 流式输出状态 |
| UiSlice | activePanel, sidebarVisible | UI 状态 |
| AgentSlice | agents, currentAgent | Agent 列表和状态 |
| ChannelSlice | channels | 频道数据 |
| DeskSlice | deskFiles | 书桌文件 |
| ModelSlice | models, thinkingLevel | 模型和思考级别 |
| InputSlice | attachedFiles, docContext | 输入附件 |
| MiscSlice | 其他 | 杂项 |

### 旧代码桥接 (bridge.ts)

项目正在从 Vanilla JS (`app.js`) 迁移到 React。桥接层让两套代码共存：

```
旧 app.js 的 state 对象
  │
  ├── window.__hanaActivateProxy(getState, setState)
  │   └── 将 state 变成 Proxy，读写都转到 Zustand
  │
  └── Legacy Shims
      ├── app-messages-shim.ts — 消息渲染
      ├── app-agents-shim.ts — Agent 管理
      ├── app-ws-shim.ts — WebSocket
      ├── app-ui-shim.ts — UI 操作
      ├── artifacts-shim.ts — Artifact 预览
      ├── channels-shim.ts — 频道
      ├── desk-shim.ts — 书桌
      └── sidebar-shim.ts — 侧边栏
```

### 组件结构

```
App.tsx
├── ErrorBoundary — 错误边界
├── ActivityPanel — 活动面板（心跳、Cron 执行记录）
├── AutomationPanel — 自动化面板（Cron 任务管理）
├── BridgePanel — 接入面板（Telegram/飞书/QQ 会话）
├── PreviewPanel — 预览面板（Artifact 渲染）
├── BrowserCard — 浏览器状态卡片
├── DeskSection — 书桌区域（文件列表）
├── InputArea — 输入区域（核心交互组件）
├── SessionList — 会话列表
└── WelcomeScreen — 欢迎页面
```

### InputArea — 核心交互组件

InputArea 是用户与 Agent 交互的主要入口：

```
功能:
  - 文本输入（支持多行）
  - 附件上传（拖拽或选择）
  - 图片发送（base64 编码）
  - 文档上下文附加
  - 斜杠命令（/diary, /xing 等）
  - 发送 / 插话 / 停止
  - Plan Mode 切换
  - Thinking Level 调整
  - 模型选择

通信方式:
  - 发送消息: WebSocket { type: "prompt", text, images? }
  - 插话: WebSocket { type: "steer", text }
  - 停止: WebSocket { type: "abort" }
  - Plan Mode: HTTP POST /api/plan-mode
  - 模型切换: HTTP POST /api/models/set
```

---

## 设置页面 (settings/)

设置页面是独立的 Electron 窗口，有自己的 Zustand store。

### Tab 列表

| Tab | 组件 | 功能 |
|-----|------|------|
| Agent | AgentTab | Agent 管理（名字、yuan、身份、意识） |
| Me | MeTab | 用户档案（user.md） |
| Interface | InterfaceTab | 界面设置（主题、语言） |
| Work | WorkTab | 工作设置（书桌路径、沙盒、记忆） |
| Skills | SkillsTab | 技能管理（启用/禁用/安装/删除） |
| Bridge | BridgeTab | 外部平台接入（Telegram/飞书/QQ） |
| Providers | ProvidersTab | API Provider 配置 |
| Models | ModelsTab | 模型管理（收藏、utility 模型） |
| About | AboutTab | 关于信息 |

### 与主窗口同步

```
设置页面修改 → platform.settingsChanged(type, data)
  → IPC → 主进程
  → 主进程转发给主窗口
  → 主窗口刷新相关状态
```

---

## 主题系统

8 套内置主题：

| 主题 | 风格 |
|------|------|
| warm-paper | 暖纸色（默认） |
| midnight | 深色 |
| high-contrast | 高对比度 |
| grass-aroma | 草绿色 |
| contemplation | 沉思灰 |
| delve | 深邃蓝 |
| deep-think | 深度思考 |
| absolutely | 纯黑 |

---

## 国际化

支持中文和英文，语言文件在 `src/locales/`：
- `zh.json` — 中文
- `en.json` — 英文

通过 `lib/i18n.js` 加载，`use-i18n.ts` Hook 在 React 中使用。
