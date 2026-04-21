/**
 * SidebarLayout — 侧边栏布局管理 React 组件
 *
 * 管理：sidebar 折叠/展开、responsive 自动收缩、
 * 键盘快捷键、按钮事件绑定。
 * 从 sidebar-shim.ts 的 initSidebar / updateLayout / toggleSidebar 迁移。
 */

import { useEffect, useRef } from 'react';
import { useStore } from '../stores';
import { createNewSession } from '../stores/session-actions';
import { closePreview } from '../stores/artifact-actions';

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
// 公开函数（bridge compat shim 也会调用）
// ══════════════════════════════════════════════════════

export function updateLayout(): void {
  const s = useStore.getState();
  const currentTab = s.currentTab;
  if (typeof currentTab === 'string' && currentTab.startsWith('plugin:')) return;
  const w = window.innerWidth;
  const leftW = s.sidebarOpen ? getSidebarWidth() : 0;
  const rightW = s.jianOpen ? getJianWidth() : 0;
  const previewW = s.previewOpen ? getPreviewWidth() : 0;
  const contentW = w - leftW - rightW - previewW;

  if (contentW < CHAT_MIN_WIDTH) {
    if (s.jianOpen) {
      useStore.setState({ jianOpen: false, jianAutoCollapsed: true });

      const newContentW = w - (s.sidebarOpen ? getSidebarWidth() : 0) - previewW;
      if (newContentW < CHAT_MIN_WIDTH && s.sidebarOpen) {
        useStore.setState({ sidebarOpen: false, sidebarAutoCollapsed: true });
      }
    } else if (s.sidebarOpen) {
      useStore.setState({ sidebarOpen: false, sidebarAutoCollapsed: true });
    }
  } else {
    if (s.sidebarAutoCollapsed) {
      const neededForLeft = getSidebarWidth();
      if (w - rightW - previewW - neededForLeft >= CHAT_MIN_WIDTH) {
        const tab = s.currentTab || 'chat';
        const savedLeft = localStorage.getItem(`hana-sidebar-${tab}`);
        if (savedLeft !== 'closed') {
          useStore.setState({ sidebarOpen: true, sidebarAutoCollapsed: false });
        }
      }
    }
    const s2 = useStore.getState();
    if (s2.jianAutoCollapsed) {
      const leftW2 = s2.sidebarOpen ? getSidebarWidth() : 0;
      const neededForRight = getJianWidth();
      if (w - leftW2 - previewW - neededForRight >= CHAT_MIN_WIDTH) {
        const tab2 = s2.currentTab || 'chat';
        const savedRight = localStorage.getItem(`hana-jian-${tab2}`);
        if (savedRight !== 'closed') {
          useStore.setState({ jianOpen: true, jianAutoCollapsed: false });
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

