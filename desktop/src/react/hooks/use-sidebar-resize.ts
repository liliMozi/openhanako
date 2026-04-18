/**
 * useSidebarResize — 侧边栏宽度拖拽调整
 *
 * 从 sidebar-shim.ts 的 initSidebarResize 迁移。
 * 在 useEffect 中绑定 mousedown 事件，管理三个 resize handle。
 */

import { useEffect, useRef } from 'react';

export function useSidebarResize(): void {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const root = document.documentElement;
    const sidebarEl = document.getElementById('sidebar');
    const jianSidebarEl = document.getElementById('jianSidebar');
    const leftHandle = document.getElementById('sidebarResizeHandle');
    const rightHandle = document.getElementById('jianResizeHandle');
    const previewPanel = document.getElementById('previewPanel');

    const LEFT_MIN = 180, LEFT_MAX = 400;
    const RIGHT_MIN = 200, RIGHT_MAX = 600;
    const PREVIEW_MIN = 320, PREVIEW_MAX = 800;

    const leftInner = sidebarEl?.querySelector('.sidebar-inner') as HTMLElement | null;
    const rightInner = jianSidebarEl?.querySelector('.jian-sidebar-inner') as HTMLElement | null;
    const previewInner = previewPanel?.querySelector('.preview-panel-inner') as HTMLElement | null;

    function applySidebarWidth(w: number): void {
      const px = w + 'px';
      root.style.setProperty('--sidebar-width', px);
      if (leftInner) { leftInner.style.width = px; leftInner.style.minWidth = px; }
    }

    function updateJianColumns(w: number): void {
      const cols = w > 520 ? 3 : w > 350 ? 2 : 1;
      root.style.setProperty('--jian-columns', String(cols));
    }

    function applyJianWidth(w: number): void {
      const px = w + 'px';
      root.style.setProperty('--jian-sidebar-width', px);
      if (rightInner) { rightInner.style.width = px; rightInner.style.minWidth = px; }
      updateJianColumns(w);
    }

    function applyPreviewWidth(w: number): void {
      const px = w + 'px';
      root.style.setProperty('--preview-panel-width', px);
      if (previewInner) { previewInner.style.width = px; previewInner.style.minWidth = px; }
    }

    // 恢复保存的宽度
    const savedLeft = localStorage.getItem('hana-sidebar-width');
    const savedRight = localStorage.getItem('hana-jian-width');
    const savedPreview = localStorage.getItem('hana-preview-width');
    if (savedLeft) applySidebarWidth(Number(savedLeft));
    if (savedRight) applyJianWidth(Number(savedRight));
    if (savedPreview) applyPreviewWidth(Number(savedPreview));

    function setupHandle(
      handle: HTMLElement | null,
      getSidebar: () => HTMLElement | null,
      getWidth: () => number,
      setWidth: (w: number) => void,
      min: number,
      max: number,
      storageKey: string,
      isRight: boolean,
    ): void {
      if (!handle) return;

      handle.addEventListener('mousemove', (e: MouseEvent) => {
        const rect = handle.getBoundingClientRect();
        handle.style.setProperty('--handle-y', (e.clientY - rect.top) + 'px');
      });
      handle.addEventListener('mouseleave', () => {
        handle.style.setProperty('--handle-y', '-999px');
      });

      handle.addEventListener('mousedown', (e: MouseEvent) => {
        e.preventDefault();
        const sidebarTarget = getSidebar();
        if (!sidebarTarget || sidebarTarget.classList.contains('collapsed')) return;

        const startX = e.clientX;
        const startW = getWidth();
        handle.classList.add('active');
        document.body.classList.add('resizing');

        function onMove(e: MouseEvent): void {
          const delta = isRight ? startX - e.clientX : e.clientX - startX;
          const w = Math.max(min, Math.min(max, startW + delta));
          setWidth(w);
          const rect = handle!.getBoundingClientRect();
          handle!.style.setProperty('--handle-y', (e.clientY - rect.top) + 'px');
        }

        function onUp(): void {
          handle!.classList.remove('active');
          document.body.classList.remove('resizing');
          handle!.style.setProperty('--handle-y', '-999px');
          const w = getWidth();
          localStorage.setItem(storageKey, String(w));
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    setupHandle(
      leftHandle,
      () => sidebarEl,
      () => sidebarEl?.offsetWidth || 240,
      (w) => applySidebarWidth(w),
      LEFT_MIN, LEFT_MAX, 'hana-sidebar-width', false,
    );

    setupHandle(
      rightHandle,
      () => jianSidebarEl,
      () => jianSidebarEl?.offsetWidth || 260,
      (w) => applyJianWidth(w),
      RIGHT_MIN, RIGHT_MAX, 'hana-jian-width', true,
    );

    const previewHandle = document.getElementById('previewResizeHandle');
    setupHandle(
      previewHandle,
      () => previewPanel,
      () => previewPanel?.offsetWidth || 580,
      (w) => applyPreviewWidth(w),
      PREVIEW_MIN, PREVIEW_MAX, 'hana-preview-width', true,
    );
  }, []);
}
