/**
 * Hanako Desktop — Electron 主进程
 *
 * 职责：
 * 1. 创建启动窗口（splash）
 * 2. fork() 启动 Hanako Server
 * 3. 等待 server 就绪 + 主窗口初始化完成
 * 4. 关闭 splash，显示主窗口
 * 5. 优雅关闭
 */
const { app, BrowserWindow, WebContentsView, globalShortcut, ipcMain, dialog, session, shell, nativeTheme, Tray, Menu, nativeImage, systemPreferences, Notification } = require("electron");
const os = require("os");
const path = require("path");
const { fork, execFileSync } = require("child_process");
const fs = require("fs");

// macOS/Linux: Electron 从 Dock/Finder 启动时 PATH 只有系统默认值，
// Homebrew、npm global 等路径全部丢失。用登录 shell 解析完整 PATH。
if (process.platform !== "win32") {
  try {
    const loginShell = process.env.SHELL || "/bin/zsh";
    const resolved = execFileSync(loginShell, ["-l", "-c", "printenv PATH"], {
      timeout: 5000,
      encoding: "utf8",
    }).trim();
    if (resolved) process.env.PATH = resolved;
  } catch {}
}

const hanakoHome = process.env.HANA_HOME
  ? path.resolve(process.env.HANA_HOME.replace(/^~/, os.homedir()))
  : path.join(os.homedir(), ".hanako");

// 按 HANA_HOME 隔离 Electron userData（localStorage / cache / session）
// 生产: ~/Library/Application Support/Hanako
// 开发: ~/Library/Application Support/Hanako-dev
const defaultHome = path.join(os.homedir(), ".hanako");
if (hanakoHome !== defaultHome) {
  const suffix = path.basename(hanakoHome).replace(/^\./, ""); // "hanako-dev"
  const appName = suffix.charAt(0).toUpperCase() + suffix.slice(1); // "Hanako-dev"
  app.setPath("userData", path.join(app.getPath("appData"), appName));
}

let splashWindow = null;
let mainWindow = null;
let onboardingWindow = null;
let devToolsWindow = null;
let settingsWindow = null;
let skillViewerWindow = null;
let browserViewerWindow = null;
let _browserWebView = null;        // 当前活跃的 WebContentsView
const _browserViews = new Map();   // sessionPath → WebContentsView（挂起的浏览器）
let _currentBrowserSession = null; // 当前浏览器绑定的 sessionPath

/** 校验浏览器 URL：仅允许 http/https */
function isAllowedBrowserUrl(url) {
  try {
    const p = new URL(url);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch { return false; }
}
let _browserViewerTheme = "warm-paper"; // 当前主题（用于 backgroundColor）
const TITLEBAR_HEIGHT = 44;        // 浏览器窗口标题栏高度（px）
let serverProcess = null;
let serverPort = null;
let serverToken = null;
let isQuitting = false;  // 区分关窗口（hide）和真正退出（quit）
let tray = null;
let reusedServerPid = null; // 复用已有 server 时记录其 PID，退出时发 SIGTERM
let isExitingServer = false; // 只有托盘"退出"时才 kill server，其余路径仅关前端
let forceQuitApp = false;   // 启动失败等场景需要真正退出，绕过"隐藏保持运行"拦截

/** 跨平台杀进程：Windows 用 taskkill，POSIX 用 signal */
function killPid(pid, force = false) {
  if (process.platform === "win32") {
    try {
      require("child_process").execFileSync("taskkill",
        force ? ["/F", "/T", "/PID", String(pid)] : ["/PID", String(pid)],
        { stdio: "ignore", windowsHide: true });
    } catch {}
  } else {
    try { process.kill(pid, force ? "SIGKILL" : "SIGTERM"); } catch {}
  }
}

/** 跨平台标题栏选项：macOS hiddenInset + 红绿灯，Windows/Linux 无框 */
function titleBarOpts(trafficLight = { x: 16, y: 16 }) {
  if (process.platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: trafficLight };
  }
  // Windows/Linux：无框窗口 + 前端自绘 window controls
  return { frame: false };
}

/**
 * 获取当前 agent ID（不依赖 server）
 * 优先读 user/preferences.json，fallback 扫描 agents/ 第一个有效目录
 */
function getCurrentAgentId() {
  const prefsPath = path.join(hanakoHome, "user", "preferences.json");
  const agentsDir = path.join(hanakoHome, "agents");

  // 1. 读 preferences
  try {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
    if (prefs.primaryAgent) {
      // 确认这个 agent 真的存在（可能已被删除）
      const agentDir = path.join(agentsDir, prefs.primaryAgent);
      if (fs.existsSync(path.join(agentDir, "config.yaml"))) {
        return prefs.primaryAgent;
      }
    }
  } catch {}

  // 2. 扫描 agents/ 目录，返回第一个有效 agent
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && fs.existsSync(path.join(agentsDir, entry.name, "config.yaml"))) {
        return entry.name;
      }
    }
  } catch {}

  // 3. 没有任何 agent（首次启动 first-run 还没跑，或全被删了）
  return null;
}

/**
 * 检查是否已完成首次配置引导
 * 只看 preferences.json 的 setupComplete 标记
 */
function isSetupComplete() {
  const prefsPath = path.join(hanakoHome, "user", "preferences.json");
  try {
    return JSON.parse(fs.readFileSync(prefsPath, "utf-8")).setupComplete === true;
  } catch {}
  return false;
}

/**
 * 检查当前 agent 的 config.yaml 是否已有有效 api_key
 * 用于老用户兼容：有 key 说明配置过了，跳过填写直接看教程
 */
function hasExistingConfig() {
  try {
    const agentId = getCurrentAgentId();
    if (!agentId) return false;
    const configPath = path.join(hanakoHome, "agents", agentId, "config.yaml");
    const configText = fs.readFileSync(configPath, "utf-8");
    return /api_key:\s*["']?[^"'\s]+/.test(configText);
  } catch {}
  return false;
}

// ── 启动 Server ──
// 收集 server 的 stdout/stderr 用于崩溃诊断
let _serverLogs = [];

async function startServer() {
  const serverInfoPath = path.join(hanakoHome, "server-info.json");

  // ── 1. 检查是否有已运行的 server（Electron crash 后遗留的守护进程） ──
  let existingInfo = null;
  try {
    existingInfo = JSON.parse(fs.readFileSync(serverInfoPath, "utf-8"));
  } catch { /* 文件不存在或解析失败，直接 fork */ }

  if (existingInfo) {
    const pidAlive = (() => {
      try { process.kill(existingInfo.pid, 0); return true; } catch { return false; }
    })();

    if (pidAlive) {
      // PID 存活，尝试 health check
      let reused = false;
      try {
        const res = await fetch(`http://127.0.0.1:${existingInfo.port}/api/health`, {
          headers: { Authorization: `Bearer ${existingInfo.token}` },
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          console.log(`[desktop] 复用已运行的 server，端口: ${existingInfo.port}`);
          serverPort = existingInfo.port;
          serverToken = existingInfo.token;
          reusedServerPid = existingInfo.pid;
          reused = true;
        }
      } catch { /* health check 网络抖动，继续 kill 旧 server */ }

      if (reused) return; // 跳过 fork

      // PID 存活但 health 失败（无响应或异常）：主动 kill，避免双 server 并存
      console.log(`[desktop] 旧 server (PID ${existingInfo.pid}) 无响应，正在终止...`);
      killPid(existingInfo.pid);
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try { process.kill(existingInfo.pid, 0); } catch { break; }
        await new Promise(r => setTimeout(r, 100));
      }
      killPid(existingInfo.pid, true);
    }

    // PID 已死或已 kill，删除脏文件
    try { fs.unlinkSync(serverInfoPath); } catch {}
  }

  // ── 2. Fork 新 server ──
  _serverLogs = [];
  // boot.cjs 包装 ESM 入口，捕获 native module 加载失败等错误
  const serverPath = path.join(__dirname, "..", "server", "boot.cjs");

  await new Promise((resolve, reject) => {
    // 用 Electron 自带的 Node.js 跑 server（ELECTRON_RUN_AS_NODE=1 让它以纯 Node 模式运行）
    // native addon（better-sqlite3 等）需要通过 electron-rebuild 编译到对应 ABI
    // detached: true — server 成为独立进程组，Electron crash 后 server 可继续运行
    // Windows: 把内嵌 Git Portable 的 bin 目录注入 PATH，让 PI SDK 的 bash 探测能找到
    const serverEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      HANA_HOME: hanakoHome,
    };
    if (process.platform === "win32") {
      // MinGit-busybox 结构：cmd/git.exe, mingw64/bin/git.exe+sh.exe
      const gitRoot = path.join(process.resourcesPath || "", "git");
      const gitPaths = [
        path.join(gitRoot, "mingw64", "bin"),
        path.join(gitRoot, "cmd"),
      ].filter(p => fs.existsSync(p));
      if (gitPaths.length) {
        // Windows 的 PATH 环境变量 key 可能是 "Path"（title case）或 "PATH"，
        // { ...process.env } 展开后变成普通对象（区分大小写）。
        // 必须找到原始 key 并删除，否则会同时存在 Path 和 PATH 两个 key，
        // 导致 fork 子进程的 PATH 不可预测。
        const pathKey = Object.keys(serverEnv).find(k => k.toLowerCase() === "path") || "PATH";
        const existingPath = serverEnv[pathKey] || "";
        if (pathKey !== "PATH") delete serverEnv[pathKey];
        serverEnv.PATH = gitPaths.join(";") + ";" + existingPath;
      }
    }

    serverProcess = fork(serverPath, [], {
      detached: true,
      windowsHide: true,
      env: serverEnv,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    // 捕获 stdout/stderr 到 buffer（打包后 console 不可见，崩溃时需要这些信息）
    serverProcess.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      try { process.stdout.write(text); } catch {}
      _serverLogs.push(text);
      if (_serverLogs.length > 500) _serverLogs.splice(0, _serverLogs.length - 500);
    });
    serverProcess.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      try { process.stderr.write(text); } catch {}
      _serverLogs.push("[stderr] " + text);
      if (_serverLogs.length > 500) _serverLogs.splice(0, _serverLogs.length - 500);
    });

    const timeout = setTimeout(() => {
      try { serverProcess.kill(); } catch {}
      reject(new Error("Server 启动超时（60s）"));
    }, 60000);

    serverProcess.on("message", (msg) => {
      if (msg?.type === "ready") {
        clearTimeout(timeout);
        serverPort = msg.port;
        serverToken = msg.token;
        serverProcess.unref(); // 脱离 Electron 事件循环，允许 Electron 独立退出
        resolve(msg.port);
      }
    });

    serverProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    serverProcess.on("exit", (code, signal) => {
      if (signal) {
        // 被信号终止（如 SIGSEGV），立即报错而非等 60s 超时
        clearTimeout(timeout);
        reject(new Error(`Server 被信号终止 (${signal})`));
      } else if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(new Error(`Server 退出，code: ${code}`));
      }
    });
  });
}

/**
 * 持久监控 server 进程：崩溃后自动重启一次，再失败则写 crash log 并通知用户
 */
let _serverRestartAttempts = 0;
function monitorServer() {
  if (!serverProcess) return;
  serverProcess.on("exit", async (code, signal) => {
    if (isQuitting) return; // 正常退出流程
    const reason = signal ? `信号 ${signal}` : `退出码 ${code}`;
    console.error(`[desktop] Server 意外退出 (${reason})`);

    if (_serverRestartAttempts < 1) {
      _serverRestartAttempts++;
      console.log("[desktop] 尝试自动重启 Server...");
      try {
        await startServer();
        console.log("[desktop] Server 重启成功");
        monitorServer(); // 重新挂监控
        // 通知前端重连
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("server-restarted", { port: serverPort });
        }
      } catch (err) {
        console.error("[desktop] Server 重启失败:", err.message);
        writeCrashLog(`Server 重启失败: ${err.message}`);
        dialog.showErrorBox("Hanako Server", `Server 崩溃后重启失败。\n${err.message}\n\n请重新启动应用。`);
      }
    } else {
      writeCrashLog(`Server 多次崩溃 (${reason})，放弃重启`);
      dialog.showErrorBox("Hanako Server", `Server 多次崩溃 (${reason})。\n\n请重新启动应用。`);
    }
  });
}

/**
 * 显示主窗口（优先 onboardingWindow，其次 mainWindow）
 */
function showPrimaryWindow() {
  if (process.platform === "darwin") app.dock.show();
  const win = mainWindow || onboardingWindow;
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
}

/**
 * 创建系统托盘图标
 * - 双击：显示主窗口
 * - 右键菜单：显示 Hanako / 设置 / 退出
 */
function createTray() {
  const isDev = hanakoHome !== path.join(os.homedir(), ".hanako");
  let icon;
  if (process.platform === "win32") {
    // Windows 优先用 .ico，缺失则回退到 .png
    const icoName = isDev ? "tray-dev.ico" : "tray.ico";
    const icoPath = path.join(__dirname, "src", "assets", icoName);
    if (fs.existsSync(icoPath)) {
      icon = nativeImage.createFromPath(icoPath);
    } else {
      const pngName = isDev ? "tray-dev-template.png" : "tray-template.png";
      icon = nativeImage.createFromPath(path.join(__dirname, "src", "assets", pngName));
    }
  } else {
    const iconName = isDev ? "tray-dev-template.png" : "tray-template.png";
    const iconPath = path.join(__dirname, "src", "assets", iconName);
    icon = nativeImage.createFromPath(iconPath);
    if (process.platform === "darwin") icon.setTemplateImage(true);
  }
  tray = new Tray(icon);
  tray.setToolTip(isDev ? "Hanako (dev)" : "Hanako");

  const buildMenu = () => Menu.buildFromTemplate([
    { label: "显示 Hanako", click: () => showPrimaryWindow() },
    { label: "设置", click: () => createSettingsWindow() },
    { type: "separator" },
    { label: "退出", click: () => { isExitingServer = true; isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(buildMenu());
  tray.on("right-click", () => tray.setContextMenu(buildMenu()));
  tray.on("double-click", () => showPrimaryWindow());
}

/**
 * 将崩溃日志写入 HANA_HOME/crash.log（默认 ~/.hanako/crash.log）并返回日志内容
 */
function writeCrashLog(errorMessage) {
  const logs = _serverLogs.join("");
  const timestamp = new Date().toISOString();

  // 没有任何输出时，附加诊断信息帮助定位问题
  let diagnostics = "";
  if (!logs) {
    const serverDir = path.join(__dirname, "..", "server");
    const sqlitePath = path.join(__dirname, "..", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
    diagnostics = [
      ``,
      `--- Diagnostics ---`,
      `HANA_HOME: ${hanakoHome}`,
      `Server dir: ${serverDir}`,
      `boot.cjs exists: ${fs.existsSync(path.join(serverDir, "boot.cjs"))}`,
      `index.js exists: ${fs.existsSync(path.join(serverDir, "index.js"))}`,
      `better_sqlite3.node exists: ${fs.existsSync(sqlitePath)}`,
      `ELECTRON_RUN_AS_NODE: ${process.env.ELECTRON_RUN_AS_NODE || "unset"}`,
      `Node ABI: ${process.versions.modules || "unknown"}`,
    ].join("\n");
  }

  const content = [
    `=== Hanako Crash Log ===`,
    `Time: ${timestamp}`,
    `Error: ${errorMessage}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Electron: ${process.versions.electron || "unknown"}`,
    `Node: ${process.versions.node || "unknown"}`,
    ``,
    `--- Server Output ---`,
    logs || "(no output captured)",
    diagnostics,
    ``,
  ].join("\n");

  // 写入文件（best effort）
  try {
    const crashLogPath = path.join(hanakoHome, "crash.log");
    fs.mkdirSync(hanakoHome, { recursive: true });
    fs.writeFileSync(crashLogPath, content, "utf-8");
  } catch (e) {
    console.error("[desktop] 写入 crash.log 失败:", e.message);
  }

  return content;
}

// ── 创建启动窗口 ──
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 380,
    height: 280,
    resizable: false,
    frame: false,
    title: "Hanako",
    ...titleBarOpts({ x: 12, y: 12 }),
    transparent: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  splashWindow.loadFile(path.join(__dirname, "src", "splash.html"));

  splashWindow.once("ready-to-show", () => {
    splashWindow.show();
  });

  splashWindow.on("closed", () => {
    splashWindow = null;
  });
}

// ── 窗口状态记忆 ──
const windowStatePath = path.join(hanakoHome, "user", "window-state.json");

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(windowStatePath, "utf-8"));
  } catch {
    return null;
  }
}

let _saveWindowStateTimer = null;
function saveWindowState() {
  if (_saveWindowStateTimer) clearTimeout(_saveWindowStateTimer);
  _saveWindowStateTimer = setTimeout(() => {
    _saveWindowStateTimer = null;
    if (!mainWindow) return;
    const isMaximized = mainWindow.isMaximized();
    const bounds = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    const state = { ...bounds, isMaximized };
    try {
      fs.writeFileSync(windowStatePath, JSON.stringify(state, null, 2) + "\n");
    } catch (e) {
      console.error("[desktop] 保存窗口状态失败:", e.message);
    }
  }, 500);
}

// ── 创建主窗口 ──
function createMainWindow() {
  const saved = loadWindowState();

  const opts = {
    width: saved?.width || 960,
    height: saved?.height || 820,
    minWidth: 420,
    minHeight: 500,
    title: "Hanako",
    ...titleBarOpts({ x: 16, y: 16 }),
    backgroundColor: "#F4F0E4",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  // 恢复位置（仅当坐标有效时）
  if (saved?.x != null && saved?.y != null) {
    opts.x = saved.x;
    opts.y = saved.y;
  }

  mainWindow = new BrowserWindow(opts);

  if (saved?.isMaximized) {
    mainWindow.maximize();
  }

  // Dev 模式走 Vite dev server，prod 走构建产物，fallback 到源码
  const isDev = process.argv.includes("--dev");
  if (isDev && process.env.VITE_DEV_URL) {
    mainWindow.loadURL(`${process.env.VITE_DEV_URL}/index.html`);
  } else {
    const builtIndex = path.join(__dirname, "dist-renderer", "index.html");
    if (!isDev && fs.existsSync(builtIndex)) {
      mainWindow.loadFile(builtIndex);
    } else {
      mainWindow.loadFile(path.join(__dirname, "src", "index.html"));
    }
  }

  // 前端初始化超时保护：30 秒内没收到 app-ready 就强制显示（防止用户卡在空白）
  const initTimeout = setTimeout(() => {
    console.warn("[desktop] ⚠ 主窗口初始化超时（30s），强制显示");
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 30000);
  mainWindow.webContents.once("did-finish-load", () => {
    // did-finish-load 只是 HTML 加载完成，JS init 可能还在跑
    console.log("[desktop] 主窗口 HTML 加载完成，等待前端 init...");
  });
  mainWindow.once("show", () => clearTimeout(initTimeout));

  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }

  // renderer 崩溃恢复：自动 reload
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[desktop] renderer 崩溃: ${details.reason} (code: ${details.exitCode})`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => {
        try { mainWindow.reload(); } catch {}
      }, 1000);
    }
  });

  mainWindow.on("unresponsive", () => {
    console.warn("[desktop] 主窗口无响应");
  });

  mainWindow.on("responsive", () => {
    console.log("[desktop] 主窗口已恢复响应");
  });

  // 窗口移动/缩放时保存状态
  mainWindow.on("resize", saveWindowState);
  mainWindow.on("move", saveWindowState);

  // 广播最大化状态变化（Windows/Linux 自绘标题栏的最大化/还原按钮需要）
  mainWindow.on("maximize", () => mainWindow.webContents.send("window-maximized"));
  mainWindow.on("unmaximize", () => mainWindow.webContents.send("window-unmaximized"));

  // macOS 风格：点关闭按钮只是隐藏窗口，Dock 保留黑点
  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      // 不调 app.dock.hide()，Dock 上保留图标和黑点
      // 同时隐藏子窗口
      if (devToolsWindow && !devToolsWindow.isDestroyed()) devToolsWindow.hide();
      if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.hide();
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) browserViewerWindow.hide();
      if (skillViewerWindow && !skillViewerWindow.isDestroyed()) skillViewerWindow.hide();
      if (editorWindow && !editorWindow.isDestroyed()) editorWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (devToolsWindow && !devToolsWindow.isDestroyed()) {
      devToolsWindow.destroy();
      devToolsWindow = null;
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.destroy();
      settingsWindow = null;
    }
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      browserViewerWindow.destroy();
      browserViewerWindow = null;
    }
    if (skillViewerWindow && !skillViewerWindow.isDestroyed()) {
      skillViewerWindow.destroy();
      skillViewerWindow = null;
    }
    if (editorWindow && !editorWindow.isDestroyed()) {
      editorWindow.destroy();
      editorWindow = null;
    }
  });
}

// ── 创建 DevTools 窗口 ──
function createDevToolsWindow() {
  if (devToolsWindow) {
    devToolsWindow.show();
    devToolsWindow.focus();
    return;
  }

  devToolsWindow = new BrowserWindow({
    width: 380,
    height: 520,
    minWidth: 300,
    minHeight: 400,
    title: "Hanako DevTools",
    ...titleBarOpts({ x: 12, y: 12 }),
    backgroundColor: "#F4F0E4",
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  devToolsWindow.loadFile(path.join(__dirname, "src", "devtools.html"));

  devToolsWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      devToolsWindow.hide();
    }
  });

  devToolsWindow.on("closed", () => {
    devToolsWindow = null;
  });
}

const THEME_BG = {
  "warm-paper":   "#F8F5ED",
  "midnight":     "#2D4356",
  "high-contrast":"#FAF9F6",
  "grass-aroma":  "#F5F8F3",
  "contemplation":"#F3F5F7",
};

// ── 创建设置窗口 ──
function createSettingsWindow(tab, theme) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (tab) settingsWindow.webContents.send("settings-switch-tab", tab);
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 720,
    height: 700,
    minWidth: 720,
    maxWidth: 720,
    minHeight: 500,
    title: "Settings",
    ...titleBarOpts({ x: 16, y: 14 }),
    backgroundColor: THEME_BG[theme || _browserViewerTheme] || THEME_BG["warm-paper"],
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Dev 模式走 Vite dev server，prod 走构建产物，fallback 到源码
  const isDev = process.argv.includes("--dev");
  if (isDev && process.env.VITE_DEV_URL) {
    settingsWindow.loadURL(`${process.env.VITE_DEV_URL}/settings.html`);
  } else {
    const builtSettings = path.join(__dirname, "dist-renderer", "settings.html");
    if (!isDev && fs.existsSync(builtSettings)) {
      settingsWindow.loadFile(builtSettings);
    } else {
      settingsWindow.loadFile(path.join(__dirname, "src", "settings.html"));
    }
  }

  // 窗口加载完后切换到指定 tab
  if (tab) {
    settingsWindow.webContents.once("did-finish-load", () => {
      settingsWindow.webContents.send("settings-switch-tab", tab);
    });
  }

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

// ── 创建 Skill 预览窗口 ──
function createSkillViewerWindow(skillInfo) {
  if (skillViewerWindow && !skillViewerWindow.isDestroyed()) {
    // 复用已有窗口，传递新 skill 数据
    skillViewerWindow.webContents.send("skill-viewer-load", skillInfo);
    skillViewerWindow.show();
    skillViewerWindow.focus();
    return;
  }

  skillViewerWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 600,
    minHeight: 400,
    title: skillInfo.name || "Skill Preview",
    frame: false,
    backgroundColor: "#F4F0E4",
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  skillViewerWindow.loadFile(path.join(__dirname, "src", "skill-viewer.html"));

  // 页面加载完成后发送 skill 数据
  skillViewerWindow.webContents.once("did-finish-load", () => {
    if (skillViewerWindow && !skillViewerWindow.isDestroyed()) {
      skillViewerWindow.webContents.send("skill-viewer-load", skillInfo);
    }
  });

  skillViewerWindow.on("closed", () => {
    skillViewerWindow = null;
  });
}

/** 递归扫描目录，返回文件树 */
function scanSkillDir(dir, rootDir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith("."))
    .sort((a, b) => {
      // 目录排前面，SKILL.md 排最前
      if (a.name === "SKILL.md") return -1;
      if (b.name === "SKILL.md") return 1;
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  return entries.map(e => {
    const fullPath = path.join(dir, e.name);
    if (e.isDirectory()) {
      return { name: e.name, path: fullPath, isDir: true, children: scanSkillDir(fullPath, rootDir) };
    }
    return { name: e.name, path: fullPath, isDir: false };
  });
}

// ── 创建浏览器查看器窗口（嵌入式 BrowserView） ──
// opts.show: 是否立刻显示（默认 true），resume 时传 false
function createBrowserViewerWindow(opts = {}) {
  const shouldShow = opts.show !== false;
  if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
    if (shouldShow) {
      browserViewerWindow.show();
      browserViewerWindow.focus();
      // 窗口从隐藏变为可见时重算 bounds（隐藏窗口的 getContentSize 可能不准确）
      _updateBrowserViewBounds();
      // 窗口复用时也要 focus WebContentsView，否则滚动/键盘不工作
      if (_browserWebView) {
        setTimeout(() => {
          if (_browserWebView) _browserWebView.webContents.focus();
        }, 50);
      }
    }
    return;
  }

  browserViewerWindow = new BrowserWindow({
    width: 1200,
    height: 1080,
    minWidth: 480,
    minHeight: 360,
    title: "Browser",
    frame: false,
    backgroundColor: THEME_BG[_browserViewerTheme] || THEME_BG["warm-paper"],
    hasShadow: true,
    show: shouldShow,
    acceptFirstMouse: true, // macOS: 第一次点击不仅激活窗口，还穿透到内容
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  browserViewerWindow.loadFile(path.join(__dirname, "src", "browser-viewer.html"));

  // HTML 加载完成后，若浏览器已在运行则附加 WebContentsView
  browserViewerWindow.webContents.on("did-finish-load", () => {
    if (_browserWebView && browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      // 避免重复添加：先移除再添加，确保在最顶层
      try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
      browserViewerWindow.contentView.addChildView(_browserWebView);
      _updateBrowserViewBounds();
      const url = _browserWebView.webContents.getURL();
      if (url) _notifyViewerUrl(url);
      console.log("[browser-viewer] did-finish-load: view 已挂载, bounds:", _browserWebView.getBounds());
      // 延迟 focus，等 layout 稳定
      setTimeout(() => {
        if (_browserWebView) {
          _browserWebView.webContents.focus();
          console.log("[browser-viewer] delayed focus applied, isFocused:", _browserWebView.webContents.isFocused());
        }
      }, 200);
    }
  });

  browserViewerWindow.on("resize", () => _updateBrowserViewBounds());
  // 窗口从隐藏变为可见时重算 bounds（Windows 隐藏窗口的 getContentSize 可能返回错误值）
  browserViewerWindow.on("show", () => _updateBrowserViewBounds());

  // 窗口获得焦点时，将输入焦点转发到 WebContentsView（否则无法滚动/打字）
  browserViewerWindow.on("focus", () => {
    if (_browserWebView) {
      _browserWebView.webContents.focus();
      console.log("[browser-viewer] window focus → view.focus(), isFocused:", _browserWebView.webContents.isFocused());
    }
  });

  // 浏览器运行时只隐藏不关闭
  browserViewerWindow.on("close", (e) => {
    if (!isQuitting && _browserWebView) {
      e.preventDefault();
      browserViewerWindow.hide();
    }
  });

  browserViewerWindow.on("closed", () => {
    browserViewerWindow = null;
  });
}

// ══════════════════════════════════════════
//  嵌入式浏览器控制
//  Server 进程通过 IPC 发送 browser-cmd，
//  主进程在 WebContentsView 上执行操作
// ══════════════════════════════════════════

// DOM 遍历脚本：生成页面快照（类似 AXTree）
const SNAPSHOT_SCRIPT = `(function() {
  var ref = 0;
  document.querySelectorAll('[data-hana-ref]').forEach(function(el) {
    el.removeAttribute('data-hana-ref');
  });

  function isVisible(el) {
    if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') return false;
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }

  function isInteractive(el) {
    var t = el.tagName;
    if (['A','BUTTON','INPUT','TEXTAREA','SELECT','DETAILS','SUMMARY'].indexOf(t) !== -1) return true;
    var r = el.getAttribute('role');
    if (r && ['button','link','menuitem','tab','checkbox','radio','textbox','combobox','listbox','option','switch','slider','treeitem'].indexOf(r) !== -1) return true;
    if (el.onclick || el.hasAttribute('onclick')) return true;
    if (el.contentEditable === 'true') return true;
    if (el.tabIndex > 0) return true;
    try { if (window.getComputedStyle(el).cursor === 'pointer' && !el.closest('a,button')) return true; } catch(e) {}
    return false;
  }

  function directText(el) {
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].textContent;
    }
    return t.trim().replace(/\\s+/g, ' ').slice(0, 80);
  }

  function walk(el, depth) {
    if (el.nodeType !== 1) return '';
    if (!isVisible(el)) return '';
    var tag = el.tagName;
    if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG'].indexOf(tag) !== -1) return '';

    var out = '';
    var pad = '';
    for (var i = 0; i < depth; i++) pad += '  ';

    var interactive = isInteractive(el);
    if (interactive) {
      ref++;
      el.setAttribute('data-hana-ref', String(ref));
      var role = el.getAttribute('role') || tag.toLowerCase();
      var name = el.getAttribute('aria-label') || el.title || el.placeholder || directText(el) || el.value || '';
      var label = name.slice(0, 60);

      var flags = [];
      if (el.type && el.type !== 'submit' && tag === 'INPUT') flags.push(el.type);
      if (tag === 'INPUT' && el.value) flags.push('value="' + el.value.slice(0,30) + '"');
      if (el.checked) flags.push('checked');
      if (el.disabled) flags.push('disabled');
      if (el.getAttribute('aria-selected') === 'true') flags.push('selected');
      if (el.getAttribute('aria-expanded')) flags.push('expanded=' + el.getAttribute('aria-expanded'));
      if (tag === 'A' && el.href) flags.push('href="' + el.href.slice(0,80) + '"');

      var extra = flags.length ? ' (' + flags.join(', ') + ')' : '';
      out += pad + '[' + ref + '] ' + role + ' "' + label + '"' + extra + '\\n';
    } else if (/^H[1-6]/.test(tag)) {
      var hText = directText(el);
      if (hText) out += pad + tag.toLowerCase() + ': ' + hText + '\\n';
    } else if (tag === 'IMG') {
      out += pad + 'img "' + (el.alt || '').slice(0,40) + '"\\n';
    } else if (['P','SPAN','DIV','LI','TD','TH','LABEL'].indexOf(tag) !== -1) {
      var txt = directText(el);
      if (txt && txt.length > 2 && !el.querySelector('a,button,input,textarea,select,[role]')) {
        out += pad + 'text: ' + txt + '\\n';
      }
    }

    for (var j = 0; j < el.children.length; j++) {
      out += walk(el.children[j], interactive ? depth + 1 : depth);
    }

    return out;
  }

  var tree = walk(document.body, 0);
  return {
    title: document.title,
    currentUrl: location.href,
    text: 'Page: ' + document.title + '\\nURL: ' + location.href + '\\n\\n' + tree
  };
})()`;

function _ensureBrowser() {
  if (!_browserWebView) throw new Error("Browser not launched. Call start first.");
}

function _delay(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function _updateBrowserViewBounds() {
  if (!_browserWebView || !browserViewerWindow || browserViewerWindow.isDestroyed()) return;
  const [width, height] = browserViewerWindow.getContentSize();
  // 卡片式布局：四周留边距
  const mx = 8, mt = 4, mb = 8;
  const bounds = {
    x: mx,
    y: TITLEBAR_HEIGHT + mt,
    width: Math.max(0, width - mx * 2),
    height: Math.max(0, height - TITLEBAR_HEIGHT - mt - mb),
  };
  if (bounds.width === 0 || bounds.height === 0) {
    console.warn("[browser] bounds 计算为零:", { contentSize: [width, height], bounds, visible: browserViewerWindow.isVisible() });
  }
  _browserWebView.setBounds(bounds);
}

function _notifyViewerUrl(url) {
  if (browserViewerWindow && !browserViewerWindow.isDestroyed() && _browserWebView) {
    browserViewerWindow.webContents.send("browser-update", {
      url,
      title: _browserWebView.webContents.getTitle(),
      canGoBack: _browserWebView.webContents.canGoBack(),
      canGoForward: _browserWebView.webContents.canGoForward(),
    });
  }
}

async function handleBrowserCommand(cmd, params) {
  switch (cmd) {

    // ── launch ──
    case "launch": {
      if (_browserWebView) return {};
      const ses = session.fromPartition("persist:hana-browser");
      const view = new WebContentsView({
        webPreferences: {
          session: ses,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });

      // 监听导航事件，实时更新 URL 栏
      view.webContents.on("did-navigate", (_e, url) => _notifyViewerUrl(url));
      view.webContents.on("did-navigate-in-page", (_e, url) => _notifyViewerUrl(url));

      // 在新窗口中打开链接（target=_blank）时，在当前视图中打开
      view.webContents.setWindowOpenHandler(({ url }) => {
        if (isAllowedBrowserUrl(url)) {
          view.webContents.loadURL(url);
        }
        return { action: "deny" };
      });

      // 页面标题变化时更新标题栏
      view.webContents.on("page-title-updated", () => {
        _notifyViewerUrl(view.webContents.getURL());
      });

      // 卡片圆角
      view.setBorderRadius(10);

      // 绑定到 session
      _browserWebView = view;
      _currentBrowserSession = params.sessionPath || null;
      if (_currentBrowserSession) {
        _browserViews.set(_currentBrowserSession, view);
      }

      // 始终静默创建窗口（不弹出），等用户手动点击才 show
      createBrowserViewerWindow({ show: false });
      // 如果 HTML 已加载完毕（窗口复用），did-finish-load 不会再触发，手动挂载
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
        browserViewerWindow.contentView.addChildView(_browserWebView);
        _updateBrowserViewBounds();
        console.log("[browser] launch: view 已挂载 (silent), bounds:", _browserWebView.getBounds());
        setTimeout(() => {
          if (_browserWebView) {
            _browserWebView.webContents.focus();
          }
        }, 300);
      }
      return {};
    }

    // ── close ──（真正销毁当前浏览器实例）
    case "close": {
      if (_browserWebView) {
        if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
        }
        _browserWebView.webContents.close();
        // 从 Map 中移除
        if (_currentBrowserSession) {
          _browserViews.delete(_currentBrowserSession);
        }
        _browserWebView = null;
        _currentBrowserSession = null;
      }
      // 通知浮窗状态变化，但不自动隐藏（让用户自己决定关不关）
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        browserViewerWindow.webContents.send("browser-update", { running: false });
      }
      return {};
    }

    // ── suspend ──（从窗口摘下来，但不销毁，页面状态完全保留）
    case "suspend": {
      if (_browserWebView) {
        if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
        }
        // view 留在 _browserViews Map 里，不 close
        _browserWebView = null;
        _currentBrowserSession = null;
      }
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        browserViewerWindow.webContents.send("browser-update", { running: false });
      }
      return {};
    }

    // ── resume ──（把挂起的 view 挂回窗口，但不自动弹出）
    case "resume": {
      const sp = params.sessionPath;
      if (!sp || !_browserViews.has(sp)) {
        return { found: false };
      }
      const view = _browserViews.get(sp);
      _browserWebView = view;
      _currentBrowserSession = sp;

      // 挂载 view 到窗口（不 show，等用户手动打开）
      createBrowserViewerWindow({ show: false });
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        browserViewerWindow.contentView.addChildView(view);
        _updateBrowserViewBounds();
        // 恢复输入焦点（否则无法滚动/交互）
        view.webContents.focus();
      }
      // 通知标题栏更新
      const url = view.webContents.getURL();
      if (url) _notifyViewerUrl(url);
      return { found: true, url };
    }

    // ── navigate ──
    case "navigate": {
      if (!isAllowedBrowserUrl(params.url)) {
        throw new Error("Only http/https URLs are allowed");
      }
      _ensureBrowser();
      const wc = _browserWebView.webContents;
      await wc.loadURL(params.url);
      await _delay(500);
      const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
      return { url: snap.currentUrl, title: snap.title, snapshot: snap.text };
    }

    // ── snapshot ──
    case "snapshot": {
      _ensureBrowser();
      const snap = await _browserWebView.webContents.executeJavaScript(SNAPSHOT_SCRIPT);
      return { currentUrl: snap.currentUrl, text: snap.text };
    }

    // ── screenshot ──
    case "screenshot": {
      _ensureBrowser();
      const img = await _browserWebView.webContents.capturePage();
      const jpeg = img.toJPEG(75);
      return { base64: jpeg.toString("base64") };
    }

    // ── thumbnail ──
    case "thumbnail": {
      _ensureBrowser();
      const img = await _browserWebView.webContents.capturePage();
      const resized = img.resize({ width: 400 });
      const jpeg = resized.toJPEG(60);
      return { base64: jpeg.toString("base64") };
    }

    // ── click ──
    case "click": {
      _ensureBrowser();
      const wc = _browserWebView.webContents;
      const clickRef = Number(params.ref);
      await wc.executeJavaScript(
        "(function(){ var el = document.querySelector('[data-hana-ref=\"" + clickRef + "\"]');" +
        " if (!el) throw new Error('Element [" + clickRef + "] not found');" +
        " el.scrollIntoView({block:'center'}); el.click(); })()"
      );
      await _delay(800);
      const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
      return { currentUrl: snap.currentUrl, text: snap.text };
    }

    // ── type ──
    case "type": {
      _ensureBrowser();
      const wc = _browserWebView.webContents;
      if (params.ref != null) {
        const typeRef = Number(params.ref);
        await wc.executeJavaScript(
          "(function(){ var el = document.querySelector('[data-hana-ref=\"" + typeRef + "\"]');" +
          " if (!el) throw new Error('Element [" + typeRef + "] not found');" +
          " el.scrollIntoView({block:'center'}); el.focus();" +
          " if (el.select) el.select(); })()"
        );
        await _delay(100);
      }
      await wc.insertText(params.text);
      if (params.pressEnter) {
        await _delay(100);
        wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
        wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });
        await _delay(800);
      }
      await _delay(300);
      const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
      return { currentUrl: snap.currentUrl, text: snap.text };
    }

    // ── scroll ──
    case "scroll": {
      _ensureBrowser();
      const wc = _browserWebView.webContents;
      const delta = (params.direction === "up" ? -1 : 1) * (params.amount || 3) * 300;
      await wc.executeJavaScript("window.scrollBy({top:" + delta + ",behavior:'smooth'})");
      await _delay(500);
      const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
      return { text: snap.text };
    }

    // ── select ──
    case "select": {
      _ensureBrowser();
      const wc = _browserWebView.webContents;
      const selRef = Number(params.ref);
      const safeValue = JSON.stringify(params.value);
      await wc.executeJavaScript(
        "(function(){ var el = document.querySelector('[data-hana-ref=\"" + selRef + "\"]');" +
        " if (!el) throw new Error('Element [" + selRef + "] not found');" +
        " el.value = " + safeValue + ";" +
        " el.dispatchEvent(new Event('change',{bubbles:true})); })()"
      );
      await _delay(300);
      const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
      return { text: snap.text };
    }

    // ── pressKey ──
    case "pressKey": {
      _ensureBrowser();
      const wc = _browserWebView.webContents;
      const parts = params.key.split("+");
      const keyCode = parts[parts.length - 1];
      const modifiers = parts.slice(0, -1).map(function(m) { return m.toLowerCase(); });
      const keyMap = { Enter: "Return", Escape: "Escape", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Space: "Space" };
      const mappedKey = keyMap[keyCode] || keyCode;
      wc.sendInputEvent({ type: "keyDown", keyCode: mappedKey, modifiers });
      wc.sendInputEvent({ type: "keyUp", keyCode: mappedKey, modifiers });
      await _delay(300);
      const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
      return { text: snap.text };
    }

    // ── wait ──
    case "wait": {
      _ensureBrowser();
      const timeout = Math.min(params.timeout || 5000, 10000);
      await _delay(timeout);
      const snap = await _browserWebView.webContents.executeJavaScript(SNAPSHOT_SCRIPT);
      return { text: snap.text };
    }

    // ── evaluate ──
    case "evaluate": {
      if (!params.expression || params.expression.length > 10000) {
        throw new Error("Expression too long (max 10000 chars)");
      }
      console.log(`[browser:evaluate] ${params.expression.slice(0, 200)}${params.expression.length > 200 ? "..." : ""}`);
      _ensureBrowser();
      const result = await _browserWebView.webContents.executeJavaScript(params.expression);
      const serialized = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { value: serialized || "undefined" };
    }

    // ── show ──
    case "show": {
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        browserViewerWindow.show();
        browserViewerWindow.focus();
        // 延迟 focus：等窗口完全显示后再转移焦点到 WebContentsView
        if (_browserWebView) {
          _browserWebView.webContents.focus();
          setTimeout(() => {
            if (_browserWebView) _browserWebView.webContents.focus();
          }, 100);
        }
      } else if (_browserWebView) {
        createBrowserViewerWindow();
      }
      return {};
    }

    // ── destroyView ──（销毁指定 session 的挂起 view）
    case "destroyView": {
      const sp = params.sessionPath;
      if (sp && _browserViews.has(sp)) {
        const view = _browserViews.get(sp);
        if (view === _browserWebView) {
          if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
            try { browserViewerWindow.contentView.removeChildView(view); } catch {}
          }
          _browserWebView = null;
          _currentBrowserSession = null;
          if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
            browserViewerWindow.webContents.send("browser-update", { running: false });
            browserViewerWindow.hide();
          }
        }
        view.webContents.close();
        _browserViews.delete(sp);
      }
      return {};
    }

    default:
      throw new Error("Unknown browser command: " + cmd);
  }
}

/** 监听 server 进程的浏览器命令 */
function setupBrowserCommands() {
  if (!serverProcess) return;
  serverProcess.on("message", async (msg) => {
    if (msg?.type !== "browser-cmd") return;
    const { id, cmd, params } = msg;
    try {
      const result = await handleBrowserCommand(cmd, params || {});
      if (serverProcess && !serverProcess.killed) {
        serverProcess.send({ type: "browser-result", id, result });
      }
    } catch (err) {
      if (serverProcess && !serverProcess.killed) {
        serverProcess.send({ type: "browser-result", id, error: err.message });
      }
    }
  });
}

// ── 创建 Onboarding 窗口 ──
// query: 可选的 URL 参数，如 { skipToTutorial: "1" } 或 { preview: "1" }
function createOnboardingWindow(query = {}) {
  onboardingWindow = new BrowserWindow({
    width: 560,
    height: 780,
    resizable: false,
    frame: false,
    title: "Hanako",
    ...titleBarOpts({ x: 16, y: 16 }),
    backgroundColor: "#F4F0E4",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  onboardingWindow.loadFile(path.join(__dirname, "src", "onboarding.html"), { query });

  onboardingWindow.once("ready-to-show", () => {
    // 关闭 splash，显示 onboarding
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    onboardingWindow.show();
  });

  onboardingWindow.on("closed", () => {
    onboardingWindow = null;
  });
}

// ── 更新检查 ──
let _updateInfo = null;

async function checkForUpdates() {
  try {
    const res = await fetch("https://api.github.com/repos/liliMozi/openhanako/releases/latest", {
      headers: { "User-Agent": "Hanako" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    const data = await res.json();
    const latest = (data.tag_name || "").replace(/^v/, "");
    const current = app.getVersion();
    if (!latest || !isNewerVersion(latest, current)) return;
    const ext = process.platform === "win32" ? ".exe" : ".dmg";
    _updateInfo = {
      version: latest,
      url: data.html_url,
      downloadUrl: (data.assets || []).find(a => a.name?.endsWith(ext))?.browser_download_url || data.html_url,
    };
    console.log(`[desktop] 发现新版本: v${latest}（当前 v${current}）`);
  } catch {}
}

function isNewerVersion(latest, current) {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

// ── IPC ──
ipcMain.handle("get-server-port", () => serverPort);
ipcMain.handle("get-server-token", () => serverToken);
ipcMain.handle("get-app-version", () => app.getVersion());
ipcMain.handle("check-update", () => _updateInfo);

ipcMain.handle("open-settings", (_event, tab, theme) => createSettingsWindow(tab, theme));

// 浏览器查看器窗口
ipcMain.handle("open-browser-viewer", (_event, theme) => {
  if (theme) _browserViewerTheme = theme;
  createBrowserViewerWindow();
});
ipcMain.handle("browser-go-back", () => { if (_browserWebView) _browserWebView.webContents.goBack(); });
ipcMain.handle("browser-go-forward", () => { if (_browserWebView) _browserWebView.webContents.goForward(); });
ipcMain.handle("browser-reload", () => { if (_browserWebView) _browserWebView.webContents.reload(); });
ipcMain.handle("close-browser-viewer", () => {
  if (browserViewerWindow && !browserViewerWindow.isDestroyed()) browserViewerWindow.close();
});
ipcMain.handle("browser-emergency-stop", () => {
  // 紧急停止：销毁当前浏览器实例，释放 AI 控制
  if (_browserWebView) {
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
    }
    _browserWebView.webContents.close();
    if (_currentBrowserSession) {
      _browserViews.delete(_currentBrowserSession);
    }
    _browserWebView = null;
    _currentBrowserSession = null;
  }
  if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
    browserViewerWindow.webContents.send("browser-update", { running: false });
  }
});

// ── 编辑器独立窗口 ──
let editorWindow = null;
let _editorFileData = null; // { filePath, title, type, language }

ipcMain.handle("open-editor-window", (_event, data) => {
  _editorFileData = data;
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.show();
    editorWindow.focus();
    editorWindow.webContents.send("editor-load", data);
    return;
  }

  const isDark = nativeTheme.shouldUseDarkColors;
  const theme = isDark ? "midnight" : "warm-paper";

  editorWindow = new BrowserWindow({
    width: 720,
    height: 800,
    minWidth: 400,
    minHeight: 300,
    title: data.title || "Editor",
    frame: false,
    backgroundColor: THEME_BG[theme] || THEME_BG["warm-paper"],
    hasShadow: true,
    show: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Dev 模式优先走 Vite dev server；否则优先走构建产物，最后回退到无 bundler 的 legacy 页面
  const isDev = process.argv.includes("--dev");
  const builtEditor = path.join(__dirname, "dist-renderer", "editor-window.html");
  const fallbackEditor = path.join(__dirname, "src", "editor-window-fallback.html");
  if (isDev && process.env.VITE_DEV_URL) {
    editorWindow.loadURL(`${process.env.VITE_DEV_URL}/editor-window.html`);
  } else if (!isDev && fs.existsSync(builtEditor)) {
    editorWindow.loadFile(builtEditor);
  } else {
    editorWindow.loadFile(fallbackEditor);
  }

  editorWindow.webContents.on("did-finish-load", () => {
    if (_editorFileData && editorWindow && !editorWindow.isDestroyed()) {
      editorWindow.webContents.send("editor-load", _editorFileData);
    }
  });

  editorWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      editorWindow.hide();
      // 通知主窗口 editor 已关闭
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("editor-detached", false);
      }
    }
  });

  editorWindow.on("closed", () => {
    editorWindow = null;
    _editorFileData = null;
    // 清理编辑器窗口关联的文件监听
    for (const [, watcher] of _fileWatchers) watcher.close();
    _fileWatchers.clear();
  });
});

ipcMain.handle("editor-dock", () => {
  // 放回主面板：通知主窗口重新打开 preview，然后隐藏编辑器窗口
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("editor-detached", false);
    if (_editorFileData) {
      mainWindow.webContents.send("editor-dock-file", _editorFileData);
    }
  }
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.hide();
  }
});

ipcMain.handle("editor-close", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("editor-detached", false);
  }
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.hide();
  }
});

// 设置窗口 → 主窗口的消息转发
ipcMain.on("settings-changed", (_event, type, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("settings-changed", type, data);
  }
  if (type === "theme-changed" && data?.theme) {
    const name = data.theme;
    _browserViewerTheme = name === "auto"
      ? (nativeTheme.shouldUseDarkColors ? "midnight" : "warm-paper")
      : name;
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      browserViewerWindow.webContents.send("settings-changed", type, data);
    }
  }
});

// 获取头像本地路径（splash 用，不依赖 server）
ipcMain.handle("get-avatar-path", (_event, role) => {
  if (role !== "agent" && role !== "user") return null;
  const agentId = getCurrentAgentId();
  // agent 头像在 agents/{id}/avatars/，user 头像在 user/avatars/
  const baseDir = role === "user"
    ? path.join(hanakoHome, "user")
    : agentId ? path.join(hanakoHome, "agents", agentId) : null;
  if (!baseDir) return null;
  const avatarDir = path.join(baseDir, "avatars");
  for (const ext of ["png", "jpg", "jpeg", "webp"]) {
    const p = path.join(avatarDir, `${role}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
});

// 读取 config.yaml 基本信息（splash 用，不依赖 server）
ipcMain.handle("get-splash-info", () => {
  try {
    const agentId = getCurrentAgentId();
    if (!agentId) return { agentName: null, locale: "zh-CN", yuan: "hanako" };
    const configPath = path.join(hanakoHome, "agents", agentId, "config.yaml");
    const text = fs.readFileSync(configPath, "utf-8");
    // 简易提取：agent:\n  name: xxx / yuan: xxx 和顶层 locale: xxx
    const agentMatch = text.match(/^agent:\s*\n\s+name:\s*([^#\n]+)/m);
    const localeMatch = text.match(/^locale:\s*(.+)/m);
    const yuanMatch = text.match(/^\s+yuan:\s*([^#\n]+)/m);
    return {
      agentName: agentMatch?.[1]?.trim() || null,
      locale: localeMatch?.[1]?.trim() || null,
      yuan: yuanMatch?.[1]?.trim() || "hanako",
    };
  } catch {
    return { agentName: null, locale: "zh-CN", yuan: "hanako" };
  }
});

// 选择文件夹（系统原生对话框）
ipcMain.handle("select-folder", async (event) => {
  // 找到发起请求的窗口
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openDirectory"],
    title: "选择工作文件夹",
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// 选择技能文件/文件夹（支持 .zip / .skill / 文件夹）
ipcMain.handle("select-skill", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile", "openDirectory"],
    title: "选择技能",
    filters: [
      { name: "Skill", extensions: ["zip", "skill"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ── Skill 预览窗口 IPC ──
ipcMain.handle("open-skill-viewer", (_event, data) => {
  if (!data) return;

  // .skill / .zip 文件 → 优先查找已安装目录，否则解压临时目录
  if (data.skillPath && path.isAbsolute(data.skillPath)) {
    const fileExt = path.extname(data.skillPath).toLowerCase();
    if (fileExt === ".skill" || fileExt === ".zip") {
      const baseName = path.basename(data.skillPath, fileExt);

      // 先检查同名 skill 是否已安装在 skills 目录
      const installedDir = path.join(hanakoHome, "skills", baseName);
      if (fs.existsSync(path.join(installedDir, "SKILL.md"))) {
        createSkillViewerWindow({ name: baseName, baseDir: installedDir, installed: false });
        return;
      }

      // 否则解压 .skill 文件
      if (!fs.existsSync(data.skillPath)) {
        console.warn("[skill-viewer] .skill file not found:", data.skillPath);
        return;
      }
      try {
        const { execFileSync } = require("child_process");
        const tmpDir = path.join(app.getPath("temp"), "hana-skill-preview-" + Date.now());
        fs.mkdirSync(tmpDir, { recursive: true });
        if (process.platform === "win32") {
          execFileSync("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-Command",
            `Expand-Archive -Path '${data.skillPath.replace(/'/g, "''")}' -DestinationPath '${tmpDir.replace(/'/g, "''")}' -Force`,
          ], { stdio: "ignore", windowsHide: true });
        } else {
          execFileSync("unzip", ["-o", "-q", data.skillPath, "-d", tmpDir]);
        }

        let skillDir = null;
        if (fs.existsSync(path.join(tmpDir, "SKILL.md"))) {
          skillDir = tmpDir;
        } else {
          const sub = fs.readdirSync(tmpDir, { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.name.startsWith("."));
          const found = sub.find(e => fs.existsSync(path.join(tmpDir, e.name, "SKILL.md")));
          if (found) skillDir = path.join(tmpDir, found.name);
        }
        if (!skillDir) return;

        const content = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
        const nameMatch = fmMatch?.[1]?.match(/^name:\s*(.+)$/m);
        const name = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : baseName;

        createSkillViewerWindow({ name, baseDir: skillDir, installed: false });
      } catch (err) {
        console.error("[skill-viewer] Failed to extract .skill file:", err.message);
      }
      return;
    }
  }

  if (!data.baseDir || !path.isAbsolute(data.baseDir)) return;
  createSkillViewerWindow(data);
});

ipcMain.handle("skill-viewer-list-files", (_event, baseDir) => {
  if (!baseDir || !path.isAbsolute(baseDir)) return [];
  try {
    if (!fs.statSync(baseDir).isDirectory()) return [];
    return scanSkillDir(baseDir, baseDir);
  } catch {
    return [];
  }
});

ipcMain.handle("skill-viewer-read-file", (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  // 安全检查：只允许读取文本文件，限制大小
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null; // 2MB 限制
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
});

ipcMain.handle("close-skill-viewer", () => {
  if (skillViewerWindow && !skillViewerWindow.isDestroyed()) {
    skillViewerWindow.close();
  }
});

// 在系统文件管理器中打开文件夹（限制为目录且为绝对路径）
ipcMain.handle("open-folder", (_event, folderPath) => {
  if (!folderPath || !path.isAbsolute(folderPath)) return;
  try {
    if (!fs.statSync(folderPath).isDirectory()) return;
  } catch { return; }
  shell.openPath(folderPath);
});

// 原生拖拽：书桌文件拖到 Finder / 聊天区
ipcMain.on("start-drag", async (event, filePaths) => {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  let icon;
  try {
    icon = await app.getFileIcon(paths[0], { size: "small" });
  } catch {
    // macOS 要求 icon 非空，用 1x1 透明 PNG 兜底
    icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI12P4z8BQDwAEgAF/QualIQAAAABJRU5ErkJggg=="
    );
  }
  if (paths.length === 1) {
    event.sender.startDrag({ file: paths[0], icon });
  } else {
    event.sender.startDrag({ files: paths, icon });
  }
});

ipcMain.handle("show-in-finder", (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return;
  shell.showItemInFolder(filePath);
});

ipcMain.handle("open-file", (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return;
  try {
    if (!fs.statSync(filePath).isFile()) return;
  } catch { return; }
  shell.openPath(filePath);
});

ipcMain.handle("open-external", (_event, url) => {
  if (!url) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      shell.openExternal(url);
    }
  } catch {}
});

// 读取文件内容（仅文本文件，用于 Artifacts 预览）
ipcMain.handle("read-file", (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    // 限制 5MB，防止读大文件卡死
    if (stat.size > 5 * 1024 * 1024) return null;
    return fs.readFileSync(filePath, "utf-8");
  } catch { return null; }
});

// 写入文本文件（artifact 编辑用）
ipcMain.handle("write-file", (_event, filePath, content) => {
  if (!filePath || !path.isAbsolute(filePath)) return false;
  try {
    fs.writeFileSync(filePath, content, "utf-8");
    return true;
  } catch { return false; }
});

// 文件监听（artifact 编辑 — 外部变更刷新用）
const _fileWatchers = new Map();
ipcMain.handle("watch-file", (event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return false;
  // 取消旧的 watcher
  if (_fileWatchers.has(filePath)) {
    _fileWatchers.get(filePath).close();
    _fileWatchers.delete(filePath);
  }
  try {
    const watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
      if (eventType === "change") {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) {
          win.webContents.send("file-changed", filePath);
        }
      }
    });
    _fileWatchers.set(filePath, watcher);
    return true;
  } catch { return false; }
});

ipcMain.handle("unwatch-file", (_event, filePath) => {
  if (_fileWatchers.has(filePath)) {
    _fileWatchers.get(filePath).close();
    _fileWatchers.delete(filePath);
  }
  return true;
});

// 读取二进制文件为 base64（图片、PDF 等）
ipcMain.handle("read-file-base64", (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > 20 * 1024 * 1024) return null; // 20MB 限制
    return fs.readFileSync(filePath).toString("base64");
  } catch { return null; }
});

// 读取 docx 文件并转为 HTML（mammoth）
ipcMain.handle("read-docx-html", async (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > 20 * 1024 * 1024) return null;
    const mammoth = require("mammoth");
    const result = await mammoth.convertToHtml({ path: filePath });
    return result.value; // HTML string
  } catch { return null; }
});

// 读取 xlsx 文件并转为 HTML 表格（ExcelJS）
ipcMain.handle("read-xlsx-html", async (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > 20 * 1024 * 1024) return null;
    const ExcelJS = require("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount === 0) return null;
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    let html = "<table>";
    sheet.eachRow((row) => {
      html += "<tr>";
      for (let i = 1; i <= sheet.columnCount; i++) {
        html += `<td>${esc(row.getCell(i).text)}</td>`;
      }
      html += "</tr>";
    });
    html += "</table>";
    return html;
  } catch { return null; }
});

// 重新加载主窗口（DevTools 用）
ipcMain.handle("reload-main-window", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.reload();
  }
});

// 系统通知（由 agent 的 notify 工具触发）
ipcMain.handle("show-notification", (_event, title, body) => {
  if (!Notification.isSupported()) return;
  const notif = new Notification({
    title: title || "Hana",
    body: body || "",
    silent: false,
  });
  notif.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  notif.show();
});

// Debug: 打开 Onboarding 窗口（DevTools 用）
ipcMain.handle("debug-open-onboarding", () => {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.focus();
    return;
  }
  createOnboardingWindow();
});

// Debug: 预览模式打开 Onboarding（不调 API 不写配置）
ipcMain.handle("debug-open-onboarding-preview", () => {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.focus();
    return;
  }
  createOnboardingWindow({ preview: "1" });
});

// Onboarding 完成后，写标记 → 创建主窗口
ipcMain.handle("onboarding-complete", () => {
  const prefsPath = path.join(hanakoHome, "user", "preferences.json");
  try {
    let prefs = {};
    try { prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8")); } catch {}
    prefs.setupComplete = true;
    fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error("[desktop] Failed to write setupComplete:", err);
  }
  // 创建主窗口（隐藏），前端 init 完成后通过 app-ready 显示
  createMainWindow();
});

// ── 窗口控制 IPC（Windows/Linux 自绘标题栏用）──
ipcMain.handle("get-platform", () => process.platform);
ipcMain.handle("window-minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
ipcMain.handle("window-maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win?.isMaximized()) win.restore(); else win?.maximize();
});
ipcMain.handle("window-close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});
ipcMain.handle("window-is-maximized", (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

// 前端初始化完成后调用，关闭 splash / onboarding，显示主窗口
ipcMain.handle("app-ready", () => {
  if (mainWindow) {
    mainWindow.show();
  }

  // 首次启动时请求通知权限（macOS）
  if (process.platform === "darwin" && Notification.isSupported()) {
    const settings = systemPreferences.getNotificationSettings?.();
    const status = settings?.authorizationStatus;
    if (settings && status === "not-determined") {
      const notif = new Notification({ title: "Hana", body: "通知已就绪", silent: true });
      notif.show();
    }
  }

  // 稍微延迟关闭 splash / onboarding，让主窗口先稳定显示
  setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.close();
    }
  }, 200);
});

// ── App 生命周期 ──
app.whenReady().then(async () => {
  try {
    // 1. 立刻显示启动窗口
    createSplashWindow();
    const splashShownAt = Date.now();

    // 2. 后台启动 server
    console.log("[desktop] 启动 Hanako Server...");
    await startServer();
    console.log(`[desktop] Server 就绪，端口: ${serverPort}`);
    monitorServer();
    setupBrowserCommands();
    createTray();

    // 3. 确保 splash 至少显示 3 秒
    const elapsed = Date.now() - splashShownAt;
    const minSplashMs = 3000;
    if (elapsed < minSplashMs) {
      await new Promise(r => setTimeout(r, minSplashMs - elapsed));
    }

    // 4. 检测是否需要 onboarding
    if (isSetupComplete()) {
      // 已完成配置：直接创建主窗口
      createMainWindow();
    } else if (hasExistingConfig()) {
      // 老用户：已有 api_key，跳过填写直接看教程
      console.log("[desktop] 检测到已有配置，跳到教程页");
      createOnboardingWindow({ skipToTutorial: "1" });
    } else {
      // 全新用户：完整 onboarding 向导
      console.log("[desktop] 首次启动，显示 Onboarding 向导");
      createOnboardingWindow();
    }

    // 5. 注册 DevTools 快捷键（Cmd+Option+=，仅 dev 模式）
    const isDev = process.argv.includes("--dev") || process.env.NODE_ENV === "development";
    if (isDev) {
      globalShortcut.register("CommandOrControl+Alt+=", () => {
        if (devToolsWindow && !devToolsWindow.isDestroyed()) {
          devToolsWindow.close();
        } else {
          createDevToolsWindow();
        }
      });
    }

    // 6. 后台检查更新（不阻塞启动）
    checkForUpdates().catch(() => {});
  } catch (err) {
    console.error("[desktop] 启动失败:", err.message);
    // 写入 crash.log 并获取详细日志
    const crashInfo = writeCrashLog(err.message);
    // 截取最后 800 字符放进 dialog（太长会显示不全）
    const tail = crashInfo.length > 800 ? "...\n" + crashInfo.slice(-800) : crashInfo;
    dialog.showErrorBox(
      "Hanako 启动失败",
      `${tail}\n\n详细日志已保存到：\n${path.join(hanakoHome, "crash.log")}\n\n请将此截图或日志文件发送给开发者。`
    );
    forceQuitApp = true;
    app.quit();
  }
});

app.on("window-all-closed", () => {
  // 有托盘时保持常驻：macOS 通过 dock 重新打开，Windows 通过托盘双击
  // 托盘不存在时（创建失败或未初始化）直接退出，避免幽灵进程
  if (!tray || tray.isDestroyed()) {
    forceQuitApp = true;
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverPort) {
    createMainWindow();
    // 不在这里 show()，前端 init 完成后会通过 app-ready IPC 触发显示
  } else if (mainWindow) {
    mainWindow.show();
  }
});

// ── 优雅关闭 ──
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  // 销毁托盘图标
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
});

app.on("before-quit", async (event) => {
  isQuitting = true;
  isExitingServer = true; // Cmd+Q 走完全退出路径，连 server 一起关
  // 完全退出：清理浏览器实例（仅在真正退出时执行，避免隐藏路径打断后台浏览器能力）
  for (const [sp, view] of _browserViews) {
    try { view.webContents.close(); } catch {}
  }
  _browserViews.clear();
  _browserWebView = null;
  _currentBrowserSession = null;

  // 完全退出：同时 kill server
  if (serverProcess && !serverProcess.killed) {
    event.preventDefault();
    console.log("[desktop] 正在关闭 Server...");
    try { serverProcess.send({ type: "shutdown" }); } catch {}

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (serverProcess && !serverProcess.killed) {
          serverProcess.kill();
        }
        resolve();
      }, 5000);

      serverProcess.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    serverProcess = null;
    app.quit();
  } else if (reusedServerPid) {
    // 复用路径：通过 HTTP 接口优雅关闭（跨平台可靠，不依赖信号）
    event.preventDefault();
    console.log("[desktop] 正在关闭复用的 Server...");
    try {
      await fetch(`http://127.0.0.1:${serverPort}/api/shutdown`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serverToken}` },
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // HTTP 失败则回退到 kill
      killPid(reusedServerPid);
    }

    // 轮询等待进程退出（最多 5 秒）
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { process.kill(reusedServerPid, 0); } catch { break; }
      await new Promise(r => setTimeout(r, 200));
    }
    killPid(reusedServerPid, true); // 超时则强制
    reusedServerPid = null;
    app.quit();
  }
});
