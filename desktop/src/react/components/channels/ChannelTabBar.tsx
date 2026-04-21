/**
 * ChannelTabBar — dynamic tab bar (chat / channels / plugin tabs)
 *
 * Renders tabs dynamically from store state, supports drag-to-reorder
 * for non-chat tabs, and overflows into a dropdown when >5 draggable tabs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import type { TabType, PluginPageInfo } from '../../types';
import { toggleSidebar } from '../SidebarLayout';
import { toggleJianSidebar } from '../../stores/desk-actions';
import { resolvePluginTitle } from '../../utils/resolve-plugin-title';
import { reorderTabs, hidePluginTab, showPluginTab } from '../../stores/plugin-ui-actions';
import { PluginTabOverflow } from '../plugin/PluginTabOverflow';
import { ContextMenu, type ContextMenuItem } from '../ContextMenu';
import styles from './Channels.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

const MAX_VISIBLE_DRAGGABLE = 5;

// ── Tab switching logic ──

export function switchTab(tab: TabType) {
  const s = useStore.getState();
  if (tab === s.currentTab) return;

  if (tab === 'channels') {
    s.setActivePanel(null);
  }

  s.setCurrentTab(tab);
  localStorage.setItem('hana-tab', tab);

  // Plugin tabs don't have sidebar persistence
  if (typeof tab === 'string' && tab.startsWith('plugin:')) return;

  const savedLeft = localStorage.getItem(`hana-sidebar-${tab}`);
  const wantLeftOpen = savedLeft !== 'closed';
  if (s.sidebarOpen !== wantLeftOpen) toggleSidebar(wantLeftOpen);

  const savedRight = localStorage.getItem(`hana-jian-${tab}`);
  const wantRightOpen = savedRight !== 'closed';
  if (s.jianOpen !== wantRightOpen) toggleJianSidebar(wantRightOpen);
}

// ── Build ordered tab list ──

function buildTabList(pluginPages: PluginPageInfo[], tabOrder: string[]): TabType[] {
  const pluginTabs: TabType[] = pluginPages.map(p => `plugin:${p.pluginId}` as TabType);
  const draggable: TabType[] = ['channels' as TabType, ...pluginTabs];

  // Order by user preference, with unordered at end
  const ordered: TabType[] = [];
  for (const id of tabOrder) {
    if (draggable.includes(id as TabType)) ordered.push(id as TabType);
  }
  for (const tab of draggable) {
    if (!ordered.includes(tab)) ordered.push(tab);
  }

  return ['chat' as TabType, ...ordered];
}

function getTabLabel(tab: TabType, pluginPages: PluginPageInfo[], locale: string): string {
  if (tab === 'chat') return t('channel.chatTab');
  if (tab === 'channels') return t('channel.tab');
  if (typeof tab === 'string' && tab.startsWith('plugin:')) {
    const pluginId = tab.slice(7);
    const page = pluginPages.find(p => p.pluginId === pluginId);
    if (page) return resolvePluginTitle(page.title, locale, pluginId);
    return pluginId;
  }
  return tab;
}

// ── Component ──

interface MenuState { items: ContextMenuItem[]; position: { x: number; y: number } }

export function ChannelTabBar() {
  const currentTab = useStore(s => s.currentTab);
  const channelTotalUnread = useStore(s => s.channelTotalUnread);
  const locale = useStore(s => s.locale);
  const pluginPages = useStore(s => s.pluginPages);
  const tabOrder = useStore(s => s.tabOrder);
  const hiddenPluginTabs = useStore(s => s.hiddenPluginTabs);
  const [menu, setMenu] = useState<MenuState | null>(null);

  // Filter out hidden plugin tabs
  const visiblePages = pluginPages.filter(p => !hiddenPluginTabs.includes(p.pluginId));
  const hiddenPages = pluginPages.filter(p => hiddenPluginTabs.includes(p.pluginId));

  const allTabs = buildTabList(visiblePages, tabOrder);
  // chat is always first and not draggable; split into visible and overflow
  const draggableTabs = allTabs.slice(1);
  const visibleDraggable = draggableTabs.slice(0, MAX_VISIBLE_DRAGGABLE);
  const overflowDraggable = draggableTabs.slice(MAX_VISIBLE_DRAGGABLE);
  const visibleTabs: TabType[] = ['chat' as TabType, ...visibleDraggable];

  const tabsRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // Drag state
  const [dragTab, setDragTab] = useState<TabType | null>(null);
  const [dragOverTab, setDragOverTab] = useState<TabType | null>(null);

  const setBtnRef = useCallback((tab: TabType, el: HTMLButtonElement | null) => {
    if (el) btnRefs.current.set(tab, el);
    else btnRefs.current.delete(tab);
  }, []);

  const moveSlider = useCallback((tab: TabType, animate: boolean) => {
    const container = tabsRef.current;
    const slider = sliderRef.current;
    const target = btnRefs.current.get(tab);
    if (!slider || !container) return;
    if (!target) {
      // Active tab is in overflow; hide slider
      slider.style.width = '0px';
      slider.style.transform = 'translateX(0px)';
      return;
    }
    const parentRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const offsetX = targetRect.left - parentRect.left;
    if (!animate) slider.style.transition = 'none';
    slider.style.width = targetRect.width + 'px';
    slider.style.transform = `translateX(${offsetX - 2}px)`;
    if (!animate) requestAnimationFrame(() => { slider.style.transition = ''; });
  }, []);

  useEffect(() => { moveSlider(currentTab, true); }, [currentTab, moveSlider]);
  useEffect(() => { moveSlider(useStore.getState().currentTab || 'chat', false); }, [locale, moveSlider]);
  // Initial position after mount
  useEffect(() => {
    requestAnimationFrame(() => moveSlider(useStore.getState().currentTab || 'chat', false));
  }, [moveSlider, pluginPages, tabOrder]);

  // Restore saved tab on mount
  useEffect(() => {
    const savedTab = localStorage.getItem('hana-tab');
    if (savedTab && savedTab !== 'chat') switchTab(savedTab as TabType);
  }, []);

  const handleTabClick = useCallback((tab: TabType) => {
    switchTab(tab);
  }, []);

  const handleTabContextMenu = useCallback((e: React.MouseEvent, tab: TabType) => {
    // Only plugin tabs can be hidden
    if (typeof tab !== 'string' || !tab.startsWith('plugin:')) return;
    e.preventDefault();
    const label = getTabLabel(tab, pluginPages, locale);
    setMenu({
      position: { x: e.clientX, y: e.clientY },
      items: [{ label: `取消固定「${label}」`, action: () => hidePluginTab(tab) }],
    });
  }, [pluginPages, locale]);

  // ── Drag handlers ──

  const onDragStart = useCallback((e: React.DragEvent, tab: TabType) => {
    if (tab === 'chat') { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tab);
    setDragTab(tab);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent, tab: TabType) => {
    if (tab === 'chat') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverTab(tab);
  }, []);

  const onDragLeave = useCallback(() => {
    setDragOverTab(null);
  }, []);

  const onDrop = useCallback((e: React.DragEvent, targetTab: TabType) => {
    e.preventDefault();
    setDragTab(null);
    setDragOverTab(null);
    const sourceTab = e.dataTransfer.getData('text/plain') as TabType;
    if (!sourceTab || sourceTab === targetTab || targetTab === 'chat') return;

    // Compute new order from current draggable list
    const currentDraggable = [...draggableTabs];
    const srcIdx = currentDraggable.indexOf(sourceTab);
    if (srcIdx === -1) return;

    // Remove source, then find target position in the mutated array
    currentDraggable.splice(srcIdx, 1);
    const insertIdx = currentDraggable.indexOf(targetTab);
    if (insertIdx === -1) {
      currentDraggable.push(sourceTab);
    } else {
      currentDraggable.splice(insertIdx, 0, sourceTab);
    }

    reorderTabs(currentDraggable);
  }, [draggableTabs]);

  const onDragEnd = useCallback(() => {
    setDragTab(null);
    setDragOverTab(null);
  }, []);

  // Overflow items: tabs that don't fit + hidden plugin tabs (with pin action)
  const overflowItems = [
    ...overflowDraggable.map(tab => ({
      id: tab,
      label: getTabLabel(tab, pluginPages, locale),
    })),
    ...hiddenPages.map(p => ({
      id: `plugin:${p.pluginId}` as TabType,
      label: `${resolvePluginTitle(p.title, locale, p.pluginId)}`,
      hidden: true,
    })),
  ];

  return (
    <div className={styles.tbTabs} ref={tabsRef}>
      <div className={styles.tbTabsSlider} ref={sliderRef}></div>
      {visibleTabs.map(tab => {
        const isActive = currentTab === tab;
        const isDragging = dragTab === tab;
        const isDragOver = dragOverTab === tab;
        let cls = styles.tbTab;
        if (isActive) cls += ` ${styles.tbTabActive}`;
        if (isDragging) cls += ` ${styles.tbTabDragging}`;
        if (isDragOver) cls += ` ${styles.tbTabDragOver}`;

        return (
          <button
            key={tab}
            ref={(el) => setBtnRef(tab, el)}
            className={cls}
            data-tab={tab}
            draggable={tab !== 'chat'}
            onClick={() => handleTabClick(tab)}
            onContextMenu={(e) => handleTabContextMenu(e, tab)}
            onDragStart={(e) => onDragStart(e, tab)}
            onDragOver={(e) => onDragOver(e, tab)}
            onDragLeave={onDragLeave}
            onDrop={(e) => onDrop(e, tab)}
            onDragEnd={onDragEnd}
          >
            {getTabLabel(tab, pluginPages, locale)}
            {tab === 'channels' && channelTotalUnread > 0 && <span className={styles.tbTabBadge} />}
          </button>
        );
      })}
      {overflowItems.length > 0 && (
        <PluginTabOverflow
          tabs={overflowItems}
          currentTab={currentTab}
          onSelect={(tab) => {
            const isHidden = hiddenPages.some(p => `plugin:${p.pluginId}` === tab);
            if (isHidden) showPluginTab(tab);
            handleTabClick(tab);
          }}
          onPin={(tab) => showPluginTab(tab)}
          onContextMenu={(e, tab) => {
            if (typeof tab !== 'string' || !tab.startsWith('plugin:')) return;
            e.preventDefault();
            const label = getTabLabel(tab, pluginPages, locale);
            setMenu({
              position: { x: e.clientX, y: e.clientY },
              items: [{ label: `取消固定「${label}」`, action: () => hidePluginTab(tab) }],
            });
          }}
        />
      )}
      {menu && <ContextMenu items={menu.items} position={menu.position} onClose={() => setMenu(null)} />}
    </div>
  );
}
