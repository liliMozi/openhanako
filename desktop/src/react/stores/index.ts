import { create } from 'zustand';
import { createConnectionSlice, type ConnectionSlice } from './connection-slice';
import { createSessionSlice, type SessionSlice } from './session-slice';
import { createStreamingSlice, type StreamingSlice } from './streaming-slice';
import { createUiSlice, type UiSlice } from './ui-slice';
import { createAgentSlice, type AgentSlice } from './agent-slice';
import { createChannelSlice, type ChannelSlice } from './channel-slice';
import { createDeskSlice, type DeskSlice } from './desk-slice';
import { createModelSlice, type ModelSlice } from './model-slice';
import { createInputSlice, type InputSlice } from './input-slice';
import { createChatSlice, type ChatSlice } from './chat-slice';
import { createToastSlice, type ToastSlice } from './toast-slice';
import { createArtifactSlice, type ArtifactSlice } from './artifact-slice';
import { createBrowserSlice, type BrowserSlice } from './browser-slice';
import { createContextSlice, type ContextSlice } from './context-slice';
import { createAutomationSlice, type AutomationSlice } from './automation-slice';
import { createActivitySlice, type ActivitySlice } from './activity-slice';
import { createBridgeSlice, type BridgeSlice } from './bridge-slice';
import { createPluginUiSlice, type PluginUiSlice } from './plugin-ui-slice';
import { createSelectionSlice, type SelectionSlice } from './selection-slice';
import { createSubagentPreviewSlice, type SubagentPreviewSlice } from './subagent-preview-slice';

export type StoreState = ConnectionSlice &
  SessionSlice &
  StreamingSlice &
  UiSlice &
  AgentSlice &
  ChannelSlice &
  DeskSlice &
  ModelSlice &
  InputSlice &
  ChatSlice &
  ToastSlice &
  ArtifactSlice &
  BrowserSlice &
  ContextSlice &
  AutomationSlice &
  ActivitySlice &
  BridgeSlice &
  PluginUiSlice &
  SelectionSlice &
  SubagentPreviewSlice;

export const useStore = create<StoreState>()((set, _get, _api) => ({
  ...createConnectionSlice(set),
  ...createSessionSlice(set),
  ...createStreamingSlice(set),
  ...createUiSlice(set),
  ...createAgentSlice(set),
  ...createChannelSlice(set),
  ...createDeskSlice(set, _get),
  ...createModelSlice(set),
  ...createInputSlice(set),
  ...createChatSlice(set, _get),
  ...createToastSlice(set, _get),
  ...createArtifactSlice(set),
  ...createBrowserSlice(set),
  ...createContextSlice(set),
  ...createAutomationSlice(set),
  ...createActivitySlice(set),
  ...createBridgeSlice(set),
  ...createPluginUiSlice(set),
  ...createSelectionSlice(set),
  ...createSubagentPreviewSlice(set),
}));

// Re-export slice types
export type {
  ConnectionSlice,
  SessionSlice,
  StreamingSlice,
  UiSlice,
  AgentSlice,
  ChannelSlice,
  DeskSlice,
  ModelSlice,
  InputSlice,
  ChatSlice,
  ToastSlice,
  ArtifactSlice,
  BrowserSlice,
  ContextSlice,
  AutomationSlice,
  ActivitySlice,
  BridgeSlice,
  PluginUiSlice,
  SelectionSlice,
  SubagentPreviewSlice,
};
