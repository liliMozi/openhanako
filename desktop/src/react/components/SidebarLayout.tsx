/**
 * SidebarLayout — 侧边栏布局管理 React 组件
 *
 * 管理：sidebar 折叠/展开、responsive 自动收缩、
 * 键盘快捷键、按钮事件绑定。
 * 从 sidebar-shim.ts 的 initSidebar / updateLayout / toggleSidebar 迁移。
 */

import { useEffect, useRef } from 'react';
import { useStore } from '../stores';
import { hanaUrl } from '../hooks/use-hana-fetch';
import { createNewSession, switchSession } from '../stores/session-actions';
import { yuanFallbackAvatar } from '../utils/agent-helpers';
import { closePreview } from '../stores/artifact-actions';
import { toggleJianSidebar, saveJianContent } from '../stores/desk-actions';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CHAT_MIN_WIDTH = 400;

function getSidebarWidth(): number {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')) || 240;
}
function getJianWidth(): number {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--jian-sidebar-width')) || 260;
}
function getPreviewWidth(): number {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--preview-panel-width')) || 580;
}

// ══════════════════════════════════════════════════════
// DOM 操作辅助（sidebar 和 jian 的 collapsed class）
// ══════════════════════════════════════════════════════

function applySidebarDom(open: boolean): void {
  const sidebar = document.getElementById('sidebar');
  if (open) {
    sidebar?.classList.remove('collapsed');
  } else {
    sidebar?.classList.add('collapsed');
  }
}

export function applyTbToggleState(): void {
  const s = useStore.getState();
  const tbToggleLeft = document.getElementById('tbToggleLeft');
  const tbToggleRight = document.getElementById('tbToggleRight');
  tbToggleLeft?.classList.toggle('active', s.sidebarOpen);
  tbToggleRight?.classList.toggle('active', s.jianOpen);
  if (tbToggleRight) {
    tbToggleRight.title = s.currentTab === 'channels'
      ? ((window as any).t('channel.info'))
      : ((window as any).t('sidebar.jian') || '书桌');
  }
}

// ══════════════════════════════════════════════════════
// 公开函数（bridge compat shim 也会调用）
// ══════════════════════════════════════════════════════

export function updateLayout(): void {
  const s = useStore.getState();
  const w = window.innerWidth;
  const leftW = s.sidebarOpen ? getSidebarWidth() : 0;
  const rightW = s.jianOpen ? getJianWidth() : 0;
  const previewW = s.previewOpen ? getPreviewWidth() : 0;
  const contentW = w - leftW - rightW - previewW;

  if (contentW < CHAT_MIN_WIDTH) {
    if (s.jianOpen) {
      useStore.setState({ jianOpen: false, jianAutoCollapsed: true });
      document.getElementById('jianSidebar')?.classList.add('collapsed');
      applyTbToggleState();

      const newContentW = w - (s.sidebarOpen ? getSidebarWidth() : 0) - previewW;
      if (newContentW < CHAT_MIN_WIDTH && s.sidebarOpen) {
        useStore.setState({ sidebarOpen: false, sidebarAutoCollapsed: true });
        applySidebarDom(false);
        applyTbToggleState();
      }
    } else if (s.sidebarOpen) {
      useStore.setState({ sidebarOpen: false, sidebarAutoCollapsed: true });
      applySidebarDom(false);
      applyTbToggleState();
    }
  } else {
    if (s.sidebarAutoCollapsed) {
      const neededForLeft = getSidebarWidth();
      if (w - rightW - previewW - neededForLeft >= CHAT_MIN_WIDTH) {
        const tab = s.currentTab || 'chat';
        const savedLeft = localStorage.getItem(`hana-sidebar-${tab}`);
        if (savedLeft !== 'closed') {
          useStore.setState({ sidebarOpen: true, sidebarAutoCollapsed: false });
          applySidebarDom(true);
          applyTbToggleState();
        }
      }
    }
    // 重新读取 state（可能刚改了 sidebarOpen）
    const s2 = useStore.getState();
    if (s2.jianAutoCollapsed) {
      const leftW2 = s2.sidebarOpen ? getSidebarWidth() : 0;
      const neededForRight = getJianWidth();
      if (w - leftW2 - previewW - neededForRight >= CHAT_MIN_WIDTH) {
        const tab2 = s2.currentTab || 'chat';
        const savedRight = localStorage.getItem(`hana-jian-${tab2}`);
        if (savedRight !== 'closed') {
          useStore.setState({ jianOpen: true, jianAutoCollapsed: false });
          document.getElementById('jianSidebar')?.classList.remove('collapsed');
          applyTbToggleState();
        }
      }
    }
  }
}

export function toggleSidebar(forceOpen?: boolean): void {
  const s = useStore.getState();
  const open = forceOpen !== undefined ? forceOpen : !s.sidebarOpen;
  useStore.setState({ sidebarOpen: open });

  const tab = s.currentTab || 'chat';
  localStorage.setItem(`hana-sidebar-${tab}`, open ? 'open' : 'closed');

  if (forceOpen === undefined) {
    useStore.setState({ sidebarAutoCollapsed: false });
  }
  if (open) {
    hideFloatCard();
  }

  applySidebarDom(open);
  applyTbToggleState();
}

// ══════════════════════════════════════════════════════
// React 组件
// ══════════════════════════════════════════════════════

export function SidebarLayout() {
  const initDone = useRef(false);

  useEffect(() => {
    if (initDone.current) return;
    initDone.current = true;

    // 迁移 localStorage
    const legacy = localStorage.getItem('hana-sidebar');
    if (legacy && !localStorage.getItem('hana-sidebar-chat')) {
      localStorage.setItem('hana-sidebar-chat', legacy);
    }
    const savedOpen = localStorage.getItem('hana-sidebar-chat');
    const sidebarOpen = savedOpen !== 'closed';

    useStore.setState({
      sidebarOpen,
      sidebarAutoCollapsed: false,
      jianAutoCollapsed: false,
    });

    applySidebarDom(sidebarOpen);
    applyTbToggleState();

    // 按钮绑定
    document.getElementById('newSessionBtn')?.addEventListener('click', createNewSession);
    document.getElementById('folderSelectBtn')?.addEventListener('click', () => {
      // selectFolder — no-op (folder selection handled by WelcomeScreen)
    });
    document.getElementById('sidebarCollapseBtn')?.addEventListener('click', () => toggleSidebar());
    document.getElementById('tbToggleLeft')?.addEventListener('click', () => toggleSidebar());
    document.getElementById('tbToggleRight')?.addEventListener('click', () => {
      toggleJianSidebar();
    });

    // 浮动预览
    initFloatingPreview();

    // Preview 面板按钮
    document.getElementById('previewCloseBtn')?.addEventListener('click', () => {
      closePreview();
    });
    document.getElementById('previewCopyBtn')?.addEventListener('click', () => {
      const s = useStore.getState();
      const artifact = s.artifacts.find((a: any) => a.id === s.currentArtifactId);
      if (artifact) {
        navigator.clipboard.writeText(artifact.content).then(() => {
          const btn = document.getElementById('previewCopyBtn');
          if (btn) {
            btn.title = '已复制';
            setTimeout(() => { btn.title = '复制'; }, 1500);
          }
        });
      }
    });

    // Resize
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        updateLayout();
        resizeTimer = null;
      }, 50);
    };
    window.addEventListener('resize', onResize);

    // 键盘快捷键
    const onKeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        toggleSidebar();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        createNewSession();
      }
      if (e.key === 'Escape' && useStore.getState().previewOpen) {
        closePreview();
      }
    };
    document.addEventListener('keydown', onKeydown);

    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onKeydown);
    };
  }, []);

  // 不渲染任何 DOM，只提供行为
  return null;
}

// ══════════════════════════════════════════════════════
// 浮动卡片预览（保留 DOM 方式，逻辑从 sidebar-shim 原样搬入）
// ══════════════════════════════════════════════════════

let _floatCard: HTMLElement | null = null;
let _floatTimer: ReturnType<typeof setTimeout> | null = null;
let _floatEnterTimer: ReturnType<typeof setTimeout> | null = null;

function initFloatingPreview(): void {
  const tbLeft = document.getElementById('tbToggleLeft');
  const tbRight = document.getElementById('tbToggleRight');

  setupFloat(tbLeft, 'left', () => !useStore.getState().sidebarOpen, buildSessionList);
  setupFloat(tbRight, 'right', () => !useStore.getState().jianOpen, buildDeskList);
}

function setupFloat(
  trigger: HTMLElement | null,
  side: string,
  isCollapsed: () => boolean,
  buildContent: (card: HTMLElement) => void,
): void {
  if (!trigger) return;

  trigger.addEventListener('mouseenter', () => {
    if (!isCollapsed()) return;
    if (_floatTimer) clearTimeout(_floatTimer);
    if (_floatEnterTimer) clearTimeout(_floatEnterTimer);
    _floatEnterTimer = setTimeout(() => {
      if (!isCollapsed()) return;
      showFloatCard(trigger, side, buildContent);
    }, 500);
  });

  trigger.addEventListener('mouseleave', () => {
    if (_floatEnterTimer) clearTimeout(_floatEnterTimer);
    _floatTimer = setTimeout(hideFloatCard, 200);
  });
}

function showFloatCard(
  trigger: HTMLElement,
  side: string,
  buildContent: (card: HTMLElement) => void,
): void {
  hideFloatCard();
  const card = document.createElement('div');
  card.className = 'float-card float-card-' + side;
  buildContent(card);
  document.body.appendChild(card);

  const rect = trigger.getBoundingClientRect();
  card.style.top = (rect.bottom + 6) + 'px';
  if (side === 'left') {
    card.style.left = rect.left + 'px';
  } else {
    card.style.right = (window.innerWidth - rect.right) + 'px';
  }

  card.addEventListener('mouseenter', () => { if (_floatTimer) clearTimeout(_floatTimer); });
  card.addEventListener('mouseleave', hideFloatCard);
  _floatCard = card;

  requestAnimationFrame(() => card.classList.add('visible'));
}

export function hideFloatCard(): void {
  if (_floatEnterTimer) clearTimeout(_floatEnterTimer);
  if (_floatTimer) clearTimeout(_floatTimer);
  if (_floatCard) {
    _floatCard.remove();
    _floatCard = null;
  }
}

function buildSessionList(card: HTMLElement): void {
  const s = useStore.getState();
  const sessions = s.sessions || [];
  if (sessions.length === 0) {
    card.innerHTML = `<div class="float-card-empty">暂无对话</div>`;
    return;
  }
  const list = document.createElement('div');
  list.className = 'float-card-list';

  for (const sess of sessions.slice(0, 12)) {
    const item = document.createElement('div');
    item.className = 'float-card-item';
    if (sess.path === s.currentSessionPath) item.classList.add('active');

    const avatar = document.createElement('img') as HTMLImageElement;
    avatar.className = 'float-card-avatar';
    avatar.draggable = false;
    if (sess.agentId) {
      avatar.src = hanaUrl(`/api/agents/${sess.agentId}/avatar?t=${Date.now()}`);
      avatar.onerror = () => {
        avatar.onerror = null;
        const ag = s.agents.find((x: any) => x.id === sess.agentId);
        avatar.src = yuanFallbackAvatar(ag?.yuan);
      };
    } else {
      avatar.src = yuanFallbackAvatar(s.agentYuan);
    }
    item.appendChild(avatar);

    const text = document.createElement('span');
    text.className = 'float-card-item-text';
    text.textContent = sess.title || '新对话';
    item.appendChild(text);

    item.addEventListener('click', () => {
      hideFloatCard();
      switchSession(sess.path);
    });
    list.appendChild(item);
  }
  card.appendChild(list);

  const bar = document.createElement('div');
  bar.className = 'float-card-bar';

  const newBtn = document.createElement('div');
  newBtn.className = 'float-card-bar-btn';
  newBtn.textContent = '+ ' + (window as any).t('sidebar.newChat');
  newBtn.addEventListener('click', () => {
    hideFloatCard();
    createNewSession();
  });
  bar.appendChild(newBtn);

  const divider = document.createElement('span');
  divider.className = 'float-card-bar-divider';
  bar.appendChild(divider);

  const settingsBtn = document.createElement('div');
  settingsBtn.className = 'float-card-bar-btn float-card-bar-icon';
  settingsBtn.title = (window as any).t('settings.title');
  settingsBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;
  settingsBtn.addEventListener('click', () => {
    hideFloatCard();
    (window as any).platform?.openSettings();
  });
  bar.appendChild(settingsBtn);

  card.appendChild(bar);
}

function buildDeskList(card: HTMLElement): void {
  const s = useStore.getState();
  const files = s.deskFiles || [];
  if (files.length === 0) {
    card.innerHTML = `<div class="float-card-empty">书桌为空</div>`;
  } else {
    const list = document.createElement('div');
    list.className = 'float-card-list';
    for (const f of files.slice(0, 12)) {
      const item = document.createElement('div');
      item.className = 'float-card-item';
      if (f.isDir) item.classList.add('is-dir');
      item.textContent = f.isDir ? `${f.name}/` : f.name;
      list.appendChild(item);
    }
    card.appendChild(list);
  }

  const jianWrap = document.createElement('div');
  jianWrap.className = 'float-card-jian';
  const jianLabel = document.createElement('div');
  jianLabel.className = 'float-card-jian-label';
  jianLabel.textContent = '笺';
  jianWrap.appendChild(jianLabel);

  const textarea = document.createElement('textarea');
  textarea.className = 'float-card-jian-input';
  textarea.placeholder = '写点什么…';
  textarea.spellcheck = false;
  textarea.value = s.deskJianContent || '';

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  textarea.addEventListener('input', () => {
    useStore.setState({ deskJianContent: textarea.value });
    const mainTextarea = document.getElementById('jianEditorInput') as HTMLTextAreaElement | null;
    if (mainTextarea) mainTextarea.value = textarea.value;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveJianContent();
    }, 800);
  });

  jianWrap.appendChild(textarea);
  card.appendChild(jianWrap);
}
