/**
 * Hanako Server — HTTP + WebSocket API
 *
 * 启动方式：
 *   node server/index.js              （独立运行）
 *   Electron main.js fork 启动        （桌面应用内嵌）
 *
 * 当通过 fork() 启动时，会通过 IPC 通知父进程端口号。
 */
import crypto from "crypto";
import fs from "fs";
import { setMaxListeners } from "events";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { registerErrorHandler } from './middleware/error-handler.js';
import { HanaEngine } from "../core/engine.js";
import { ensureFirstRun } from "../core/first-run.js";
import { initDebugLog } from "../lib/debug-log.js";

// Pi SDK 的 fetch 请求会累积 AbortSignal listener，提高上限避免无害警告
setMaxListeners(50);

import { loadLocale } from "./i18n.js";
import chatRoute from "./routes/chat.js";
import sessionsRoute from "./routes/sessions.js";
import modelsRoute from "./routes/models.js";
import configRoute from "./routes/config.js";
import uploadRoute from "./routes/upload.js";
import providersRoute from "./routes/providers.js";
import avatarRoute from "./routes/avatar.js";
import agentsRoute from "./routes/agents.js";
import deskRoute from "./routes/desk.js";
import skillsRoute from "./routes/skills.js";
import channelsRoute from "./routes/channels.js";
import dmRoute from "./routes/dm.js";
import fsRoute from "./routes/fs.js";
import preferencesRoute from "./routes/preferences.js";
import bridgeRoute from "./routes/bridge.js";
import authRoute from "./routes/auth.js";
import diaryRoute from "./routes/diary.js";
import confirmRoute from "./routes/confirm.js";
import { ConfirmStore } from "../lib/confirm-store.js";
import { BridgeManager } from "../lib/bridge/bridge-manager.js";
import { Hub } from "../hub/index.js";
import { startCLI } from "./cli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const productDir = path.join(projectRoot, "lib");

// 用户数据存放在 ~/.hanako/（打包后与产品代码分离）
// 开发时可通过 HANA_HOME 环境变量隔离数据目录，如：HANA_HOME=~/.hanako-dev node server/index.js
const hanakoHome = process.env.HANA_HOME
  ? path.resolve(process.env.HANA_HOME.replace(/^~/, os.homedir()))
  : path.join(os.homedir(), ".hanako");
process.env.HANA_HOME = hanakoHome;
// ── 首次运行播种 ──
console.log("[server] ① ensureFirstRun...");
ensureFirstRun(hanakoHome, productDir);
console.log("[server] ① ensureFirstRun 完成");

// ── 初始化 Debug 日志 ──
const dlog = initDebugLog(path.join(hanakoHome, "logs"));

// 读取版本号
let appVersion = "?";
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
  appVersion = pkg.version || "?";
} catch {}

// ── 初始化引擎 ──
console.log("[server] ② 创建 HanaEngine...");
const engine = new HanaEngine({ hanakoHome, productDir });
console.log("[server] ② HanaEngine 构造完成，开始 init...");
await engine.init((msg) => console.log(`[server] ${msg}`));
console.log("[server] ② engine.init 完成");
dlog.log("server", "engine initialized");

// 注入 session 解析器给 BrowserManager（避免循环依赖）
import { BrowserManager } from "../lib/browser/browser-manager.js";
BrowserManager.setSessionResolver(() => engine.currentSessionPath);

if (engine.currentModel) {
  console.log("[server] ③ 创建 session...");
  await engine.createSession();
  console.log("[server] ③ Session created");
  dlog.log("server", `session created, model=${engine.currentModel.name}`);
} else {
  console.warn("[server] ⚠ 无可用模型，跳过 session 创建。请在设置中配置 API key。");
  dlog.warn("server", "no models available, session creation skipped");
}

// 写日志头部
dlog.header(appVersion, {
  model: engine.currentModel?.name || "(none)",
  agent: engine.agentName,
  agentId: engine.currentAgentId,
  utilityModel: (() => { try { return engine.resolveUtilityConfig?.()?.utility; } catch { return "(none)"; } })(),
  channelsDir: engine.channelsDir,
});

// ── 初始化 Hub（调度中枢，包装 engine） ──
const hub = new Hub({ engine });

// 启动 Hub 调度器（Scheduler + ChannelRouter）
hub.initSchedulers();

// 加载 i18n
loadLocale(engine.config?.locale);

// ── 启动令牌（阻止本机其他程序随意访问） ──
const SERVER_TOKEN = process.env.HANA_TOKEN || crypto.randomBytes(16).toString("hex");

// ── 创建 Fastify 实例 ──
const app = Fastify({ logger: false });

// CORS（默认仅允许 localhost，HANA_CORS_ORIGIN 可放宽）
const corsAllowedOrigin = process.env.HANA_CORS_ORIGIN;
app.addHook("onRequest", (req, reply, done) => {
  const origin = req.headers.origin || "";
  const isAllowed = corsAllowedOrigin
    ? origin === corsAllowedOrigin
    : /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (origin && isAllowed) {
    reply.header("Access-Control-Allow-Origin", origin);
  }
  reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    reply.code(204).send();
    return;
  }
  // 验证 token（WebSocket 升级请求通过 URL 参数传 token，在 chat.js 中校验）
  const token = req.headers.authorization?.replace("Bearer ", "")
    || req.query?.token;
  if (token !== SERVER_TOKEN) {
    reply.code(403).send({ error: "forbidden" });
    return;
  }
  done();
});

// WebSocket 支持
await app.register(websocket);
registerErrorHandler(app);

// ── 阻塞式确认存储 ──
const confirmStore = new ConfirmStore();
confirmStore.onResolved = (confirmId, action) => {
  engine._emitEvent({ type: "confirmation_resolved", confirmId, action }, null);
};
engine._confirmStore = confirmStore;

// ── 外部平台接入管理器 ──
const bridgeManager = new BridgeManager({ engine, hub });
hub.bridgeManager = bridgeManager;

// 注册路由
app.register(chatRoute, { engine, hub });
app.register(sessionsRoute, { engine });
app.register(modelsRoute, { engine });
app.register(configRoute, { engine });
app.register(uploadRoute, { engine });
app.register(providersRoute, { engine });
app.register(avatarRoute, { engine });
app.register(agentsRoute, { engine });
app.register(deskRoute, { engine, hub });
app.register(skillsRoute, { engine });
app.register(channelsRoute, { engine, hub });
app.register(dmRoute, { engine });
app.register(fsRoute, { engine });
app.register(preferencesRoute, { engine });
app.register(bridgeRoute, { engine, bridgeManager });
app.register(authRoute, { engine });
app.register(diaryRoute, { engine });
app.register(confirmRoute, { confirmStore, engine });

// 健康检查 + 身份信息
app.get("/api/health", async () => {
  // 检查自定义头像是否存在（避免前端 HEAD 请求 404）
  const avatars = {};
  for (const role of ['agent', 'user']) {
    const dir = path.join(role === 'user' ? engine.userDir : engine.agentDir, 'avatars');
    avatars[role] = false;
    try {
      const files = fs.readdirSync(dir);
      avatars[role] = files.some(f => /\.(png|jpe?g|webp)$/i.test(f));
    } catch {}
  }
  return {
    status: "ok",
    agent: engine.agentName,
    user: engine.userName,
    model: engine.currentModel?.name,
    avatars,
  };
});

// 前端日志上报（desktop 端把错误 POST 到 server 写进持久化日志）
app.post("/api/log", async (req) => {
  const { level, module, message } = req.body || {};
  if (!message) return { ok: false };
  if (level === "error") dlog.error(module || "desktop", message);
  else if (level === "warn") dlog.warn(module || "desktop", message);
  else dlog.log(module || "desktop", message);
  return { ok: true };
});

// Plan Mode（只读探索模式）
app.get("/api/plan-mode", async () => ({ enabled: engine.planMode }));
app.post("/api/plan-mode", async (req) => {
  const { enabled } = req.body || {};
  engine.setPlanMode(!!enabled);
  return { ok: true, enabled: engine.planMode };
});

// 远程关闭（供 desktop 端复用 server 退出时调用，跨平台可靠的 graceful shutdown）
app.post("/api/shutdown", async () => {
  console.log("[server] 收到 HTTP shutdown 请求，正在清理...");
  // 异步执行，先返回响应
  setTimeout(() => gracefulShutdown(), 100);
  return { ok: true };
});

// ── 启动服务器 ──
const port = parseInt(process.env.HANA_PORT) || 0; // 0 = OS 分配
const host = "127.0.0.1";

try {
  await app.listen({ port, host });
  const address = app.server.address();
  const actualPort = address.port;

  console.log(`[server] Hanako Server 运行在 http://${host}:${actualPort}`);
  dlog.log("server", `listening on :${actualPort}`);

  // 写 server-info 文件，供 Electron 检测复用或外部工具查询
  const serverInfoPath = path.join(hanakoHome, "server-info.json");
  try {
    fs.writeFileSync(serverInfoPath, JSON.stringify({ pid: process.pid, port: actualPort, token: SERVER_TOKEN }));
  } catch (e) {
    console.error("[server] 写入 server-info.json 失败:", e.message);
  }

  // 自动启动已配置的外部平台
  bridgeManager.autoStart();
  dlog.log("server", "bridge autoStart done");

  if (process.send) {
    // Electron fork 模式：通知父进程
    process.send({ type: "ready", port: actualPort, token: SERVER_TOKEN });
    process.on("message", async (msg) => {
      if (msg?.type === "shutdown") {
        console.log("[server] 收到关闭信号，正在清理...");
        await gracefulShutdown();
      }
    });
  } else {
    // 独立运行模式：启动 CLI
    startCLI({
      port: actualPort,
      token: SERVER_TOKEN,
      agentName: engine.agentName,
      userName: engine.userName,
    });
  }

} catch (err) {
  console.error("[server] 启动失败:", err.message);
  process.exit(1);
}

// 优雅退出（防止并发关闭，带超时保护）
let _shutting = false;
async function gracefulShutdown() {
  if (_shutting) return;
  _shutting = true;
  console.log("\n[server] 正在关闭...");
  dlog.log("server", "shutting down...");

  // 超时保护：15 秒内必须完成（含 memory final pass LLM 调用），否则强制退出
  const forceTimer = setTimeout(() => {
    console.error("[server] 关闭超时，强制退出");
    process.exit(1);
  }, 15000);
  forceTimer.unref();

  try {
    // 1. 先停止接受新请求
    await app.close();
    console.log("[server] Fastify 已关闭");
    dlog.log("server", "Fastify closed");

    // 2. 挂起浏览器（保留冷保存，重启后可恢复卡片）
    try {
      const { BrowserManager } = await import("../lib/browser/browser-manager.js");
      const bm = BrowserManager.instance();
      if (bm.isRunning) {
        const sessionPath = engine.currentSessionPath;
        await bm.suspendForSession(sessionPath);
        console.log("[server] 浏览器已挂起（冷保存保留）");
      }
    } catch (e) {
      console.error("[server] 浏览器挂起失败:", e.message);
    }

    // 3. 停止外部平台
    bridgeManager.stopAll();
    dlog.log("server", "bridge stopped");

    // 4. 清理 Hub + 引擎（停 ticker → 等 tick 完成 → 关 DB → 清理 session）
    await hub.dispose();
    console.log("[server] Hub + Engine 已清理");
    dlog.log("server", "hub + engine disposed");
  } catch (err) {
    console.error("[server] 关闭出错:", err.message);
    dlog.error("server", `shutdown error: ${err.message}`);
  }

  clearTimeout(forceTimer);
  try { fs.unlinkSync(path.join(hanakoHome, "server-info.json")); } catch {}
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
if (process.platform === "win32") process.on("SIGBREAK", gracefulShutdown);

// 全局未捕获错误（写入持久化日志，防止崩溃无痕）
let _stdoutBroken = false;
function _safeConsoleError(...args) {
  if (_stdoutBroken) return;
  try {
    console.error(...args);
  } catch {
    _stdoutBroken = true;
  }
}

process.on("uncaughtException", (err) => {
  if (err?.code === "EPIPE" || err?.code === "ERR_IPC_CHANNEL_CLOSED") {
    if (!_stdoutBroken) {
      _stdoutBroken = true;
      dlog.error("server", `stdout pipe broken (${err.code}), suppressing further console output`);
    }
    return;
  }
  dlog.error("server", `uncaughtException: ${err.message}`);
  _safeConsoleError("[server] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  dlog.error("server", `unhandledRejection: ${reason}`);
  _safeConsoleError("[server] unhandledRejection:", reason);
});
