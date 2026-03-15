# Contributing to Hanako

感谢你对 Hanako 的关注！欢迎提交 issue 和 pull request。

## 开发环境

### 前置条件

- Node.js >= 20
- npm >= 10
- C/C++ 编译工具链（编译 `better-sqlite3` native module 需要）：
  - **macOS**：`xcode-select --install`（安装 Command Line Tools）
  - **Linux**：`sudo apt install build-essential python3`（Debian/Ubuntu）
  - **Windows**：`npm install -g windows-build-tools` 或安装 Visual Studio Build Tools

### 本地运行

```bash
# 安装依赖
npm install

# 启动 Electron（自动构建前端）
npm start

# 或者用 Vite HMR 开发前端
npm run dev:renderer
# 另一个终端
npm run start:vite
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm start` | 构建前端 + 启动 Electron |
| `npm run start:vite` | Vite HMR 模式启动 |
| `npm test` | 运行测试（Vitest） |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run build:renderer` | 单独构建前端 |

### Native Module 注意事项

项目使用 `better-sqlite3`，需要为 Electron 编译 native module。`npm install` 会自动执行 `electron-rebuild`。如果遇到 `ERR_DLOPEN_FAILED`，手动执行：

```bash
npx electron-rebuild -f -w better-sqlite3
```

## Pull Request

项目目前处于早期阶段，**暂不接受 Pull Request**。如果你有想法或发现了问题，欢迎先开 issue 讨论。

## 报告问题

提交 issue 时请包含：

- 操作系统和版本
- Node.js 版本
- 复现步骤
- 期望行为 vs 实际行为
- 相关日志或截图

## 项目结构

```
core/           # Engine 编排层 + Manager
lib/            # 核心库（bridge、sandbox、memory、tools）
server/         # Fastify HTTP + WebSocket 服务
desktop/        # Electron 应用 + React 前端
hub/            # Scheduler 后台任务
tests/          # Vitest 测试
skills2set/     # Skills 定义
```

## License

提交贡献即表示你同意你的代码以 [Apache License 2.0](LICENSE) 授权。
