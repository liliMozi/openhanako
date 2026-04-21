import { useStore } from './index';
import { hanaFetch } from '../hooks/use-hana-fetch';
import type { PluginPageInfo, PluginWidgetInfo } from '../types';

/** Fetch plugin pages and widgets from backend, update store. */
export async function refreshPluginUI(): Promise<void> {
  try {
    let pages: PluginPageInfo[] = [];
    let widgets: PluginWidgetInfo[] = [];

    // hanaFetch throws on non-2xx, so wrap each call individually
    const [pagesResult, widgetsResult] = await Promise.allSettled([
      hanaFetch('/api/plugins/pages').then(r => r.json()),
      hanaFetch('/api/plugins/widgets').then(r => r.json()),
    ]);
    if (pagesResult.status === 'fulfilled') pages = pagesResult.value;
    if (widgetsResult.status === 'fulfilled') widgets = widgetsResult.value;

    const s = useStore.getState();
    s.setPluginPages(pages);
    s.setPluginWidgets(widgets);

    // If current tab is a removed plugin tab, switch to chat
    const currentTab = s.currentTab;
    if (typeof currentTab === 'string' && currentTab.startsWith('plugin:')) {
      const pluginId = currentTab.slice(7);
      if (!pages.some(p => p.pluginId === pluginId)) {
        s.setCurrentTab('chat');
      }
    }

    // If jianView references a removed widget, reset to desk
    if (s.jianView.startsWith('widget:')) {
      const widgetId = s.jianView.slice(7);
      if (!widgets.some(w => w.pluginId === widgetId)) {
        s.setJianView('desk');
      }
    }

    // Clean stale pinned widgets
    const validPinned = s.pinnedWidgets.filter(id => widgets.some(w => w.pluginId === id));
    if (validPinned.length !== s.pinnedWidgets.length) {
      s.setPinnedWidgets(validPinned);
    }
  } catch (err) {
    console.warn('[plugin-ui] Failed to refresh:', err);
  }
}

/** Persist tab order, pinned widgets, and hidden tabs to preferences. */
async function savePluginPrefs(): Promise<void> {
  const s = useStore.getState();
  try {
    await hanaFetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pluginTabOrder: s.tabOrder,
        pluginPinnedWidgets: s.pinnedWidgets,
        pluginHiddenTabs: s.hiddenPluginTabs,
      }),
    });
  } catch (err) {
    console.warn('[plugin-ui] Failed to persist prefs:', err);
  }
}

/** Pin a widget to the titlebar. */
export function pinWidget(pluginId: string): void {
  const s = useStore.getState();
  if (!s.pinnedWidgets.includes(pluginId)) {
    s.setPinnedWidgets([...s.pinnedWidgets, pluginId]);
    savePluginPrefs();
  }
}

/** Unpin a widget from the titlebar. */
export function unpinWidget(pluginId: string): void {
  const s = useStore.getState();
  s.setPinnedWidgets(s.pinnedWidgets.filter(id => id !== pluginId));
  savePluginPrefs();
}

/** Switch jian sidebar to a widget view. */
export function openWidget(pluginId: string): void {
  const s = useStore.getState();
  s.setJianView(`widget:${pluginId}`);
  if (!s.jianOpen) {
    s.setJianOpen(true);
  }
}

/** Switch jian sidebar back to desk. */
export function openDesk(): void {
  useStore.getState().setJianView('desk');
}

/** Hide a plugin tab from the tab bar. */
export function hidePluginTab(tabId: string): void {
  const s = useStore.getState();
  const pluginId = tabId.startsWith('plugin:') ? tabId.slice(7) : tabId;
  if (!s.hiddenPluginTabs.includes(pluginId)) {
    s.setHiddenPluginTabs([...s.hiddenPluginTabs, pluginId]);
    // If currently viewing this tab, switch to chat
    if (s.currentTab === `plugin:${pluginId}`) s.setCurrentTab('chat');
    savePluginPrefs();
  }
}

/** Show a previously hidden plugin tab. */
export function showPluginTab(tabId: string): void {
  const s = useStore.getState();
  const pluginId = tabId.startsWith('plugin:') ? tabId.slice(7) : tabId;
  s.setHiddenPluginTabs(s.hiddenPluginTabs.filter(id => id !== pluginId));
  savePluginPrefs();
}

/** Reorder tabs (called after drag-drop). */
export function reorderTabs(newOrder: string[]): void {
  useStore.getState().setTabOrder(newOrder);
  savePluginPrefs();
}
