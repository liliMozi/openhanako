# 沙盒安全系统 (lib/sandbox/)

AI Agent 能执行代码、读写文件，这带来了安全风险。沙盒系统的职责是**限制 Agent 的能力边界**，防止它访问敏感文件或执行危险操作。

## 设计原则

1. **纵深防御** — 应用层（PathGuard）+ OS 层（seatbelt/bwrap）双重保护
2. **Fail-closed** — 路径解析失败时默认拒绝
3. **最小权限** — 默认只读，只有明确允许的路径才可写
4. **平台适配** — macOS/Linux/Windows 各有最佳方案

## 架构总览

```
createSandboxedTools(cwd, tools, opts)
  │
  ├── deriveSandboxPolicy() — 推导安全策略
  │
  ├── mode === "full-access"?
  │   ├── 是 → 返回原始工具（无限制）
  │   └── 否 → 继续
  │
  ├── detectPlatform()
  │   ├── macOS → seatbelt (sandbox-exec)
  │   ├── Linux → bwrap (bubblewrap)
  │   └── Windows → win32-full-access (仅 PathGuard)
  │
  ├── wrapPathTool() — 包装 read/write/edit/grep/find/ls
  │   └── 执行前做 PathGuard 校验
  │
  └── wrapBashTool() — 包装 bash
      ├── preflight 检查（禁止 sudo 等危险命令）
      ├── 提取命令中的路径
      ├── PathGuard 校验每个路径
      └── 替换 exec 为沙盒化的 exec
```

## 安全策略 (policy.js)

### 路径权限分类

| 权限 | 路径 | 说明 |
|------|------|------|
| **BLOCKED** | `auth.json`, `models.json`, `providers.yaml`, `crash.log` | 完全禁止访问 |
| **BLOCKED** | `browser-data/`, `playwright-browsers/` | 完全禁止访问 |
| **READ_ONLY** | `ishiki.md`, `config.yaml`, `identity.md`, `yuan.md` | Agent 配置文件只读 |
| **READ_ONLY** | `user/`, `skills/`, `learned-skills/` | 共享数据只读 |
| **READ_WRITE** | `memory/`, `sessions/`, `desk/`, `activity/`, `avatars/` | Agent 数据可读写 |
| **READ_WRITE** | `pinned.md`, `channels.md` | Agent 文件可读写 |
| **READ_WRITE** | `channels/`, `logs/` | 全局目录可读写 |
| **FULL** | workspace（书桌目录） | 完全访问 |

### 策略输出

```javascript
{
  writablePaths: [...],    // OS 沙盒允许写入的路径
  denyReadPaths: [...],    // OS 沙盒禁止读取的路径
  protectedPaths: [...],   // OS 沙盒写保护的路径（如 .git）
}
```

## PathGuard — 路径守卫

### 访问级别

```
BLOCKED < READ_ONLY < READ_WRITE < FULL
```

### 操作要求

| 操作 | 最低权限 |
|------|----------|
| read | READ_ONLY |
| write | READ_WRITE |
| delete | FULL |

### 匹配顺序

PathGuard 按以下顺序检查路径，**第一个匹配的规则生效**：

```
1. BLOCKED 文件（auth.json 等）
2. BLOCKED 目录（browser-data/ 等）
3. READ_ONLY Agent 文件（config.yaml 等）
4. READ_ONLY Agent 目录（learned-skills/）
5. READ_ONLY 全局目录（user/, skills/）
6. READ_WRITE Agent 目录（memory/, sessions/ 等）
7. READ_WRITE Agent 文件（pinned.md 等）
8. READ_WRITE 全局目录（channels/, logs/）
9. hanakoHome 内未匹配 → BLOCKED
10. workspace 内 → FULL
11. 其他 → BLOCKED
```

### 符号链接处理

使用 `fs.realpathSync` 解析符号链接，防止通过软链接绕过路径限制。路径不存在时解析父目录。

## macOS 沙盒 — seatbelt

使用 macOS 内置的 `sandbox-exec` 命令和 SBPL（Sandbox Profile Language）。

### 执行流程

```
1. writeScript(command, cwd) — 写临时 .sh 脚本
2. generateProfile(policy) — 生成 SBPL profile
3. writeProfile(profile) — 写临时 .sb 文件
4. spawnAndStream("sandbox-exec", ["-f", profilePath, "/bin/bash", scriptPath])
5. cleanup() — 删除临时文件
```

### SBPL Profile 结构

```scheme
(version 1)
(deny default)                              ; 默认拒绝一切
(allow process-exec* process-fork signal)   ; 允许执行进程
(allow file-read*)                          ; 全局可读

; 可写路径
(allow file-write* (subpath "/Users/xxx/.hanako/agents/hanako/memory"))
(allow file-write* (subpath "/Users/xxx/workspace"))
(allow file-write* (subpath "/private/tmp"))

; 写保护
(deny file-write* (subpath "/Users/xxx/workspace/.git"))

; 禁止读取
(deny file-read* file-write* (subpath "/Users/xxx/.hanako/browser-data"))

; 禁止网络
(deny network*)
```

**关键特性**：
- 默认拒绝策略（deny default）
- 网络隔离（deny network*）
- macOS `/var` → `/private/var` 符号链接处理

## Linux 沙盒 — bwrap

使用 bubblewrap（bwrap）进行容器化隔离。

### bwrap 参数

```bash
bwrap \
  --ro-bind / /                    # 根目录只读
  --dev /dev                       # 设备目录
  --proc /proc                     # 进程信息
  --tmpfs /tmp                     # 临时目录
  --unshare-pid                    # 独立 PID 命名空间
  --unshare-net                    # 无网络
  --new-session                    # 新会话
  --die-with-parent                # 父进程退出时子进程一起退出
  --bind /writable/path /writable/path  # 可写路径
  --ro-bind /protected/.git /protected/.git  # 写保护
  --tmpfs /deny/read/path          # 拒绝读取（用 tmpfs 隐藏）
  -- /bin/bash /tmp/script.sh
```

**关键特性**：
- 内核级隔离（namespace）
- 网络隔离（--unshare-net）
- PID 隔离（--unshare-pid）
- 敏感路径用 tmpfs 隐藏

## Windows — PathGuard Only

Windows 没有 seatbelt/bwrap 这样的轻量沙盒工具，所以：

- **无 OS 级沙盒**，安全完全依赖 PathGuard + preflight
- 使用自定义 `createWin32Exec()` 替代 Pi SDK 默认实现（修复 stdout/stderr 为空的问题）

### Shell 查找顺序

Windows 需要找到可用的 bash/sh：

```
1. 系统 Git Bash（ProgramFiles, scoop 等）
2. 注册表查询 Git 安装路径
3. 内嵌 MinGit-busybox 的 sh.exe
4. PATH 上的 bash.exe / sh.exe（排除 WSL launcher）
5. MSYS2 / Cygwin
```

## Preflight 检查

在执行 bash 命令前，检查是否包含危险命令：

### Unix 通用

```
sudo, su, chmod, chown
```

### Windows 额外

```
del /s, rmdir /s, reg delete/add, takeown, icacls,
net user/localgroup, schtasks /create, sc create/delete,
PowerShell bypass, format, bcdedit, wmic
```

## 安全边界总结

| 平台 | 应用层 | OS 层 | 网络 |
|------|--------|-------|------|
| macOS | PathGuard + Preflight | seatbelt (sandbox-exec) | 隔离 |
| Linux | PathGuard + Preflight | bwrap (bubblewrap) | 隔离 |
| Windows | PathGuard + Preflight | 无 | 不隔离 |

**重要**：Windows 上的安全性最弱，建议在 Windows 上使用时保持沙盒开启并注意 Agent 的行为。
