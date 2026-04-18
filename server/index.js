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
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { WebSocketServer } from "ws";
import { AppError } from "../shared/errors.js";
import { errorBus } from "../shared/error-bus.js";
import { HanaEngine } from "../core/engine.js";
import { ensureFirstRun } from "../core/first-run.js";
import { initDebugLog } from "../lib/debug-log.js";
import { safeJson } from "./hono-helpers.js";

// Pi SDK 的 fetch 请求会累积 AbortSignal listener，提高上限避免无害警告
setMaxListeners(50);

import { loadLocale } from "./i18n.js";
import { createChatRoute } from "./routes/chat.js";
import { createSessionsRoute } from "./routes/sessions.js";
import { createModelsRoute } from "./routes/models.js";
import { createConfigRoute } from "./routes/config.js";
import { createUploadRoute } from "./routes/upload.js";
import { createProvidersRoute } from "./routes/providers.js";
import { createAvatarRoute } from "./routes/avatar.js";
import { createAgentsRoute } from "./routes/agents.js";
import { createDeskRoute } from "./routes/desk.js";
import { createSkillsRoute } from "./routes/skills.js";
import { createChannelsRoute } from "./routes/channels.js";
import { createDmRoute } from "./routes/dm.js";
import { createFsRoute } from "./routes/fs.js";
import { createPreferencesRoute } from "./routes/preferences.js";
import { createBridgeRoute } from "./routes/bridge.js";
import { createAuthRoute } from "./routes/auth.js";
import { createDiaryRoute } from "./routes/diary.js";
import { createConfirmRoute } from "./routes/confirm.js";
import { createPluginsRoute } from "./routes/plugins.js";
import { createCheckpointsRoute } from "./routes/checkpoints.js";
// internal-browser WS is handled directly via raw ws.WebSocketServer in the
// upgrade handler below (WsTransport needs raw ws .on()/.off() methods)
import { ConfirmStore } from "../lib/confirm-store.js";
import { DeferredResultStore } from "../lib/deferred-result-store.js";
import { createDeferredResultExtension } from "../lib/extensions/deferred-result-ext.js";
import { BridgeManager } from "../lib/bridge/bridge-manager.js";
import { Hub } from "../hub/index.js";
import { startCLI } from "./cli.js";
import { fromRoot } from "../shared/hana-root.js";

const productDir = fromRoot("lib");

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
  const pkg = JSON.parse(fs.readFileSync(fromRoot("package.json"), "utf-8"));
  appVersion = pkg.version || "?";
} catch {}

// ── 初始化引擎 ──
console.log("[server] ② 创建 HanaEngine...");
const engine = new HanaEngine({ hanakoHome, productDir });
console.log("[server] ② HanaEngine 构造完成，开始 init...");
await engine.init((msg) => console.log(`[server] ${msg}`));
console.log("[server] ② engine.init 完成");
dlog.log("server", "engine initialized");

// 注入依赖给 BrowserManager（避免循环依赖）
import { BrowserManager } from "../lib/browser/browser-manager.js";
BrowserManager.setHanakoHome(engine.hanakoHome);

if (engine.currentModel) {
  console.log("[server] ③ 创建 session...");
  await engine.createSession();
  console.log("[server] ③ Session created");
  dlog.log("server", `session created, model=${engine.currentModel.name}`);
} else {
  // 诊断信息：区分三种 currentModel=null 的情况，方便用户排查 (#414)
  const availableCount = engine.availableModels?.length ?? 0;
  const chatRef = engine.agent?.config?.models?.chat;
  const chatRefStr = typeof chatRef === "object" ? JSON.stringify(chatRef) : (chatRef || "(empty)");
  let reason;
  if (availableCount === 0) {
    reason = "available models list is empty (no provider has valid api_key + models)";
  } else if (!chatRef) {
    reason = `agent.config.models.chat is empty, but ${availableCount} models are available`;
  } else {
    reason = `models.chat=${chatRefStr} not found in ${availableCount} available models`;
  }
  console.warn(`[server] ⚠ 无可用模型，跳过 session 创建：${reason}`);
  dlog.warn("server", `session creation skipped: ${reason}`);
}

// 写日志头部
dlog.header(appVersion, {
  model: engine.currentModel?.name || "(none)",
  agent: engine.agentName,
  agentId: engine.currentAgentId, // @ui-focus-ok: startup log
  utilityModel: (() => { try { return engine.resolveUtilityConfig?.()?.utility; } catch { return "(none)"; } })(),
  channelsDir: engine.channelsDir,
});

// ── 初始化 Hub（调度中枢，包装 engine） ──
const hub = new Hub({ engine });

// ── 初始化插件系统 ──
await engine.initPlugins(hub.eventBus);

// 启动 Hub 调度器（Scheduler + ChannelRouter）
hub.initSchedulers();

engine.cleanupCheckpoints().catch(err => {
  console.warn("[checkpoint] startup cleanup failed:", err.message);
});

// 加载 i18n
loadLocale(engine.config?.locale);

// ── 启动令牌（阻止本机其他程序随意访问） ──
const SERVER_TOKEN = process.env.HANA_TOKEN || crypto.randomBytes(16).toString("hex");

// ── 创建 Hono 实例 ──
const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// CORS（默认仅允许 localhost，HANA_CORS_ORIGIN 可放宽）+ 鉴权
const corsAllowedOrigin = process.env.HANA_CORS_ORIGIN;
app.use("*", async (c, next) => {
  const origin = c.req.header("origin") || "";
  const isAllowed = corsAllowedOrigin
    ? origin === corsAllowedOrigin
    : /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (origin && isAllowed) {
    c.header("Access-Control-Allow-Origin", origin);
  }
  c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (c.req.method === "OPTIONS") return c.text("", 204);

  // 验证 token（WebSocket 升级请求通过 URL 参数传 token，在 chat.js 中校验）
  const token = c.req.header("authorization")?.replace("Bearer ", "")
    || c.req.query("token");
  if (token !== SERVER_TOKEN) return c.json({ error: "forbidden" }, 403);

  await next();
});

// 全局错误处理
app.onError((err, c) => {
  const appErr = AppError.wrap(err);
  errorBus.report(appErr, {
    context: { method: c.req.method, url: c.req.url },
  });
  return c.json(
    { error: { code: appErr.code, message: appErr.message, traceId: appErr.traceId } },
    appErr.httpStatus
  );
});

// ── 阻塞式确认存储 ──
const confirmStore = new ConfirmStore();
engine.setConfirmStore(confirmStore);

// --- Deferred Result Store ---
const deferredResultStore = new DeferredResultStore(
  hub.eventBus,
  path.join(hanakoHome, ".ephemeral", "deferred-tasks.json"),
);
engine.setDeferredResultStore(deferredResultStore);

// Bus handlers for plugin access
hub.eventBus.handle("deferred:register", ({ taskId, sessionPath, meta }) => {
  if (!sessionPath) return { ok: false, error: "sessionPath is required" };
  deferredResultStore.defer(taskId, sessionPath, meta);
  return { ok: true, sessionPath };
});
hub.eventBus.handle("deferred:resolve", ({ taskId, result, files }) => {
  deferredResultStore.resolve(taskId, result ?? files);
  return { ok: true };
});
hub.eventBus.handle("deferred:fail", ({ taskId, reason, error }) => {
  deferredResultStore.fail(taskId, reason ?? error?.message ?? String(error));
  return { ok: true };
});
hub.eventBus.handle("deferred:query", ({ taskId }) => {
  return deferredResultStore.query(taskId);
});
hub.eventBus.handle("deferred:list-pending", ({ sessionPath }) => {
  return deferredResultStore.listPending(sessionPath);
});
hub.eventBus.handle("deferred:abort", ({ taskId, reason }) => {
  deferredResultStore.abort(taskId, reason);
  return { ok: true };
});

// Task registry bus handlers (plugin access)
hub.eventBus.handle("task:register-handler", ({ type, abort }) => {
  engine.taskRegistry.registerHandler(type, { abort });
  return { ok: true };
});
hub.eventBus.handle("task:unregister-handler", ({ type }) => {
  engine.taskRegistry.unregisterHandler(type);
  return { ok: true };
});
hub.eventBus.handle("task:register", ({ taskId, type, parentSessionPath, meta }) => {
  engine.taskRegistry.register(taskId, { type, parentSessionPath, meta });
  return { ok: true };
});
hub.eventBus.handle("task:remove", ({ taskId }) => {
  engine.taskRegistry.remove(taskId);
  return { ok: true };
});
hub.eventBus.handle("task:abort", ({ taskId }) => {
  return { result: engine.taskRegistry.abort(taskId) };
});
hub.eventBus.handle("session:get-titles", async ({ paths }) => {
  if (!Array.isArray(paths) || !paths.length) return { titles: {} };
  const coord = engine._sessionCoord;
  if (!coord?.getTitlesForPaths) return { titles: {} };
  const titles = await coord.getTitlesForPaths(paths);
  return { titles };
});

// Register Pi SDK extension factory
engine.registerExtensionFactory(createDeferredResultExtension(deferredResultStore));

// ── 外部平台接入管理器 ──
const bridgeManager = new BridgeManager({ engine, hub });
hub.bridgeManager = bridgeManager;

const { restRoute: chatRestRoute, wsRoute: chatWsRoute } = createChatRoute(engine, hub, { upgradeWebSocket });
app.route("/api", chatRestRoute);
app.route("", chatWsRoute);
app.route("/api", createSessionsRoute(engine));
app.route("/api", createModelsRoute(engine));
app.route("/api", createConfigRoute(engine));
app.route("/api", createUploadRoute(engine));
app.route("/api", createProvidersRoute(engine));
app.route("/api", createAvatarRoute(engine));
app.route("/api", createAgentsRoute(engine));
app.route("/api", createDeskRoute(engine, hub));
app.route("/api", createSkillsRoute(engine));
app.route("/api", createChannelsRoute(engine, hub));
app.route("/api", createDmRoute(engine));
app.route("/api", createFsRoute(engine));
app.route("/api", createPreferencesRoute(engine));
app.route("/api", createBridgeRoute(engine, bridgeManager));
app.route("/api", createAuthRoute(engine));
app.route("/api", createDiaryRoute(engine));
app.route("/api", createConfirmRoute(confirmStore, engine));
app.route("/api", createPluginsRoute(engine));
app.route("/api", createCheckpointsRoute(engine));
// internal-browser WS — see unified upgrade handler in server startup below

// 健康检查 + 身份信息
app.get("/api/health", async (c) => {
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
  return c.json({
    status: "ok",
    agent: engine.agentName,
    user: engine.userName,
    model: engine.currentModel?.name,
    avatars,
  });
});

// 前端日志上报（desktop 端把错误 POST 到 server 写进持久化日志）
app.post("/api/log", async (c) => {
  const { level, module, message } = await safeJson(c);
  if (!message) return c.json({ ok: false });
  if (level === "error") dlog.error(module || "desktop", message);
  else if (level === "warn") dlog.warn(module || "desktop", message);
  else dlog.log(module || "desktop", message);
  return c.json({ ok: true });
});

// Plan Mode（只读探索模式）
app.get("/api/plan-mode", async (c) => {
  return c.json({ enabled: engine.planMode });
});
app.post("/api/plan-mode", async (c) => {
  const { enabled } = await safeJson(c);
  engine.setPlanMode(!!enabled);
  return c.json({ ok: true, enabled: engine.planMode });
});

// 远程关闭（供 desktop 端复用 server 退出时调用，跨平台可靠的 graceful shutdown）
app.post("/api/shutdown", async (c) => {
  console.log("[server] 收到 HTTP shutdown 请求，正在清理...");
  // 异步执行，先返回响应
  setTimeout(() => gracefulShutdown(), 100);
  return c.json({ ok: true });
});

// ── 启动服务器 ──
const port = parseInt(process.env.HANA_PORT) || 0; // 0 = OS 分配
const host = "127.0.0.1";

let server;
try {
  server = serve({ fetch: app.fetch, port, hostname: host });

  // @hono/node-server 的 serve() 内部调用 server.listen()，
  // port=0 时需等 listening 事件才能拿到实际端口
  await new Promise((resolve) => {
    if (server.listening) resolve();
    else server.on("listening", resolve);
  });

  // ── Internal browser control WS (raw ws) ──
  // WsTransport requires raw ws .on()/.off() event methods that Hono's WSContext
  // doesn't expose, so we handle /internal/browser via a standalone WebSocketServer.
  //
  // To avoid both handlers firing on the same upgrade request (which would corrupt
  // the socket), we pass injectWebSocket a proxy that filters out /internal/browser
  // upgrades before they reach Hono's handler.
  const browserWss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== "/internal/browser") return; // let Hono handle it

    const token = url.searchParams.get("token");
    if (token !== SERVER_TOKEN) {
      socket.destroy();
      return;
    }
    browserWss.handleUpgrade(req, socket, head, (ws) => {
      browserWss.emit("connection", ws, req);
    });
  });

  browserWss.on("connection", (ws) => {
    const bm = BrowserManager.instance();
    bm.setWsTransport(ws);

    // 调试：记录浏览器 WS 消息往返（异步写入 + 缓冲，仅 HANA_DEBUG=1 时启用）
    const _bwsEnabled = process.env.HANA_DEBUG === "1";
    let _bwsBuf = "";
    let _bwsFlushTimer = null;
    const _bwsLogPath = path.join(hanakoHome, "browser-ws.log");
    let _bwsFlushChain = Promise.resolve();
    const _bwsFlush = () => {
      if (!_bwsBuf) return;
      const chunk = _bwsBuf;
      _bwsBuf = "";
      _bwsFlushTimer = null;
      _bwsFlushChain = _bwsFlushChain.then(() =>
        fs.promises.appendFile(_bwsLogPath, chunk)
      ).catch(() => {});
    };
    const _bwsLog = (line) => {
      if (!_bwsEnabled) return;
      _bwsBuf += `${new Date().toISOString()} ${line}\n`;
      if (!_bwsFlushTimer) _bwsFlushTimer = setTimeout(_bwsFlush, 500);
    };
    _bwsLog("browser WS connected");
    const origSend = ws.send.bind(ws);
    ws.send = function(data, ...args) {
      try { const m = JSON.parse(data); _bwsLog(`→ cmd=${m.cmd || m.type} id=${m.id || "?"}`); } catch {}
      return origSend(data, ...args);
    };
    ws.on("message", (data) => {
      try { const m = JSON.parse(data); _bwsLog(`← type=${m.type} id=${m.id || "?"} error=${m.error || "none"}`); } catch {}
    });

    ws.on("close", () => {
      if (bm._transport?._ws === ws) bm.setWsTransport(null);
      console.log("[server] Electron browser control WS disconnected");
    });
    ws.on("error", (err) => {
      console.error("[server] Electron browser control WS error:", err.message);
      if (bm._transport?._ws === ws) bm.setWsTransport(null);
    });
    console.log("[server] Electron browser control WS connected");
  });

  // Inject Hono WS for chat and other WS routes, but skip /internal/browser
  // to prevent double-handling the same upgrade request
  injectWebSocket({
    on(event, handler) {
      if (event === "upgrade") {
        server.on("upgrade", (req, socket, head) => {
          const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
          if (url.pathname === "/internal/browser") return; // already handled above
          handler(req, socket, head);
        });
      } else {
        server.on(event, handler);
      }
    },
  });

  const address = server.address();
  const actualPort = address.port;

  console.log(`[server] Hanako Server 运行在 http://${host}:${actualPort}`);
  dlog.log("server", `listening on :${actualPort}`);

  // 写 server-info 文件，供 Electron 检测复用或外部工具查询
  const serverInfoPath = path.join(hanakoHome, "server-info.json");
  try {
    fs.writeFileSync(serverInfoPath, JSON.stringify({ pid: process.pid, port: actualPort, token: SERVER_TOKEN, version: appVersion }));
  } catch (e) {
    console.error("[server] 写入 server-info.json 失败:", e.message);
  }

  // 自动启动已配置的外部平台
  bridgeManager.autoStart(engine.agents);
  dlog.log("server", "bridge autoStart done");

  // 通知就绪（server-info.json 已在上方写入，无需额外动作）
  console.log(`[server] ready: port=${actualPort}`);

  // 独立运行模式：启动 CLI（TTY 环境下自动进入交互模式）
  if (process.stdin.isTTY) {
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
    server.close();
    console.log("[server] HTTP server 已关闭");
    dlog.log("server", "HTTP server closed");

    // 2. 挂起浏览器（保留冷保存，重启后可恢复卡片）
    try {
      const { BrowserManager } = await import("../lib/browser/browser-manager.js");
      const bm = BrowserManager.instance();
      for (const sp of bm.runningSessions) {
        await bm.suspendForSession(sp);
        console.log(`[server] 浏览器已挂起: ${sp}`);
      }
    } catch (e) {
      console.error("[server] 浏览器挂起失败:", e.message);
    }

    // 3. 停止外部平台
    bridgeManager.stopAll();
    dlog.log("server", "bridge stopped");

    // 4. flush deferred result store（debounce 可能有未写盘的脏数据）
    engine.deferredResults?.dispose?.();

    // 5. 清理 Hub + 引擎（停 ticker → 等 tick 完成 → 关 DB → 清理 session）
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
