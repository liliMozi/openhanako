/**
 * Hanako Desktop — 前端主入口
 *
 * 纯 Vanilla JS，与 Hana Server 通过 HTTP + WebSocket 通信。
 * Phase 5 后只保留：state、DOM 引用、markdown-it、工具函数、
 * initModules 编排、init 启动。
 */

// ── 阻止 Electron 默认的文件拖入导航行为 ──
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

// ── 拆分模块引用 ──
const { escapeHtml, injectCopyButtons } = window.HanaModules.utils;
const _ch = () => window.HanaModules.channels;
const _fc = () => window.HanaModules.fileCards;
const _ar = () => window.HanaModules.artifacts;
const _cr = () => window.HanaModules.chatRender;
const _sb = () => window.HanaModules.sidebar;
const _dk = () => window.HanaModules.desk;
// app.js 分解（Phase 4 + 5）
const _msg = () => window.HanaModules.appMessages;
const _ag = () => window.HanaModules.appAgents;
const _ws = () => window.HanaModules.appWs;
const _ui = () => window.HanaModules.appUi;

// Activity / Automation / Bridge：React 渲染，这里只 toggle store state
const _setPanel = (p) => { const s = _zustandGet?.(); if (s?.setActivePanel) s.setActivePanel(p); else state.activePanel = p; };
const showActivityPanel = () => _setPanel("activity");
const hideActivityPanel = () => { if (state.activePanel === "activity") _setPanel(null); };
const isActivityVisible = () => state.activePanel === "activity";
const showAutomationPanel = () => _setPanel("automation");
const hideAutomationPanel = () => { if (state.activePanel === "automation") _setPanel(null); };
const isAutomationVisible = () => state.activePanel === "automation";
const renderActivityPanel = () => {};
const closeActivityDetail = () => {};
async function loadAutomationBadge() {
  try {
    const res = await hanaFetch("/api/desk/cron");
    const data = await res.json();
    const count = (data.jobs || []).length;
    const badge = document.getElementById("automationCountBadge");
    if (badge) badge.textContent = count > 0 ? count : "";
  } catch {}
}

// ── DOM 引用 ──
const $ = (sel) => document.querySelector(sel);
const chatArea = $("#chatArea");
const welcome = $("#welcome");
const messagesEl = $("#messages");
const settingsBtn = $("#settingsBtn");

// ── Markdown 渲染器 ──
const md = window.markdownit({
  html: false,
  breaks: true,
  linkify: true,
  typographer: true,
});

// GFM task list: [ ] → unchecked checkbox, [x] → checked checkbox
md.core.ruler.after("inline", "gfm-task-list", (mdState) => {
  const tokens = mdState.tokens;
  for (let i = 2; i < tokens.length; i++) {
    if (tokens[i].type !== "inline" || !tokens[i].children?.length) continue;
    if (tokens[i - 1].type !== "paragraph_open") continue;
    if (tokens[i - 2].type !== "list_item_open") continue;
    const first = tokens[i].children[0];
    if (first.type !== "text") continue;
    const m = first.content.match(/^\[([ xX])\]\s?/);
    if (!m) continue;
    const checked = m[1] !== " ";
    first.content = first.content.slice(m[0].length);
    const cb = new mdState.Token("html_inline", "", 0);
    cb.content = `<input type="checkbox" disabled${checked ? " checked" : ""}> `;
    tokens[i].children.unshift(cb);
    tokens[i - 2].attrJoin("class", "task-list-item");
  }
});

// 安全加固：所有链接添加 target="_blank" + rel="noopener noreferrer"
const _defaultLinkOpen = md.renderer.rules.link_open ||
  function (tokens, idx, options, _env, self) { return self.renderToken(tokens, idx, options); };

md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  const hrefIdx = tokens[idx].attrIndex("href");
  if (hrefIdx >= 0) {
    const href = tokens[idx].attrs[hrefIdx][1] || "";
    if (!/^https?:\/\//i.test(href) && !href.startsWith("/") && !href.startsWith("#")) {
      tokens[idx].attrs[hrefIdx][1] = "#";
    }
  }
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return _defaultLinkOpen(tokens, idx, options, env, self);
};

// ── 工具名称 → 人性化描述 ──
function getToolLabel(name, phase) {
  const agentName = state.agentName;
  const vars = { name: agentName };
  const val = t(`tool.${name}.${phase}`, vars);
  if (val !== `tool.${name}.${phase}`) return val;
  return t(`tool._fallback.${phase}`, vars);
}

/** 构建带认证 token 的 URL */
function hanaUrl(path) {
  const sep = path.includes("?") ? "&" : "?";
  const tokenParam = state.serverToken ? `${sep}token=${state.serverToken}` : "";
  return `http://127.0.0.1:${state.serverPort}${path}${tokenParam}`;
}

/** 带认证的 fetch 封装（30s 超时 + res.ok 校验） */
async function hanaFetch(path, opts = {}) {
  const headers = { ...opts.headers };
  if (state.serverToken) {
    headers["Authorization"] = `Bearer ${state.serverToken}`;
  }
  const { timeout = 30000, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`http://127.0.0.1:${state.serverPort}${path}`, {
      ...fetchOpts, headers, signal: controller.signal,
    });
    if (!res.ok) throw new Error(`hanaFetch ${path}: ${res.status} ${res.statusText}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 前端日志上报：POST 到 server 写入持久化日志文件
 */
window.__hanaLog = function (level, module, message) {
  if (!state.serverPort) return;
  hanaFetch("/api/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level, module, message }),
  }).catch(() => {});
};

// 全局错误捕获 → 持久化日志
window.addEventListener("error", (e) => {
  window.__hanaLog("error", "desktop", `${e.message} at ${e.filename}:${e.lineno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  window.__hanaLog("error", "desktop", `unhandledRejection: ${e.reason}`);
});

// ── 状态 ──
// DOM ref / 流式渲染字段，只存本地，不同步到 Zustand
const LOCAL_ONLY_KEYS = new Set([
  'currentGroup', 'currentAssistantEl', 'currentTextEl',
  'currentTextBuffer', 'currentMoodEl', 'currentMoodWrapper',
  'inMood', 'lastRole', 'currentToolGroup', 'ws',
  'inXing', 'xingTitle', 'xingCardEl', '_xingBuf',
]);

const _stateLocal = {
  serverPort: null,
  serverToken: null,
  ws: null,
  connected: false,
  isStreaming: false,
  models: [],
  currentModel: null,

  currentGroup: null,
  currentAssistantEl: null,
  currentTextEl: null,
  currentTextBuffer: "",
  currentMoodEl: null,
  currentMoodWrapper: null,
  inMood: false,
  inXing: false,
  xingTitle: null,
  xingCardEl: null,
  _xingBuf: '',

  lastRole: null,

  sessions: [],
  currentSessionPath: null,
  sessionStreams: {},
  sidebarOpen: true,
  sidebarAutoCollapsed: false,

  homeFolder: null,
  selectedFolder: null,
  cwdHistory: [],
  pendingNewSession: false,
  memoryEnabled: true,

  agentName: "Hanako",
  userName: "User",

  agentAvatarUrl: null,
  userAvatarUrl: null,
  agentYuan: "hanako",

  agents: [],
  currentAgentId: null,
  selectedAgentId: null,
  settingsAgentId: null,

  currentToolGroup: null,

  sessionTodos: [],

  jianOpen: true,
  jianAutoCollapsed: false,

  previewOpen: false,
  artifacts: [],
  currentArtifactId: null,

  deskFiles: [],
  deskBasePath: "",
  deskCurrentPath: "",
  deskJianContent: null,

  activities: [],

  currentTab: "chat",
  channels: [],
  currentChannel: null,
  channelMessages: [],
  channelTotalUnread: 0,

  browserRunning: false,
  browserUrl: null,
  browserThumbnail: null,
};

// Zustand 读写函数，bridge 激活后注入
let _zustandGet = null;
let _zustandSet = null;

const state = new Proxy(_stateLocal, {
  get(target, key) {
    if (_zustandGet && !LOCAL_ONLY_KEYS.has(key)) {
      const val = _zustandGet()[key];
      if (val !== undefined) return val;
    }
    return target[key];
  },
  set(target, key, value) {
    target[key] = value;
    if (_zustandSet && !LOCAL_ONLY_KEYS.has(key) && typeof value !== 'function') {
      _zustandSet({ [key]: value });
    }
    return true;
  },
});

// bridge 用：暴露 state Proxy 供 DOM ref 访问（currentAssistantEl 等）
window.__hanaState = state;
// 暴露 helper 给 bridge.ts desk shim（late-binding）
state.clearChat = (...a) => _ag().clearChat(...a);

// bridge 激活入口：React mount 后调用，把本地已有值推入 Zustand
window.__hanaActivateProxy = function(getState, setState) {
  const patch = {};
  for (const [k, v] of Object.entries(_stateLocal)) {
    if (LOCAL_ONLY_KEYS.has(k) || typeof v === 'function') continue;
    if (v != null && v !== '' && !(Array.isArray(v) && v.length === 0)) {
      patch[k] = v;
    }
  }
  _zustandGet = getState;
  _zustandSet = setState;
  if (Object.keys(patch).length > 0) setState(patch);
};

// ── 初始化模块 ──
function initModules() {
  const _inp = () => window.HanaModules.appInput;

  const sharedCtx = {
    state, $, hanaFetch, hanaUrl, md,
    chatArea, welcome, messagesEl,
    previewPanel: $("#previewPanel"),
    previewBody: $("#previewBody"),
    previewTitle: $("#previewTitle"),
    scrollToBottom: (...a) => _ui().scrollToBottom(...a),
    getToolLabel,
    yuanFallbackAvatar: (...a) => _ag().yuanFallbackAvatar(...a),
    parseMoodFromContent: (...a) => _msg().parseMoodFromContent(...a),
  };

  // Phase 5: UI shim (model/planMode/todo init removed — now React)
  _ui().initAppUi({
    state, $, hanaFetch, escapeHtml,
    chatArea,
    connectionStatus: $("#connectionStatus"),
    inputBox: null, settingsBtn,
    _cr, _ag, _dk, _sb,
  });

  // Phase 4: app.js 分解 shim
  _msg().initAppMessages({
    state, hanaFetch, md,
    scrollToBottom: (...a) => _ui().scrollToBottom(...a),
    renderTodoDisplay: () => {},
    escapeHtml, injectCopyButtons,
    _cr, _fc, _ar,
  });
  _ag().initAppAgents({
    state, $, hanaFetch, hanaUrl,
    messagesEl, welcome, welcomeText: $("#welcomeText"),
    inputBox: null,
    renderTodoDisplay: () => {},
    resetScroll: () => _ui().resetScroll(),
    _cr, _ar, _dk,
  });
  _ws().initAppWs({
    state, chatArea, md,
    scrollToBottom: (...a) => _ui().scrollToBottom(...a),
    setStatus: (...a) => _ui().setStatus(...a),
    showError: (...a) => _ui().showError(...a),
    injectCopyButtons, escapeHtml, platform,
    _cr, _fc, _ar, _sb, _ch, _dk, _msg, _ag,
  });

  _sb().initSidebarModule({
    ...sharedCtx,
    clearChat: (...a) => _ag().clearChat(...a),
    loadMessages: (...a) => _msg().loadMessages(...a),
    loadDeskFiles: (...a) => _dk().loadDeskFiles(...a),
    requestStreamResume: (...a) => _ws().requestStreamResume(...a),
    updateFolderButton: (...a) => _dk().updateFolderButton(...a),
    renderWelcomeAgentSelector: (...a) => _ag().renderWelcomeAgentSelector(...a),
    loadAvatars: (...a) => _ag().loadAvatars(...a),
  });
}

// ── 初始化 ──
async function init() {
  state.serverPort = await platform.getServerPort();
  state.serverToken = await platform.getServerToken();
  if (!state.serverPort) {
    _ui().setStatus(t("status.serverNotReady"), false);
    platform.appReady();
    return;
  }

  initModules();

  try {
    const [healthRes, configRes] = await Promise.all([
      hanaFetch(`/api/health`),
      hanaFetch(`/api/config`),
    ]);
    const healthData = await healthRes.json();
    const configData = await configRes.json();
    await i18n.load(configData.locale || "zh-CN");
    await _ag().applyAgentIdentity({
      agentName: healthData.agent || "Hanako",
      userName: healthData.user || "用户",
      ui: { avatars: false, agents: false, welcome: true },
    });
    state.homeFolder = configData.desk?.home_folder || null;
    state.selectedFolder = state.homeFolder || null;
    if (Array.isArray(configData.cwd_history)) {
      state.cwdHistory = configData.cwd_history;
    }
    _ui().applyStaticI18n();
  } catch (err) {
    console.error("[init] i18n/health/config failed:", err);
  }

  await _ag().loadAvatars();

  const _inp = () => window.HanaModules.appInput;

  _ws().connectWS();
  await _ui().loadModels();

  state.pendingNewSession = true;
  await _ag().loadAgents();
  await _sb().loadSessions();
  _ag().renderWelcomeAgentSelector();

  _sb().initSidebar();
  _sb().initSidebarResize();

  $("#memoryToggleBtn")?.addEventListener("click", () => _dk().toggleMemory());
  _dk().updateMemoryToggle();

  _ui().initScrollListener();
  _dk().initJian();

  _inp().initDragDrop();

  _ch().initChannels({
    state, $: (sel) => document.querySelector(sel),
    hanaFetch, hanaUrl, md,
    showContextMenu: (...a) => _dk().showContextMenu(...a),
    toggleSidebar: (...a) => _sb().toggleSidebar(...a),
    toggleJianSidebar: (...a) => _dk().toggleJianSidebar(...a),
    updateTbToggleState: (...a) => _sb().updateTbToggleState(...a),
    yuanFallbackAvatar: (...a) => _ag().yuanFallbackAvatar(...a),
  });

  _sb().updateLayout();

  // 浮动面板按钮
  $("#activityBar")?.addEventListener("click", () => {
    if (isActivityVisible()) hideActivityPanel();
    else showActivityPanel();
  });
  $("#automationBar")?.addEventListener("click", () => {
    if (isAutomationVisible()) hideAutomationPanel();
    else showAutomationPanel();
  });
  $("#bridgeBar")?.addEventListener("click", () => {
    if (state.activePanel === "bridge") _setPanel(null);
    else _setPanel("bridge");
  });

  loadAutomationBadge();

  $("#browserBgBar")?.addEventListener("click", () => {
    platform?.openBrowserViewer?.();
  });

  if (settingsBtn) settingsBtn.addEventListener("click", () => platform.openSettings());

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ",") {
      e.preventDefault();
      platform.openSettings();
    }
  });

  platform.onSettingsChanged((type, data) => {
    switch (type) {
      case "agent-switched":
        _ag().applyAgentIdentity({
          agentName: data.agentName,
          agentId: data.agentId,
        });
        _sb().loadSessions();
        window.__loadDeskSkills?.();
        break;
      case "skills-changed":
        window.__loadDeskSkills?.();
        break;
      case "locale-changed":
        i18n.load(data.locale).then(() => {
          i18n.defaultName = state.agentName;
          _ui().applyStaticI18n();
        });
        break;
      case "models-changed":
        _ui().loadModels();
        break;
      case "agent-created":
      case "agent-deleted":
        _ag().loadAgents();
        _ag().renderWelcomeAgentSelector();
        break;
      case "agent-updated":
        _ag().applyAgentIdentity({
          agentName: data.agentName,
          agentId: data.agentId,
          ui: { settings: false },
        });
        break;
      case "theme-changed":
        setTheme(data.theme);
        break;
      case "font-changed":
        setSerifFont(data.serif);
        break;
    }
  });

  platform.appReady();
}

// ── 启动 ──
loadSavedTheme();
loadSavedFont();

window.__hanaInit = init;
if (!window.__REACT_MANAGED) {
  init().catch((err) => {
    console.error("[init] 初始化异常:", err);
    platform?.appReady?.();
  });
}
