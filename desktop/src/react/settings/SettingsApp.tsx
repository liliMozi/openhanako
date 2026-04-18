import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useSettingsStore } from './store';
import { hanaFetch } from './api';
import { t } from './helpers';
import { loadAgents, loadAvatars, loadSettingsConfig, loadPluginSettings } from './actions';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { WindowControls } from '../components/WindowControls';
import { SettingsNav } from './SettingsNav';
import { Toast } from './Toast';
import { AgentTab } from './tabs/AgentTab';
import { MeTab } from './tabs/MeTab';
import { InterfaceTab } from './tabs/InterfaceTab';
import { WorkTab } from './tabs/WorkTab';
import { SkillsTab } from './tabs/SkillsTab';
import { BridgeTab } from './tabs/BridgeTab';
import { ProvidersTab } from './tabs/ProvidersTab';
import { MediaTab } from './tabs/MediaTab';
import { AboutTab } from './tabs/AboutTab';
import { PluginsTab } from './tabs/PluginsTab';
import { SecurityTab } from './tabs/SecurityTab';
import { SharingTab } from './tabs/SharingTab';
import { CropOverlay } from './overlays/CropOverlay';
import { AgentCreateOverlay } from './overlays/AgentCreateOverlay';
import { AgentDeleteOverlay } from './overlays/AgentDeleteOverlay';
import { MemoryViewer } from './overlays/MemoryViewer';
import { CompiledMemoryViewer } from './overlays/CompiledMemoryViewer';
import { ClearMemoryConfirm } from './overlays/ClearMemoryConfirm';
import { BridgeTutorial } from './overlays/BridgeTutorial';
import { WechatQrcodeOverlay } from './overlays/WechatQrcodeOverlay';
import { InputContextMenu } from '../components/InputContextMenu';
import styles from './Settings.module.css';

const platform = window.platform;
const titlebarEl = document.querySelector('.titlebar');

const TAB_COMPONENTS: Record<string, React.ComponentType> = {
  agent: AgentTab,
  me: MeTab,
  interface: InterfaceTab,
  work: WorkTab,
  skills: SkillsTab,
  bridge: BridgeTab,
  providers: ProvidersTab,
  media: MediaTab,
  sharing: SharingTab,
  plugins: PluginsTab,
  security: SecurityTab,
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

  // Server 重启后用新端口重新加载数据
  useEffect(() => {
    if (!platform?.onServerRestarted) return;
    platform.onServerRestarted((data: { port: number }) => {
      const store = useSettingsStore.getState();
      console.log('[settings] server restarted, new port:', data.port);
      store.set({ serverPort: data.port });
      loadAgents().catch(() => {});
      loadSettingsConfig().catch(() => {});
    });
  }, []);

  const ActiveTab = TAB_COMPONENTS[activeTab] || AgentTab;

  return (
    <ErrorBoundary region="settings">
      <div className="settings-panel" id="settingsPanel">
        <div className="settings-header">
          <h1 className={styles['settings-title']}>{t('settings.title')}</h1>
        </div>
        <div className={styles['settings-body']}>
          <SettingsNav />
          <div className={styles['settings-main']}>
            <ErrorBoundary region={activeTab}>
              <ActiveTab />
            </ErrorBoundary>
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
      <WechatQrcodeOverlay />
      <InputContextMenu />

      {!ready && (
        <div className="settings-loading-mask" id="settingsLoadingMask">
          <div style={{ position: 'absolute', bottom: '24px', left: 0, right: 0, textAlign: 'center', color: 'var(--text-muted, #aaa)', fontSize: '12px', opacity: 0.6 }}>
            loading...
          </div>
        </div>
      )}

      {/* Windows/Linux 窗口控制按钮，渲染到 settings.html 的 .titlebar 容器 */}
      {titlebarEl && createPortal(<WindowControls />, titlebarEl)}
    </ErrorBoundary>
  );
}

/** 初始化：加载 port/token → i18n → agents → 头像 → config */
async function initSettings() {
  const store = useSettingsStore.getState();

  // 超时保护：15 秒后强制显示，防止无限白屏
  const timeout = setTimeout(() => {
    if (!store.ready) {
      console.warn('[settings] init timeout (15s), forcing ready');
      store.set({ ready: true });
    }
  }, 15_000);

  try {
    const serverPort = Number(await platform.getServerPort());
    const serverToken = await platform.getServerToken();
    store.set({ serverPort, serverToken });

    // i18n
    const i18n = window.i18n;
    try {
      const cfgRes = await hanaFetch('/api/config');
      const cfg = await cfgRes.json();
      const locale = cfg.locale || 'zh-CN';
      await i18n.load(locale);
    } catch {
      try { await i18n.load('zh-CN'); } catch { /* i18n fallback failed, continue */ }
    }

    // agents
    await loadAgents();

    // avatars
    await loadAvatars();

    // config + plugin settings
    await Promise.all([loadSettingsConfig(), loadPluginSettings()]);

    store.set({ ready: true });
  } catch (err) {
    console.error('[settings] init failed:', err);
    store.set({ ready: true }); // 即使失败也移除 mask，让用户能操作
  } finally {
    clearTimeout(timeout);
  }
}
