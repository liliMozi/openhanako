import React, { useEffect } from 'react';
import { useSettingsStore } from './store';
import { hanaFetch } from './api';
import { t } from './helpers';
import { loadAgents, loadAvatars, loadSettingsConfig } from './actions';
import { SettingsNav } from './SettingsNav';
import { Toast } from './Toast';
import { AgentTab } from './tabs/AgentTab';
import { MeTab } from './tabs/MeTab';
import { InterfaceTab } from './tabs/InterfaceTab';
import { WorkTab } from './tabs/WorkTab';
import { SkillsTab } from './tabs/SkillsTab';
import { BridgeTab } from './tabs/BridgeTab';
import { ProvidersTab } from './tabs/ProvidersTab';
import { AboutTab } from './tabs/AboutTab';
import { UsageTab } from './tabs/UsageTab';
import { CropOverlay } from './overlays/CropOverlay';
import { AgentCreateOverlay } from './overlays/AgentCreateOverlay';
import { AgentDeleteOverlay } from './overlays/AgentDeleteOverlay';
import { MemoryViewer } from './overlays/MemoryViewer';
import { CompiledMemoryViewer } from './overlays/CompiledMemoryViewer';
import { ClearMemoryConfirm } from './overlays/ClearMemoryConfirm';
import { BridgeTutorial } from './overlays/BridgeTutorial';

const platform = (window as any).platform;

const TAB_COMPONENTS: Record<string, React.ComponentType> = {
  agent: AgentTab,
  me: MeTab,
  interface: InterfaceTab,
  work: WorkTab,
  skills: SkillsTab,
  bridge: BridgeTab,
  providers: ProvidersTab,
  usage: UsageTab,
  about: AboutTab,
};

export function SettingsApp() {
  const { activeTab, set, ready } = useSettingsStore();

  useEffect(() => {
    initSettings();
  }, []);

  // 外部 tab 切换请求
  useEffect(() => {
    if (!platform?.onSwitchTab) return;
    platform.onSwitchTab((tab: string) => {
      set({ activeTab: tab });
    });
  }, [set]);

  const ActiveTab = TAB_COMPONENTS[activeTab] || AgentTab;

  return (
    <>
      <div className="settings-panel" id="settingsPanel">
        <div className="settings-header">
          <h1 className="settings-title">{t('settings.title')}</h1>
        </div>
        <div className="settings-body">
          <SettingsNav />
          <div className="settings-main">
            <ActiveTab />
          </div>
        </div>
      </div>

      <Toast />
      <CropOverlay />
      <AgentCreateOverlay />
      <AgentDeleteOverlay />
      <MemoryViewer />
      <CompiledMemoryViewer />
      <ClearMemoryConfirm />
      <BridgeTutorial />

      {!ready && <div className="settings-loading-mask" id="settingsLoadingMask" />}
    </>
  );
}

/** 初始化：加载 port/token → i18n → agents → 头像 → config */
async function initSettings() {
  const store = useSettingsStore.getState();
  try {
    const serverPort = await platform.getServerPort();
    const serverToken = await platform.getServerToken();
    store.set({ serverPort, serverToken });

    // i18n
    const i18n = (window as any).i18n;
    try {
      const cfgRes = await hanaFetch('/api/config');
      const cfg = await cfgRes.json();
      const locale = cfg.locale || 'zh-CN';
      await i18n.load(locale);
    } catch {
      await i18n.load('zh-CN');
    }

    // agents
    await loadAgents();

    // avatars
    await loadAvatars();

    // config
    await loadSettingsConfig();

    store.set({ ready: true });
  } catch (err) {
    console.error('[settings] init failed:', err);
    store.set({ ready: true }); // 即使失败也移除 mask，让用户能操作
  }
}
