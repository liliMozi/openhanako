/**
 * ChannelTabBar — tab 切换栏（chat/channels tab）
 *
 * 管理 titlebar 中 tab 的点击、slider 动画和 badge 显示。
 */

import { useCallback, useEffect, useRef } from 'react';
import { useStore } from '../../stores';
import type { TabType } from '../../types';
import { toggleSidebar } from '../SidebarLayout';
import { toggleJianSidebar } from '../../stores/desk-actions';
import styles from './Channels.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

// ── Tab switching logic ──

export function switchTab(tab: TabType) {
  const s = useStore.getState();
  if (tab === s.currentTab) return;

  if (tab === 'channels') {
    s.setActivePanel(null);
  }

  s.setCurrentTab(tab);
  localStorage.setItem('hana-tab', tab);

  const savedLeft = localStorage.getItem(`hana-sidebar-${tab}`);
  const wantLeftOpen = savedLeft !== 'closed';
  if (s.sidebarOpen !== wantLeftOpen) toggleSidebar(wantLeftOpen);

  const savedRight = localStorage.getItem(`hana-jian-${tab}`);
  const wantRightOpen = savedRight !== 'closed';
  if (s.jianOpen !== wantRightOpen) toggleJianSidebar(wantRightOpen);
}

// ── Component ──

export function ChannelTabBar() {
  const currentTab = useStore(s => s.currentTab);
  const channelTotalUnread = useStore(s => s.channelTotalUnread);
  const locale = useStore(s => s.locale);

  const tabsRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const chatTabRef = useRef<HTMLButtonElement>(null);
  const channelsTabRef = useRef<HTMLButtonElement>(null);

  const moveSlider = useCallback((tab: TabType, animate: boolean) => {
    const container = tabsRef.current;
    const slider = sliderRef.current;
    const target = tab === 'chat' ? chatTabRef.current : channelsTabRef.current;
    if (!slider || !target || !container) return;
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
  useEffect(() => { moveSlider(useStore.getState().currentTab || 'chat', false); }, [moveSlider]);

  // Restore saved tab on mount
  useEffect(() => {
    const savedTab = localStorage.getItem('hana-tab');
    if (savedTab === 'channels') switchTab('channels');
  }, []);

  const handleTabClick = useCallback((e: React.MouseEvent) => {
    const tabBtn = (e.target as HTMLElement).closest(`.${styles.tbTab}`) as HTMLElement | null;
    if (!tabBtn) return;
    switchTab((tabBtn.dataset.tab || 'chat') as TabType);
  }, []);

  return (
    <div className={styles.tbTabs} ref={tabsRef} onClick={handleTabClick}>
      <div className={styles.tbTabsSlider} ref={sliderRef}></div>
      <button ref={chatTabRef} className={`${styles.tbTab}${currentTab === 'chat' ? ` ${styles.tbTabActive}` : ''}`} data-tab="chat">
        {t('channel.chatTab')}
      </button>
      <button ref={channelsTabRef} className={`${styles.tbTab}${currentTab === 'channels' ? ` ${styles.tbTabActive}` : ''}`} data-tab="channels">
        {t('channel.tab')}
        {channelTotalUnread > 0 && <span className={styles.tbTabBadge} />}
      </button>
    </div>
  );
}
