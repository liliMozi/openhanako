# 移动端 PWA

手机端通过 PWA 访问 Hanako，任意网络下私密可用，未来可迁移至云端部署。

---

## 架构目标

```
现在：
  Electron renderer → IPC 拿 token → HTTP/WS → Hono server → Engine

目标（两条链路并存）：
  Electron → 原有 random token（不变）
  PWA 手机 → 密码登录 → JWT → HTTP/WS → Hono server → Engine
```

单用户系统，不需要用户注册、角色管理。

---

## Phase 1：JWT 鉴权

### 1.1 依赖

- `jsonwebtoken`：签发 / 验证 JWT
- `bcryptjs`：密码哈希（纯 JS 实现，不需要 native build）

### 1.2 密码存储

- 首次启动时无密码，通过设置页面或 CLI 设置
- bcrypt hash 存在 `~/.hanako-dev/auth.json`：

```json
{
  "passwordHash": "$2b$10$...",
  "jwtSecret": "随机 64 字节 hex，首次生成后固定"
}
```

- `jwtSecret` 与现有 `SERVER_TOKEN` 独立，重启不变

### 1.3 登录接口

`POST /api/auth/login`（不需要 Bearer token，加入白名单）

```
请求：{ "password": "明文密码" }
响应：{ "token": "eyJhbG...", "expiresIn": "7d" }
错误：{ "error": "invalid password" }  → 401
```

JWT payload：`{ sub: "owner", iat, exp }`（单用户，不需要 userId）

### 1.4 改造 onRequest 中间件

现有逻辑（`server/index.js` L113-140）改为双轨验证：

```
1. 提取 Authorization: Bearer <token>（或 query ?token=）
2. 先尝试匹配 SERVER_TOKEN（原有逻辑，Electron 用）
3. 不匹配则尝试 jwt.verify(token, jwtSecret)
4. 都不过 → 403
```

白名单路由（不需要鉴权）：
- `POST /api/auth/login`
- `GET /api/health`
- 静态资源（PWA 的 HTML/JS/CSS）

### 1.5 Rate limiting

- 装 `Hono rate-limit middleware（内存计数器，按 IP + 时间窗口）`
- 登录接口：每 IP 每分钟 5 次（防暴力破解）
- 其他 API：每 IP 每分钟 60 次

---

## Phase 2：网络层

### 2.1 局域网直连（最小可用）

- Server 绑定地址从 `127.0.0.1` 改为可配置，默认仍 `127.0.0.1`
- `preferences.json` 加 `pwa.enabled: false`，开启后绑定 `0.0.0.0`
- CORS 放行局域网 IP 段（`192.168.*`、`10.*`、`172.16-31.*`）
- 仅限家用 WiFi，公共网络不安全

### 2.2 Tailscale 组网（任意网络私密访问）

- Mac 和手机都装 Tailscale，设备间 WireGuard 加密隧道
- Server 可以只监听 Tailscale 虚拟网卡 IP（`100.x.x.x`），比 `0.0.0.0` 更保守
- `tailscale cert` 签合法 TLS 证书，Hono 通过 `@hono/node-server` 的 `createServer` 选项加载
- 不依赖任何公网服务器，不暴露公网 IP

### 2.3 云端部署（未来）

需要额外组件：

| 组件 | 说明 |
|------|------|
| VPS | Engine 跑在云上，不再依赖 Mac 在线 |
| Caddy 反代 | TLS 终止 + 静态文件 + WebSocket 升级 |
| Let's Encrypt | 自动 HTTPS 证书 |
| CORS 白名单 | 只允许自己的域名 |
| refresh token | JWT 过期后静默续期，不用重新登录 |

云端部署时 Electron 桌面端也变成远程客户端，和 PWA 走同一套 JWT 鉴权。

---

## Phase 3：PWA 前端

### 3.1 技术选型

- 独立前端项目，放在 `pwa/` 目录
- React + Zustand（和桌面端一致，组件可复用）
- Vite 构建，输出静态文件由 Hono 的 `serveStatic` middleware serve

### 3.2 页面

1. **登录页** — 密码输入，拿到 JWT 存 localStorage
2. **对话页** — WebSocket 连接，流式消息渲染
3. **设置页**（可选）— agent 切换、模型切换

移动优先设计，不需要做桌面端的全部功能（desk、channels、skills 编辑等后续按需加）。

### 3.3 PWA 配置

- `manifest.json`：name、icons、`display: "standalone"`、`theme_color`
- Service Worker：缓存静态资源（HTML/JS/CSS），API 请求不缓存
- iOS 需要额外 meta 标签（`apple-mobile-web-app-capable` 等）

### 3.4 WebSocket 鉴权

现有 WS 升级通过 `?token=SERVER_TOKEN`，PWA 端改为 `?token=JWT`，中间件已兼容。

---

## Phase 4：安全加固

- [ ] 登录失败锁定（连续 5 次错误锁 15 分钟）
- [ ] JWT 黑名单（可选，用于主动注销）
- [ ] HTTPS 强制（非 localhost 时拒绝 HTTP）
- [ ] CSP 头（防 XSS）
- [ ] 敏感操作二次确认（删 agent、清记忆等）

---

## 实施顺序

```
Phase 1（JWT 鉴权）
  ↓ 可独立完成，桌面端不受影响
Phase 2.1（局域网直连）
  ↓ 配合 Phase 1 已可在家用
Phase 3（PWA 前端，最小可用：登录 + 对话）
  ↓ 手机可用
Phase 2.2（Tailscale）
  ↓ 任意网络可用
Phase 4（安全加固）
  ↓ 按需
Phase 2.3（云端部署）
```

Phase 1 + 2.1 + 3 是最小可用集，之后逐步加固。

---

## 现有基础

- Hono server 已 C/S 分离，18 个 route 文件，factory pattern（`createXxxRoute` 工厂函数）
- `onRequest` hook 已有 Bearer token 校验，改造为双轨即可
- WebSocket 流式协议已完整（text_delta、tool 事件、resume 等）
- CORS 已支持 `HANA_CORS_ORIGIN` 环境变量
- 桌面端 React + Zustand 组件可部分复用
