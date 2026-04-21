/**
 * PluginTabOverflow — overflow dropdown for excess tabs in ChannelTabBar.
 *
 * Shows a "more" button that opens a dropdown listing tabs that don't fit
 * in the visible tab bar area, plus hidden (unpinned) plugin tabs.
 */

import { useState, useRef, useEffect } from 'react';
import type { TabType } from '../../types';
import s from './PluginTabOverflow.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

interface TabItem {
  id: TabType;
  label: string;
  hidden?: boolean;
}

interface Props {
  tabs: TabItem[];
  currentTab: TabType;
  onSelect: (tab: TabType) => void;
  onPin?: (tab: TabType) => void;
  onContextMenu?: (e: React.MouseEvent, tab: TabType) => void;
}

export function PluginTabOverflow({ tabs, currentTab, onSelect, onPin, onContextMenu }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  if (tabs.length === 0) return null;

  const hasActive = tabs.some(tab => tab.id === currentTab);
  const normalTabs = tabs.filter(tab => !tab.hidden);
  const hiddenTabs = tabs.filter(tab => tab.hidden);

  return (
    <div className={s.overflowWrap} ref={wrapRef}>
      <button
        className={`${s.overflowBtn}${open || hasActive ? ` ${s.overflowBtnActive}` : ''}`}
        title={t('channel.moreTabs')}
        onClick={() => setOpen(v => !v)}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className={s.dropdown}>
          {normalTabs.map(tab => (
            <button
              key={tab.id}
              className={`${s.dropdownItem}${tab.id === currentTab ? ` ${s.dropdownItemActive}` : ''}`}
              onClick={() => { onSelect(tab.id); setOpen(false); }}
              onContextMenu={(e) => { onContextMenu?.(e, tab.id); setOpen(false); }}
            >
              {tab.label}
            </button>
          ))}
          {hiddenTabs.length > 0 && normalTabs.length > 0 && (
            <div className={s.divider} />
          )}
          {hiddenTabs.map(tab => (
            <div key={tab.id} className={s.dropdownRow}>
              <button
                className={`${s.dropdownItem} ${s.dropdownItemHidden}`}
                onClick={() => { onSelect(tab.id); setOpen(false); }}
              >
                {tab.label}
              </button>
              {onPin && (
                <button
                  className={s.pinBtn}
                  title="固定到标签栏"
                  onClick={(e) => { e.stopPropagation(); onPin(tab.id); setOpen(false); }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 4v6l-2 4v2h10v-2l-2-4v-6"/><path d="M12 16v5"/><path d="M8 4h8"/>
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
