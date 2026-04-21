/**
 * platform.js — 平台适配层
 *
 * Electron 环境：直接转发给 preload 注入的 window.hana（IPC）
 * Web 环境：降级到 HTTP API + 浏览器原生 API
 *
 * 使用方式：所有前端代码调 platform.xxx()，不再直接碰 window.hana。
 */
(function () {
  if (window.hana) {
    // Electron — 直接用 preload 注入的 IPC bridge
    window.platform = window.hana;
    return;
  }

  // Web / 非 Electron 环境 — HTTP fallback
  const params = new URLSearchParams(location.search);
  const token = params.get("token") || localStorage.getItem("hana-token") || "";
  const baseUrl = `${location.protocol}//${location.host}`;

  function apiFetch(path, opts = {}) {
    const headers = { ...opts.headers };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return fetch(`${baseUrl}${path}`, { ...opts, headers });
  }

  window.platform = {
    // 服务器连接
    getServerPort: async () => location.port || "3000",
    getServerToken: async () => token,
    appReady: async () => {},

    // 文件 I/O → server HTTP
    readFile: (p) => apiFetch(`/api/fs/read?path=${encodeURIComponent(p)}`).then(r => r.ok ? r.text() : null),
    readFileBase64: (p) => apiFetch(`/api/fs/read-base64?path=${encodeURIComponent(p)}`).then(r => r.ok ? r.text() : null),
    readDocxHtml: (p) => apiFetch(`/api/fs/docx-html?path=${encodeURIComponent(p)}`).then(r => r.ok ? r.text() : null),
    readXlsxHtml: (p) => apiFetch(`/api/fs/xlsx-html?path=${encodeURIComponent(p)}`).then(r => r.ok ? r.text() : null),

    // 文件写入 / 监听 / 编辑器窗口 → Web 不支持
    writeFile: async () => false,
    watchFile: async () => false,
    unwatchFile: async () => false,
    onFileChanged: () => {},
    openEditorWindow: () => {},
    onEditorDockFile: () => {},
    onEditorDetached: () => {},

    // 文件路径（Web 不支持系统路径）
    getFilePath: () => null,
    getAvatarPath: () => null,
    getSplashInfo: async () => ({}),

    // 系统对话框 → Web 降级
    selectFolder: async () => null,
    selectFiles: async () => [],
    selectSkill: async () => null,
    selectPlugin: async () => null,

    // OS 集成 → 静默降级
    openFolder: () => {},
    openFile: () => {},
    openExternal: (url) => { try { window.open(url, "_blank"); } catch {} },
    showInFinder: () => {},
    startDrag: () => {},

    // 窗口管理 → 单页降级
    openSettings: () => {},
    reloadMainWindow: () => location.reload(),

    // 设置通信 → Web 环境暂不支持跨窗口
    settingsChanged: () => {},
    onSettingsChanged: () => {},

    // 浏览器查看器 → Web 环境暂不支持
    openBrowserViewer: () => {},
    closeBrowserViewer: () => {},
    onBrowserUpdate: () => {},
    browserGoBack: () => {},
    browserGoForward: () => {},
    browserReload: () => {},
    browserEmergencyStop: () => {},

    // Skill 查看器 → Web 环境暂不支持
    openSkillViewer: () => {},
    listSkillFiles: async () => [],
    readSkillFile: async () => null,
    onSkillViewerLoad: () => {},
    closeSkillViewer: () => {},

    // Onboarding
    onboardingComplete: async () => {},
    debugOpenOnboarding: async () => {},
    debugOpenOnboardingPreview: async () => {},

    // 窗口控制（Web 不需要）
    getPlatform: async () => "web",
    windowMinimize: () => {},
    windowMaximize: () => {},
    windowClose: () => {},
    windowIsMaximized: async () => false,
    onMaximizeChange: () => {},
  };
})();

// ── 平台检测 ──
(async function initPlatform() {
  const p = window.platform;
  if (!p?.getPlatform) return;
  const plat = await p.getPlatform();
  document.documentElement.setAttribute("data-platform", plat);
  // Windows/Linux 窗口控制按钮已迁移到 React (App.tsx WindowControls)
})();
