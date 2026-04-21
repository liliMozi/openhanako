/**
 * Hana Desktop — Preload 桥接
 *
 * 业务通信走 HTTP/WS 到 server。
 * IPC 仅用于：窗口管理、系统对话框、跨窗口消息转发。
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");
// ⚠️ 这是 preload 的"源文件"，不是 Electron 实际加载的。
// Vite (vite.config.preload.js) 会把这个文件和其依赖 bundle 成
// desktop/preload.bundle.cjs —— main.cjs 里 BrowserWindow 的
// webPreferences.preload 指向 bundle 产物。
// 可以放心 require 任何相对路径 / node_modules，bundler 会内联。
const { pathToFileUrl } = require("./src/shared/path-to-file-url.cjs");

function resolveTheme() {
  const saved = localStorage.getItem("hana-theme") || "auto";
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return saved === "auto" ? (isDark ? "midnight" : "warm-paper") : saved;
}

contextBridge.exposeInMainWorld("hana", {
  getServerPort: () => ipcRenderer.invoke("get-server-port"),
  getServerToken: () => ipcRenderer.invoke("get-server-token"),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  // Auto-update (Windows)
  autoUpdateCheck: () => ipcRenderer.invoke("auto-update-check"),
  autoUpdateDownload: () => ipcRenderer.invoke("auto-update-download"),
  autoUpdateInstall: () => ipcRenderer.invoke("auto-update-install"),
  autoUpdateState: () => ipcRenderer.invoke("auto-update-state"),
  autoUpdateSetChannel: (ch) => ipcRenderer.invoke("auto-update-set-channel", ch),
  onAutoUpdateState: (cb) => ipcRenderer.on("auto-update-state", (_, state) => cb(state)),
  appReady: () => ipcRenderer.invoke("app-ready"),
  selectFolder: () => ipcRenderer.invoke("select-folder"),
  selectFiles: () => ipcRenderer.invoke("select-files"),
  selectSkill: () => ipcRenderer.invoke("select-skill"),
  selectPlugin: () => ipcRenderer.invoke("select-plugin"),
  openFolder: (path) => ipcRenderer.invoke("open-folder", path),
  openFile: (path) => ipcRenderer.invoke("open-file", path),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  showInFinder: (path) => ipcRenderer.invoke("show-in-finder", path),
  readFile: (path) => ipcRenderer.invoke("read-file", path),
  writeFile: (filePath, content) => ipcRenderer.invoke("write-file", filePath, content),
  writeFileBinary: (filePath, base64Data) => ipcRenderer.invoke("write-file-binary", filePath, base64Data),
  screenshotRender: (payload) => ipcRenderer.invoke("screenshot-render", payload),
  watchFile: (filePath) => ipcRenderer.invoke("watch-file", filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke("unwatch-file", filePath),
  onFileChanged: (cb) => ipcRenderer.on("file-changed", (_, filePath) => cb(filePath)),
  readFileBase64: (path) => ipcRenderer.invoke("read-file-base64", path),
  // 本地路径 → file:// URL（同步，纯字符串转换，无 IPC）。逻辑见 src/shared/path-to-file-url.cjs
  getFileUrl: (filePath) => pathToFileUrl(filePath),
  readDocxHtml: (path) => ipcRenderer.invoke("read-docx-html", path),
  readXlsxHtml: (path) => ipcRenderer.invoke("read-xlsx-html", path),
  getFilePath: (file) => webUtils.getPathForFile(file),
  getAvatarPath: (role) => ipcRenderer.invoke("get-avatar-path", role),
  getSplashInfo: () => ipcRenderer.invoke("get-splash-info"),
  reloadMainWindow: () => ipcRenderer.invoke("reload-main-window"),
  // Onboarding
  onboardingComplete: () => ipcRenderer.invoke("onboarding-complete"),
  debugOpenOnboarding: () => ipcRenderer.invoke("debug-open-onboarding"),
  debugOpenOnboardingPreview: () => ipcRenderer.invoke("debug-open-onboarding-preview"),
  // Skill Viewer overlay（主进程 → 渲染进程）
  onShowSkillViewer: (cb) => ipcRenderer.on("show-skill-viewer", (_, data) => cb(data)),
  // 设置窗口
  openSettings: (tab) => ipcRenderer.invoke("open-settings", tab, resolveTheme()),
  settingsChanged: (type, data) => ipcRenderer.send("settings-changed", type, data),
  onSettingsChanged: (cb) => ipcRenderer.on("settings-changed", (_, type, data) => cb(type, data)),
  onSwitchTab: (cb) => ipcRenderer.on("settings-switch-tab", (_, tab) => cb(tab)),
  onServerRestarted: (cb) => ipcRenderer.on("server-restarted", (_, data) => cb(data)),
  // 浏览器查看器窗口
  openBrowserViewer: () => ipcRenderer.invoke("open-browser-viewer", resolveTheme()),
  onBrowserUpdate: (cb) => ipcRenderer.on("browser-update", (_, data) => cb(data)),
  browserGoBack: () => ipcRenderer.invoke("browser-go-back"),
  browserGoForward: () => ipcRenderer.invoke("browser-go-forward"),
  browserReload: () => ipcRenderer.invoke("browser-reload"),
  closeBrowserViewer: () => ipcRenderer.invoke("close-browser-viewer"),
  browserEmergencyStop: () => ipcRenderer.invoke("browser-emergency-stop"),
  // 编辑器独立窗口
  openEditorWindow: (data) => ipcRenderer.invoke("open-editor-window", data),
  onEditorLoad: (cb) => ipcRenderer.on("editor-load", (_, data) => cb(data)),
  editorDock: () => ipcRenderer.invoke("editor-dock"),
  editorClose: () => ipcRenderer.invoke("editor-close"),
  onEditorDockFile: (cb) => ipcRenderer.on("editor-dock-file", (_, data) => cb(data)),
  onEditorDetached: (cb) => ipcRenderer.on("editor-detached", (_, detached) => cb(detached)),
  // Skill 预览窗口
  openSkillViewer: (data) => ipcRenderer.invoke("open-skill-viewer", data),
  listSkillFiles: (baseDir) => ipcRenderer.invoke("skill-viewer-list-files", baseDir),
  readSkillFile: (filePath) => ipcRenderer.invoke("skill-viewer-read-file", filePath),
  onSkillViewerLoad: (cb) => ipcRenderer.on("skill-viewer-load", (_, data) => cb(data)),
  closeSkillViewer: () => ipcRenderer.invoke("close-skill-viewer"),
  // 原生拖拽（书桌文件拖到 Finder / 聊天区）
  startDrag: (filePaths) => ipcRenderer.send("start-drag", filePaths),
  // 系统通知
  showNotification: (title, body) => ipcRenderer.invoke("show-notification", title, body),
  // 窗口控制（Windows/Linux 自绘标题栏）
  getPlatform: () => ipcRenderer.invoke("get-platform"),
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("window-maximize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  onMaximizeChange: (cb) => {
    ipcRenderer.on("window-maximized", () => cb(true));
    ipcRenderer.on("window-unmaximized", () => cb(false));
  },
});
