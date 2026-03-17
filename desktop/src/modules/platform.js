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
    selectSkill: async () => null,
    selectAuthFile: async () => null,

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

// ── 平台检测 + Windows 窗口控制注入 ──
(async function initPlatform() {
  const p = window.platform;
  if (!p?.getPlatform) return;
  const plat = await p.getPlatform();
  document.documentElement.setAttribute("data-platform", plat);

  // Windows/Linux：注入自绘窗口控制按钮
  if (plat !== "darwin" && plat !== "web") {
    const titlebar = document.querySelector(".titlebar");
    if (!titlebar) return;

    const controls = document.createElement("div");
    controls.className = "window-controls";
    controls.innerHTML = `
      <button class="wc-btn wc-minimize" title="最小化">
        <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1"/></svg>
      </button>
      <button class="wc-btn wc-maximize" title="最大化">
        <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1"/></svg>
      </button>
      <button class="wc-btn wc-close" title="关闭">
        <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="1"/><line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" stroke-width="1"/></svg>
      </button>
    `;
    titlebar.appendChild(controls);

    controls.querySelector(".wc-minimize").addEventListener("click", () => p.windowMinimize());
    controls.querySelector(".wc-maximize").addEventListener("click", () => p.windowMaximize());
    controls.querySelector(".wc-close").addEventListener("click", () => p.windowClose());

    // 最大化状态变化时切换图标
    if (p.onMaximizeChange) {
      p.onMaximizeChange((maximized) => {
        const svg = controls.querySelector(".wc-maximize svg");
        if (maximized) {
          svg.innerHTML = '<rect x="3" y="1" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/><rect x="1" y="3" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/>';
        } else {
          svg.innerHTML = '<rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1"/>';
        }
      });
    }
  }
})();
