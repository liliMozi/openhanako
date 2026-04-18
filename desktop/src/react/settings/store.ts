/**
 * Settings window Zustand store
 * 独立于主窗口 store，设置窗口有自己的 BrowserWindow + JS context
 */
import { create } from 'zustand';

export interface Agent {
  id: string;
  name: string;
  yuan: string;
  isPrimary: boolean;
  hasAvatar?: boolean;
}

export interface SkillInfo {
  name: string;
  description?: string;
  enabled: boolean;
  hidden?: boolean;
  baseDir?: string;
  filePath?: string;
  source?: string;
  externalLabel?: string | null;
  externalPath?: string | null;
  readonly?: boolean;
}

export interface ProviderSummary {
  type: 'api-key' | 'oauth';
  display_name: string;
  base_url: string;
  api: string;
  api_key: string;
  models: (string | { id: string; [key: string]: any })[];
  custom_models: string[];
  has_credentials: boolean;
  logged_in?: boolean;
  supports_oauth: boolean;
  is_coding_plan?: boolean;
  can_delete: boolean;
}

export interface SettingsState {
  // connection
  serverPort: number | null;
  serverToken: string | null;

  // agents
  agents: Agent[];
  currentAgentId: string | null;
  settingsAgentId: string | null;
  agentName: string;
  userName: string;
  agentYuan: string;
  agentAvatarUrl: string | null;
  userAvatarUrl: string | null;

  // config
  settingsConfig: Record<string, any> | null;
  globalModelsConfig: Record<string, any> | null;
  homeFolder: string | null;

  // ui
  activeTab: string;
  ready: boolean;

  // pins
  currentPins: string[];

  // providers (unified)
  providersSummary: Record<string, ProviderSummary>;
  selectedProviderId: string | null;

  // plugins
  pluginAllowFullAccess: boolean;
  pluginUserDir: string;

  // toast
  toastMessage: string;
  toastType: 'success' | 'error' | '';
  toastVisible: boolean;
}

export interface SettingsActions {
  set: (partial: Partial<SettingsState>) => void;
  getSettingsAgentId: () => string | null;
  showToast: (message: string, type: 'success' | 'error') => void;
}

export type SettingsStore = SettingsState & SettingsActions;

let _toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useSettingsStore = create<SettingsStore>()((set, get) => ({
  // connection
  serverPort: null,
  serverToken: null,

  // agents
  agents: [],
  currentAgentId: null,
  settingsAgentId: null,
  agentName: 'Hanako',
  userName: 'User',
  agentYuan: 'hanako',
  agentAvatarUrl: null,
  userAvatarUrl: null,

  // config
  settingsConfig: null,
  globalModelsConfig: null,
  homeFolder: null,

  // ui
  activeTab: 'agent',
  ready: false,

  // pins
  currentPins: [],

  // providers (unified)
  providersSummary: {},
  selectedProviderId: null,

  // plugins
  pluginAllowFullAccess: false,
  pluginUserDir: '',

  // toast
  toastMessage: '',
  toastType: '',
  toastVisible: false,

  // actions
  set: (partial) => set(partial),

  getSettingsAgentId: () => {
    const { settingsAgentId, currentAgentId } = get();
    return settingsAgentId || currentAgentId;
  },

  showToast: (message, type) => {
    if (_toastTimer) clearTimeout(_toastTimer);
    set({ toastMessage: message, toastType: type, toastVisible: true });
    _toastTimer = setTimeout(() => {
      set({ toastVisible: false });
    }, 1500);
  },
}));
