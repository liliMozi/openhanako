/**
 * app-ui-shim.ts — 滚动 / 状态栏 / 错误显示 / 模型加载 / i18n
 *
 * Phase 6A: model selector / plan mode / todo display 移入 React InputArea，
 * 这里只保留滚动、连接状态、错误显示、模型数据加载、i18n。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

declare function t(key: string, vars?: Record<string, string>): any;

interface AppUiCtx {
  state: Record<string, any>;
  $: (sel: string) => HTMLElement | null;
  hanaFetch: (path: string, opts?: RequestInit) => Promise<Response>;
  escapeHtml: (s: string) => string;
  chatArea: HTMLElement;
  connectionStatus: HTMLElement;
  inputBox: HTMLTextAreaElement | null;
  settingsBtn: HTMLElement | null;
  _cr: () => Record<string, any>;
  _ag: () => Record<string, any>;
  _dk: () => Record<string, any>;
  _sb: () => Record<string, any>;
}

let ctx: AppUiCtx;

// ── 滚动 ──

let userScrolledUp = false;

function initScrollListener(): void {
  const { chatArea } = ctx;
  chatArea.addEventListener('scroll', () => {
    const threshold = 100;
    const atBottom = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < threshold;
    userScrolledUp = !atBottom;
  });
}

function scrollToBottom(): void {
  if (!userScrolledUp) {
    ctx.chatArea.scrollTop = ctx.chatArea.scrollHeight;
  }
}

function resetScroll(): void {
  userScrolledUp = false;
}

// ── 连接状态 ──

function setStatus(text: string, connected: boolean): void {
  const el = ctx.connectionStatus;
  const textEl = el.querySelector('.status-text');
  if (textEl) textEl.textContent = text;
  el.classList.toggle('connected', connected);
}

// ── 错误显示 ──

function showError(message: string): void {
  // 简易 toast 提示（不再操作聊天 DOM）
  console.error('[hana]', message);
  const toast = document.createElement('div');
  toast.className = 'hana-toast error';
  toast.textContent = `⚠ ${message}`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// ── 模型加载（数据 only，UI 由 React ModelSelector 渲染） ──

async function loadModels(): Promise<void> {
  const { state, hanaFetch } = ctx;
  try {
    const favRes = await hanaFetch('/api/models/favorites');
    const favData = await favRes.json();
    state.models = favData.models || [];
    state.currentModel = favData.current;
  } catch { /* silent */ }
}

// ── i18n 静态文本 ──

function applyStaticI18n(): void {
  const { state, $, settingsBtn } = ctx;

  const sidebarTitle = $('.sidebar-title');
  if (sidebarTitle) sidebarTitle.textContent = t('sidebar.title');
  const toggleLabel = $('.sidebar-toggle-label');
  if (toggleLabel) toggleLabel.textContent = t('sidebar.title');

  const activityBarLabel = $('#activityBarLabel');
  if (activityBarLabel) activityBarLabel.textContent = t('sidebar.activity');

  const newSessionBtn = $('#newSessionBtn');
  if (newSessionBtn) newSessionBtn.title = t('sidebar.newChat');
  if (settingsBtn) settingsBtn.title = t('settings.title');
  const bridgeBarLabel = $('#bridgeBarLabel');
  if (bridgeBarLabel) bridgeBarLabel.textContent = t('sidebar.bridge');

  const sidebarCollapseBtn = $('#sidebarCollapseBtn');
  if (sidebarCollapseBtn) sidebarCollapseBtn.title = t('sidebar.collapse');
  const tbToggleLeft = $('#tbToggleLeft');
  if (tbToggleLeft) tbToggleLeft.title = t('sidebar.expand');
  const tbToggleRight = $('#tbToggleRight');
  if (tbToggleRight) tbToggleRight.title = t('sidebar.jian') || '书桌';

  const dropText = $('.drop-text');
  if (dropText) dropText.textContent = t('drop.hint', { name: state.agentName });

  ctx._dk().updateMemoryToggle();

  const statusText = $('.status-text');
  if (statusText && !state.connected) statusText.textContent = t('status.connecting');

  ctx._dk().updateFolderButton();
}

// ── Setup ──

export function setupAppUiShim(modules: Record<string, unknown>): void {
  modules.appUi = {
    scrollToBottom,
    resetScroll,
    setStatus,
    showError,
    initScrollListener,
    loadModels,
    applyStaticI18n,
    initAppUi: (injected: AppUiCtx) => { ctx = injected; },
  };
}
