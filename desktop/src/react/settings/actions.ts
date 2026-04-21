/**
 * Settings shared actions — extracted from SettingsApp to avoid circular imports
 */
import { useSettingsStore } from './store';
import { hanaFetch, hanaUrl } from './api';
import { t } from './helpers';

const platform = window.platform;

export async function loadAgents() {
  const store = useSettingsStore.getState();
  try {
    const res = await hanaFetch('/api/agents');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const agents = data.agents || [];
    let currentAgentId = store.currentAgentId;
    if (!currentAgentId) {
      const primary = agents.find((a: any) => a.isPrimary) || agents[0];
      if (primary) currentAgentId = primary.id;
    }
    const currentAgent = agents.find((a: any) => a.id === currentAgentId);
    store.set({
      agents,
      currentAgentId,
      agentYuan: currentAgent?.yuan || store.agentYuan,
      agentName: currentAgent?.name || store.agentName,
    });
  } catch (err) {
    console.error('[agents] load failed:', err);
  }
}

export async function loadAvatars() {
  const ts = Date.now();
  const store = useSettingsStore.getState();
  try {
    const res = await hanaFetch('/api/health');
    const data = await res.json();
    const avatars = data.avatars || {};
    for (const role of ['agent', 'user']) {
      if (avatars[role]) {
        const url = hanaUrl(`/api/avatar/${role}?t=${ts}`);
        if (role === 'agent') store.set({ agentAvatarUrl: url });
        else store.set({ userAvatarUrl: url });
      } else {
        if (role === 'agent') store.set({ agentAvatarUrl: null });
        else store.set({ userAvatarUrl: null });
      }
    }
  } catch {}
}

export async function loadSettingsConfig() {
  const store = useSettingsStore.getState();
  try {
    const agentId = store.getSettingsAgentId();
    const agentBase = `/api/agents/${agentId}`;
    const [configRes, identityRes, ishikiRes, publicIshikiRes, userProfileRes, pinnedRes, globalModelsRes, experienceRes] =
      await Promise.all([
        hanaFetch(`${agentBase}/config`),
        hanaFetch(`${agentBase}/identity`),
        hanaFetch(`${agentBase}/ishiki`),
        hanaFetch(`${agentBase}/public-ishiki`),
        hanaFetch('/api/user-profile'),
        hanaFetch(`${agentBase}/pinned`),
        hanaFetch('/api/preferences/models'),
        hanaFetch(`${agentBase}/experience`),
      ]);

    const config = await configRes.json();
    const globalModels = await globalModelsRes.json();
    const identityData = await identityRes.json();
    config._identity = identityData.content || '';
    const ishikiData = await ishikiRes.json();
    config._ishiki = ishikiData.content || '';
    const publicIshikiData = await publicIshikiRes.json();
    config._publicIshiki = publicIshikiData.content || '';
    const userProfileData = await userProfileRes.json();
    config._userProfile = userProfileData.content || '';
    const pinnedData = await pinnedRes.json();
    const experienceData = await experienceRes.json();
    config._experience = experienceData.content || '';

    store.set({
      settingsConfig: config,
      globalModelsConfig: globalModels,
      homeFolder: config.desk?.home_folder || null,
      currentPins: pinnedData.pins || [],
    });
  } catch (err) {
    console.error('[settings] load failed:', err);
  }
}

export async function loadPluginSettings() {
  const store = useSettingsStore.getState();
  try {
    const res = await hanaFetch('/api/plugins/settings');
    const data = await res.json();
    store.set({
      pluginAllowFullAccess: data.allow_full_access ?? false,
      pluginUserDir: data.plugins_dir || '',
    });
  } catch (err) {
    console.error('[plugins] load settings failed:', err);
  }
}

export async function browseAgent(agentId: string) {
  useSettingsStore.setState({ settingsAgentId: agentId });
  await loadSettingsConfig();
  await loadAgents();
}

export async function switchToAgent(agentId: string) {
  const store = useSettingsStore.getState();
  try {
    const res = await hanaFetch('/api/agents/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: agentId }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    store.set({
      settingsAgentId: null,
      currentAgentId: data.agent.id,
      agentName: data.agent.name,
    });
    platform?.settingsChanged?.('agent-switched', {
      agentName: data.agent.name,
      agentId: data.agent.id,
    });
    await loadSettingsConfig();
    await loadAgents();
    store.showToast(t('settings.agent.switched', { name: data.agent.name }), 'success');
  } catch (err: any) {
    store.showToast(t('settings.agent.switchFailed') + ': ' + err.message, 'error');
  }
}
