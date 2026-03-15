/**
 * Hana Desktop — Preload 桥接
 *
 * 业务通信走 HTTP/WS 到 server。
 * IPC 仅用于：窗口管理、系统对话框、跨窗口消息转发。
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

function resolveTheme() {
  const saved = localStorage.getItem("hana-theme") || "auto";
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return saved === "auto" ? (isDark ? "midnight" : "warm-paper") : saved;
}

contextBridge.exposeInMainWorld("hana", {
  getServerPort: () => ipcRenderer.invoke("get-server-port"),
  getServerToken: () => ipcRenderer.invoke("get-server-token"),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  appReady: () => ipcRenderer.invoke("app-ready"),
  selectFolder: () => ipcRenderer.invoke("select-folder"),
  selectSkill: () => ipcRenderer.invoke("select-skill"),
  openFolder: (path) => ipcRenderer.invoke("open-folder", path),
  openFile: (path) => ipcRenderer.invoke("open-file", path),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  showInFinder: (path) => ipcRenderer.invoke("show-in-finder", path),
  readFile: (path) => ipcRenderer.invoke("read-file", path),
  writeFile: (filePath, content) => ipcRenderer.invoke("write-file", filePath, content),
  watchFile: (filePath) => ipcRenderer.invoke("watch-file", filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke("unwatch-file", filePath),
  onFileChanged: (cb) => ipcRenderer.on("file-changed", (_, filePath) => cb(filePath)),
  readFileBase64: (path) => ipcRenderer.invoke("read-file-base64", path),
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
  // 设置窗口
  openSettings: (tab) => ipcRenderer.invoke("open-settings", tab, resolveTheme()),
  settingsChanged: (type, data) => ipcRenderer.send("settings-changed", type, data),
  onSettingsChanged: (cb) => ipcRenderer.on("settings-changed", (_, type, data) => cb(type, data)),
  onSwitchTab: (cb) => ipcRenderer.on("settings-switch-tab", (_, tab) => cb(tab)),
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
});
