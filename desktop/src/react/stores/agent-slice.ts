import type { Agent } from '../types';

export interface AgentSlice {
  agentName: string;
  userName: string;
  agentAvatarUrl: string | null;
  userAvatarUrl: string | null;
  agentYuan: string;
  agents: Agent[];
  currentAgentId: string | null;
  selectedAgentId: string | null;
  settingsAgentId: string | null;
  setAgentName: (name: string) => void;
  setUserName: (name: string) => void;
  setAgentAvatarUrl: (url: string | null) => void;
  setUserAvatarUrl: (url: string | null) => void;
  setAgentYuan: (yuan: string) => void;
  setAgents: (agents: Agent[]) => void;
  setCurrentAgentId: (id: string | null) => void;
  setSelectedAgentId: (id: string | null) => void;
  setSettingsAgentId: (id: string | null) => void;
}

export const createAgentSlice = (
  set: (partial: Partial<AgentSlice>) => void
): AgentSlice => ({
  agentName: 'Hanako',
  userName: 'User',
  agentAvatarUrl: null,
  userAvatarUrl: null,
  agentYuan: 'hanako',
  agents: [],
  currentAgentId: null,
  selectedAgentId: null,
  settingsAgentId: null,
  setAgentName: (name) => set({ agentName: name }),
  setUserName: (name) => set({ userName: name }),
  setAgentAvatarUrl: (url) => set({ agentAvatarUrl: url }),
  setUserAvatarUrl: (url) => set({ userAvatarUrl: url }),
  setAgentYuan: (yuan) => set({ agentYuan: yuan }),
  setAgents: (agents) => set({ agents }),
  setCurrentAgentId: (id) => set({ currentAgentId: id }),
  setSelectedAgentId: (id) => set({ selectedAgentId: id }),
  setSettingsAgentId: (id) => set({ settingsAgentId: id }),
});
