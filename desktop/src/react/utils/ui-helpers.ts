/**
 * ui-helpers.ts — 连接状态 / 错误提示 / 模型加载 / i18n
 *
 * 从 app-ui-shim.ts 迁移。不依赖 ctx 注入。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';

declare function t(key: string, vars?: Record<string, string>): any;

// ── 连接状态 ──

export function setStatus(text: string, connected: boolean): void {
  const el = document.getElementById('connectionStatus');
  if (!el) return;
  const textEl = el.querySelector('.status-text');
  if (textEl) textEl.textContent = text;
  el.classList.toggle('connected', connected);
}

// ── 错误显示 ──

export function showError(message: string): void {
  console.error('[hana]', message);
  const toast = document.createElement('div');
  toast.className = 'hana-toast error';
  toast.textContent = `\u26A0 ${message}`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// ── 模型加载 ──

export async function loadModels(): Promise<void> {
  try {
    const favRes = await hanaFetch('/api/models/favorites');
    const favData = await favRes.json();
    useStore.setState({
      models: favData.models || [],
      currentModel: favData.current,
    });
  } catch { /* silent */ }
}

// ── i18n 静态文本 ──

export function applyStaticI18n(): void {
  const s = useStore.getState();
  const $ = (sel: string) => document.querySelector(sel);

  const sidebarTitle = $('.sidebar-title');
  if (sidebarTitle) sidebarTitle.textContent = t('sidebar.title');
  const toggleLabel = $('.sidebar-toggle-label');
  if (toggleLabel) toggleLabel.textContent = t('sidebar.title');

  const activityBarLabel = document.getElementById('activityBarLabel');
  if (activityBarLabel) activityBarLabel.textContent = t('sidebar.activity');

  const newSessionBtn = document.getElementById('newSessionBtn');
  if (newSessionBtn) newSessionBtn.title = t('sidebar.newChat');
  const settingsBtn = document.getElementById('settingsBtn');
  if (settingsBtn) settingsBtn.title = t('settings.title');
  const bridgeBarLabel = document.getElementById('bridgeBarLabel');
  if (bridgeBarLabel) bridgeBarLabel.textContent = t('sidebar.bridge');

  const sidebarCollapseBtn = document.getElementById('sidebarCollapseBtn');
  if (sidebarCollapseBtn) sidebarCollapseBtn.title = t('sidebar.collapse');
  const tbToggleLeft = document.getElementById('tbToggleLeft');
  if (tbToggleLeft) tbToggleLeft.title = t('sidebar.expand');
  const tbToggleRight = document.getElementById('tbToggleRight');
  if (tbToggleRight) tbToggleRight.title = t('sidebar.jian') || '\u4E66\u684C';

  const dropText = $('.drop-text');
  if (dropText) dropText.textContent = t('drop.hint', { name: s.agentName });

  // updateMemoryToggle / updateFolderButton — no-ops (React-driven)

  const statusText = $('.status-text');
  if (statusText && !s.connected) statusText.textContent = t('status.connecting');
}
