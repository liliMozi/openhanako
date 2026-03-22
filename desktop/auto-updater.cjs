/**
 * auto-updater.cjs — 跨平台自动更新
 *
 * 所有平台统一使用 GitHub API 检测新版本，浏览器下载安装包。
 * 不依赖 electron-updater / latest.yml。
 *
 * beta 开关读 preferences.update_channel，通过 IPC 传入。
 */
const { ipcMain, shell } = require("electron");
const { app } = require("electron");

let _mainWindow = null;
let _updateChannel = "stable"; // "stable" | "beta"

let _updateState = {
  status: "idle",      // idle | checking | available | error | latest
  version: null,
  releaseNotes: null,
  releaseUrl: null,     // GitHub release page URL
  downloadUrl: null,    // direct download URL (asset)
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

// ── 版本比较 ──
function isNewerVersion(latest, current) {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

// ══════════════════════════════════════
// GitHub API 检测（所有平台共用）
// ══════════════════════════════════════
const GITHUB_RELEASES_URL = "https://api.github.com/repos/liliMozi/openhanako/releases";

/** 根据平台选择对应的安装包后缀 */
function getAssetExt() {
  switch (process.platform) {
    case "win32": return ".exe";
    case "darwin": return ".dmg";
    default: return ".AppImage";
  }
}

async function checkUpdate() {
  setState({ status: "checking", error: null, version: null, progress: null });
  try {
    // beta: 取所有 releases 的第一个（含 prerelease）
    // stable: 取 /latest（只返回非 prerelease）
    const url = _updateChannel === "beta"
      ? GITHUB_RELEASES_URL + "?per_page=5"
      : GITHUB_RELEASES_URL + "/latest";
    const res = await fetch(url, {
      headers: { "User-Agent": "Hanako" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      setState({ status: "error", error: `GitHub API ${res.status}` });
      return null;
    }
    const data = await res.json();
    // /latest 返回对象；带 per_page 返回数组
    const release = Array.isArray(data) ? pickRelease(data) : data;
    if (!release) {
      setState({ status: "latest" });
      return null;
    }
    const latest = (release.tag_name || "").replace(/^v/, "");
    const current = app.getVersion();
    if (!latest || !isNewerVersion(latest, current)) {
      setState({ status: "latest" });
      return null;
    }
    const ext = getAssetExt();
    const asset = (release.assets || []).find(a => a.name?.endsWith(ext));
    setState({
      status: "available",
      version: latest,
      releaseNotes: release.body || null,
      releaseUrl: release.html_url,
      downloadUrl: asset?.browser_download_url || release.html_url,
    });
    return latest;
  } catch (err) {
    setState({ status: "error", error: err?.message || String(err) });
    return null;
  }
}

/** 从 releases 数组中选出最新的可用 release（beta 模式取第一个，含 prerelease） */
function pickRelease(releases) {
  if (!releases || releases.length === 0) return null;
  if (_updateChannel === "beta") return releases[0];
  return releases.find(r => !r.prerelease && !r.draft) || null;
}

// ══════════════════════════════════════
// 公共 API
// ══════════════════════════════════════

function initAutoUpdater(mainWindow) {
  _mainWindow = mainWindow;

  ipcMain.handle("auto-update-check", async () => {
    resetState();
    return checkUpdate();
  });

  ipcMain.handle("auto-update-download", async () => {
    if (_updateState.downloadUrl) {
      shell.openExternal(_updateState.downloadUrl);
    }
    return true;
  });

  ipcMain.handle("auto-update-install", () => {
    if (_updateState.releaseUrl) {
      shell.openExternal(_updateState.releaseUrl);
    }
  });

  ipcMain.handle("auto-update-state", () => {
    return getState();
  });

  ipcMain.handle("auto-update-set-channel", (_event, channel) => {
    _updateChannel = channel === "beta" ? "beta" : "stable";
  });
}

async function checkForUpdatesAuto() {
  try {
    return await checkUpdate();
  } catch {
    return null;
  }
}

function setUpdateChannel(channel) {
  _updateChannel = channel === "beta" ? "beta" : "stable";
}

function setMainWindow(win) {
  _mainWindow = win;
}

module.exports = { initAutoUpdater, checkForUpdatesAuto, setMainWindow, setUpdateChannel, getState };
