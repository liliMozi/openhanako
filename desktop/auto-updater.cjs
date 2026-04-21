/**
 * auto-updater.cjs — electron-updater 集成
 *
 * 行为：启动时静默检查 → 静默下载 → 用户在 AboutTab 手动触发重启安装。
 * 频道：Stable（allowPrerelease=false）/ Preview（allowPrerelease=true）。
 */
const { ipcMain, app } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");

const CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 小时

let _mainWindow = null;
let _shutdownServer = null; // 由 main.cjs 注入
let _setIsUpdating = null;  // 由 main.cjs 注入
let _hanakoHome = null;     // 由 main.cjs 注入
let _showInstalling = null; // 由 main.cjs 注入：打开"正在安装更新"小窗
let _failInstalling = null; // 由 main.cjs 注入：安装失败时切换窗口文案
let _checkTimer = null;

/**
 * 读 preferences.json 里的 auto_check_updates，默认 true。
 * 不缓存：每次调用都重新读，用户在设置页改完立刻生效，
 * 不用另起一条 main↔server 的 IPC 通道。
 */
function isAutoCheckEnabled() {
  try {
    const prefsPath = path.join(_hanakoHome || "", "user", "preferences.json");
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
    return prefs.auto_check_updates !== false;
  } catch {
    return true;
  }
}

// ── 状态管理（保持与前端 AutoUpdateState 契约一致）──

let _updateState = {
  status: "idle",       // idle | checking | available | downloading | downloaded | error | latest
  version: null,
  releaseNotes: null,
  releaseUrl: null,
  downloadUrl: null,
  progress: null,
  error: null,
};

function getState() {
  return { ..._updateState };
}

function sendToRenderer(channel, data) {
  if (_mainWindow && !_mainWindow.isDestroyed()) {
    _mainWindow.webContents.send(channel, data);
  }
}

function setState(patch) {
  Object.assign(_updateState, patch);
  sendToRenderer("auto-update-state", getState());
}

function resetState() {
  _updateState = {
    status: "idle", version: null, releaseNotes: null,
    releaseUrl: null, downloadUrl: null, progress: null, error: null,
  };
}

// ── 磁盘空间检查 ──

async function hasSufficientDiskSpace(checkPath, minMB) {
  try {
    const stats = await fs.promises.statfs(checkPath);
    const availableBytes = stats.bavail * stats.bsize;
    return availableBytes >= minMB * 1024 * 1024;
  } catch {
    return true; // statfs 失败时不阻塞更新
  }
}

// ── macOS DMG 挂载检测 ──

function isRunningFromDmg() {
  if (process.platform !== "darwin") return false;
  return app.getPath("exe").startsWith("/Volumes/");
}

// ── 缓存清理 ──

async function cleanUpdateCache() {
  const dataDir = _hanakoHome;
  const versionFile = path.join(dataDir, "last-update-version");

  // 迁移：旧版 bug 把 last-update-version 写到了 ~/.hanako-dev/（生产环境误用）
  // 搬过来后尝试清理孤儿目录
  try {
    const wrongDir = path.join(require("os").homedir(), ".hanako-dev");
    if (wrongDir !== dataDir) {
      const wrongFile = path.join(wrongDir, "last-update-version");
      if (fs.existsSync(wrongFile)) {
        if (!fs.existsSync(versionFile)) {
          fs.mkdirSync(path.dirname(versionFile), { recursive: true });
          fs.renameSync(wrongFile, versionFile);
        } else {
          fs.unlinkSync(wrongFile);
        }
        // 目录空了就删掉
        try { fs.rmdirSync(wrongDir); } catch {} // rmdirSync 非空会失败，正好
        console.log("[auto-updater] 已清理旧版误写的 ~/.hanako-dev/last-update-version");
      }
    }
  } catch {}
  const currentVersion = app.getVersion();

  let shouldClean = false;

  // 条件 1：版本变化（刚完成更新）
  try {
    const lastVersion = fs.readFileSync(versionFile, "utf-8").trim();
    if (lastVersion !== currentVersion) shouldClean = true;
  } catch {
    // 文件不存在，首次运行
  }

  // 写入当前版本
  try {
    fs.mkdirSync(path.dirname(versionFile), { recursive: true });
    fs.writeFileSync(versionFile, currentVersion);
  } catch {}

  // 条件 2：缓存过大（> 500MB）
  if (!shouldClean) {
    const cacheDir = path.join(app.getPath("userData"), "pending");
    try {
      const size = await dirSize(cacheDir);
      if (size > 500 * 1024 * 1024) shouldClean = true;
    } catch {}
  }

  if (shouldClean) {
    const cacheDir = path.join(app.getPath("userData"), "pending");
    try {
      await fs.promises.rm(cacheDir, { recursive: true, force: true });
      console.log("[auto-updater] 已清理更新缓存");
    } catch {}
  }
}

async function dirSize(dir) {
  let total = 0;
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        const stat = await fs.promises.stat(full);
        total += stat.size;
      } else if (entry.isDirectory()) {
        total += await dirSize(full);
      }
    }
  } catch {}
  return total;
}

// ── electron-updater 配置 ──

function setupAutoUpdater() {
  // 显式设置 feed URL，不依赖 app-update.yml（electron-builder --dir 不生成该文件）
  autoUpdater.setFeedURL({
    provider: "github",
    owner: "liliMozi",
    repo: "openhanako",
  });

  autoUpdater.autoDownload = false;          // 由我们控制（磁盘空间检查后手动触发）
  autoUpdater.autoInstallOnAppQuit = false;  // 等用户手动触发
  autoUpdater.allowPrerelease = false;       // 由频道控制
  autoUpdater.disableDifferentialDownload = true;

  // ── 事件 → 状态映射 ──

  autoUpdater.on("checking-for-update", () => {
    setState({ status: "checking", error: null });
  });

  autoUpdater.on("update-available", async (info) => {
    setState({
      status: "available",
      version: info.version,
      releaseNotes: typeof info.releaseNotes === "string"
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map(n => n.note || n).join("\n")
          : null,
    });

    // 磁盘空间检查
    const ok = await hasSufficientDiskSpace(app.getPath("userData"), 500);
    if (!ok) {
      setState({ status: "error", error: "disk_space_insufficient", version: info.version });
      return;
    }

    // 空间足够，开始静默下载
    autoUpdater.downloadUpdate().catch((err) => {
      setState({ status: "error", error: err?.message || String(err) });
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    setState({
      status: "downloading",
      progress: {
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      },
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    setState({
      status: "downloaded",
      version: info.version,
      progress: null,
    });
  });

  autoUpdater.on("update-not-available", () => {
    setState({ status: "latest" });
  });

  autoUpdater.on("error", (err) => {
    // 下载中出错才设 error，idle/latest 状态的检查失败静默忽略
    if (_updateState.status !== "idle" && _updateState.status !== "latest") {
      setState({ status: "error", error: err?.message || String(err) });
    }
  });
}

// ── IPC handlers ──

function registerIpcHandlers() {
  ipcMain.handle("auto-update-check", async () => {
    resetState();
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      setState({ status: "error", error: err?.message || String(err) });
    }
  });

  // 保留 channel 向后兼容，改为空操作（下载由 update-available 自动触发）
  ipcMain.handle("auto-update-download", async () => true);

  ipcMain.handle("auto-update-install", async () => {
    if (_updateState.status !== "downloaded") return;
    console.log("[auto-updater] 用户触发重启安装...");
    if (_setIsUpdating) _setIsUpdating(true);
    // 在主窗口被关掉之前，先把"正在安装更新"的小窗打开，
    // 防止 quitAndInstall 期间黑屏让用户以为 app 崩了。
    try { _showInstalling?.(_updateState.version); } catch {}
    if (_shutdownServer) await _shutdownServer();
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (err) {
      // 权限不足等原因导致安装失败
      if (_setIsUpdating) _setIsUpdating(false);
      try { _failInstalling?.(err?.message || String(err)); } catch {}
      setState({ status: "error", error: err?.message || String(err) });
    }
  });

  ipcMain.handle("auto-update-state", () => getState());

  ipcMain.handle("auto-update-set-channel", (_event, channel) => {
    autoUpdater.allowPrerelease = (channel === "beta");
  });
}

// ── 定时轮询 ──

function startPolling() {
  _checkTimer = setInterval(() => {
    // 每 tick 都重新读 preferences：用户关掉开关后，下一 tick 就不再自动查
    if (!isAutoCheckEnabled()) return;
    autoUpdater.checkForUpdates().catch(() => {});
  }, CHECK_INTERVAL);
}

// ── 公共 API ──

function initAutoUpdater(mainWindow, {
  shutdownServer, setIsUpdating, hanakoHome,
  showInstalling, failInstalling,
} = {}) {
  _mainWindow = mainWindow;
  _shutdownServer = shutdownServer;
  _setIsUpdating = setIsUpdating;
  _hanakoHome = hanakoHome;
  _showInstalling = showInstalling;
  _failInstalling = failInstalling;

  // 开发环境不初始化 auto-updater
  if (!app.isPackaged) {
    registerIpcHandlers(); // IPC handler 仍注册（避免 invoke 报错），但不连接 electron-updater
    return;
  }

  // macOS：从 DMG 直接运行时禁用
  if (isRunningFromDmg()) {
    setState({ status: "error", error: "running_from_dmg" });
    registerIpcHandlers();
    return;
  }

  // 缓存清理（异步，不阻塞启动）
  cleanUpdateCache().catch(() => {});

  setupAutoUpdater();
  registerIpcHandlers();
  // 定时轮询 handler 自己判断开关，直接起 timer 不需要外层判断
  startPolling();
}

async function checkForUpdatesAuto() {
  if (!app.isPackaged || isRunningFromDmg()) return;
  // 用户关了自动检查开关：启动时也不自动 check
  if (!isAutoCheckEnabled()) return;
  try {
    await autoUpdater.checkForUpdates();
  } catch {}
}

function setUpdateChannel(channel) {
  autoUpdater.allowPrerelease = (channel === "beta");
}

function setMainWindow(win) {
  _mainWindow = win;
}

module.exports = { initAutoUpdater, checkForUpdatesAuto, setMainWindow, setUpdateChannel, getState };
