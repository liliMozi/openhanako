/**
 * React 迁移兼容层（Phase 3 shims）
 * 必须在 app.js 之前加载，在所有 modules/ 之前
 *
 * 1. 设置 __REACT_MANAGED 标志（替代被 CSP 挡住的 inline script）
 * 2. 注册已迁移模块的兼容 shim（activity, bridge），防止旧代码解构 crash
 *    React mount 后 bridge.ts 会覆盖这些 shim 为 Zustand 驱动的版本
 */

window.__REACT_MANAGED = true;

// 确保 HanaModules 存在
window.HanaModules = window.HanaModules || {};

// activity.js shim（Phase 3a 迁移到 React）
// sidebar.js switchSession / createNewSession 会调用这些
if (!window.HanaModules.activity) {
  var _activePanel = null;
  window.HanaModules.activity = {
    isActivityVisible: function() { return _activePanel === 'activity'; },
    hideActivityPanel: function() { _activePanel = null; },
    closeActivityDetail: function() {},
    isAutomationVisible: function() { return _activePanel === 'automation'; },
    hideAutomationPanel: function() { _activePanel = null; },
  };
}

// bridge.js shim（Phase 3b 迁移到 React）
if (!window.HanaModules.bridge) {
  window.HanaModules.bridge = {
    isBridgeVisible: function() { return false; },
    hideBridgePanel: function() {},
  };
}

// artifacts.js shim（Phase 3c 迁移到 React）
// app.js 顶部会解构这些，必须在 app.js 加载前注册
if (!window.HanaModules.artifacts) {
  window.HanaModules.artifacts = {
    handleArtifact: function() {},
    appendArtifactCard: function() {},
    renderBrowserCard: function() {},
    appendBrowserScreenshot: function() {},
    openPreview: function() {},
    closePreview: function() {},
    initArtifacts: function() {},
  };
}

// file-cards.js shim（Phase 3c 迁移到 React）
if (!window.HanaModules.fileCards) {
  window.HanaModules.fileCards = {
    PREVIEWABLE_EXTS: {},
    BINARY_PREVIEW_TYPES: new Set(),
    readFileForPreview: function() { return null; },
    appendFileCard: function() {},
    appendSkillCard: function() {},
    initFileCards: function() {},
  };
}

// desk.js shim（Phase 3d 迁移到 React）
// app.js 顶部会解构这些，必须在 app.js 加载前注册
if (!window.HanaModules.desk) {
  var _noop = function() {};
  window.HanaModules.desk = {
    initJian: _noop, toggleJianSidebar: _noop,
    loadDeskFiles: _noop, renderDeskFiles: _noop,
    deskFullPath: function() { return null; },
    deskCurrentDir: function() { return null; },
    showContextMenu: _noop, hideContextMenu: _noop,
    toggleMemory: _noop, updateMemoryToggle: _noop,
    selectFolder: _noop, applyFolder: _noop,
    updateFolderButton: _noop, updateDeskContextBtn: _noop,
    saveJianContent: _noop,
    initDesk: _noop,
  };
}

// chat-render.js shim（Phase 3e 迁移到 bridge.ts）
// app.js 顶部会解构这些，必须在 app.js 加载前注册
if (!window.HanaModules.chatRender) {
  var _crNoop = function() {};
  window.HanaModules.chatRender = {
    ensureGroup: _crNoop, addUserMessage: _crNoop,
    ensureAssistantMessage: _crNoop, ensureTextEl: _crNoop,
    finishAssistantTurn: _crNoop, finishAssistantMessage: _crNoop,
    showThinking: _crNoop, hideThinking: _crNoop, sealThinking: _crNoop,
    addToolToGroup: _crNoop, updateToolInGroup: _crNoop, sealToolGroup: _crNoop,
    initChatRender: _crNoop,
  };
}

// sidebar.js shim（Phase 3f 迁移到 shims/sidebar-shim.ts）
// app.js 顶部会解构这些，必须在 app.js 加载前注册
if (!window.HanaModules.sidebar) {
  var _sbNoop = function() {};
  window.HanaModules.sidebar = {
    loadSessions: _sbNoop, renderSessionList: _sbNoop, switchSession: _sbNoop,
    createNewSession: _sbNoop, ensureSession: function() { return true; },
    archiveSession: _sbNoop,
    toggleSidebar: _sbNoop, updateTbToggleState: _sbNoop, updateLayout: _sbNoop,
    initSidebar: _sbNoop, initSidebarResize: _sbNoop,
    initSidebarModule: _sbNoop, dismissFloat: _sbNoop,
  };
}

// channels.js shim（Phase 3f 迁移到 shims/channels-shim.ts）
// app.js 顶部会解构这些，必须在 app.js 加载前注册
if (!window.HanaModules.channels) {
  var _chNoop = function() {};
  window.HanaModules.channels = {
    initChannels: _chNoop, switchTab: _chNoop,
    loadChannels: _chNoop, updateChannelTabBadge: _chNoop,
    renderChannelList: _chNoop, renderChannelMessages: _chNoop,
    openChannel: _chNoop,
  };
}

// app.js 分解 shim（Phase 4 迁移到 shims/app-*-shim.ts）

if (!window.HanaModules.appMessages) {
  var _amNoop = function() {};
  window.HanaModules.appMessages = {
    cleanMoodText: function(s) { return s; },
    moodLabel: function() { return ''; },
    parseMoodFromContent: function(c) { return { mood: null, yuan: null, text: c || '' }; },
    appendCronConfirmCard: _amNoop,
    parseUserAttachments: function() { return { text: '', files: [], deskContext: null }; },
    loadMessages: _amNoop,
    initAppMessages: _amNoop,
  };
}

if (!window.HanaModules.appAgents) {
  var _aaNoop = function() {};
  window.HanaModules.appAgents = {
    yuanFallbackAvatar: function() { return 'assets/Hanako.png'; },
    randomWelcome: function() { return ''; },
    yuanPlaceholder: function() { return ''; },
    renderWelcomeAgentSelector: _aaNoop,
    clearChat: _aaNoop,
    applyAgentIdentity: _aaNoop,
    loadAgents: _aaNoop,
    loadAvatars: _aaNoop,
    initAppAgents: _aaNoop,
  };
}

if (!window.HanaModules.appInput) {
  var _aiNoop = function() {};
  window.HanaModules.appInput = {
    sendMessage: _aiNoop, stopGeneration: _aiNoop,
    autoResize: _aiNoop, renderAttachedFiles: _aiNoop,
    initInputListeners: _aiNoop, initDragDrop: _aiNoop,
    initDeskContextBtn: _aiNoop, initAppInput: _aiNoop,
    getAttachedCount: function() { return 0; },
    getDeskContextAttached: function() { return false; },
    setDeskContextAttached: _aiNoop,
  };
}

if (!window.HanaModules.appWs) {
  var _awNoop = function() {};
  window.HanaModules.appWs = {
    connectWS: _awNoop, handleServerMessage: _awNoop,
    requestStreamResume: _awNoop, applyStreamingStatus: _awNoop,
    initAppWs: _awNoop,
  };
}

if (!window.HanaModules.appUi) {
  var _auNoop = function() {};
  window.HanaModules.appUi = {
    scrollToBottom: _auNoop, resetScroll: _auNoop,
    setStatus: _auNoop, showError: _auNoop,
    initScrollListener: _auNoop, loadModels: _auNoop,
    applyStaticI18n: _auNoop, initAppUi: _auNoop,
  };
}
