import type { Session, SessionStream, TodoItem } from '../types';

export interface BridgeSessionInfo {
  sessionKey: string;
  platform: string;
  displayName: string;
  avatarUrl?: string;
}

export interface SessionSlice {
  sessions: Session[];
  currentSessionPath: string | null;
  sessionStreams: Record<string, SessionStream>;
  pendingNewSession: boolean;
  memoryEnabled: boolean;
  sessionTodos: TodoItem[];
  /** 当前接管的 bridge session（非 null 时主区域显示 bridge 消息） */
  bridgeSession: BridgeSessionInfo | null;
  setSessions: (sessions: Session[]) => void;
  setCurrentSessionPath: (path: string | null) => void;
  setSessionStream: (sessionPath: string, stream: SessionStream) => void;
  removeSessionStream: (sessionPath: string) => void;
  setPendingNewSession: (pending: boolean) => void;
  setMemoryEnabled: (enabled: boolean) => void;
  setSessionTodos: (todos: TodoItem[]) => void;
  setBridgeSession: (info: BridgeSessionInfo | null) => void;
}

export const createSessionSlice = (
  set: (partial: Partial<SessionSlice> | ((s: SessionSlice) => Partial<SessionSlice>)) => void
): SessionSlice => ({
  sessions: [],
  currentSessionPath: null,
  sessionStreams: {},
  pendingNewSession: false,
  memoryEnabled: true,
  sessionTodos: [],
  bridgeSession: null,
  setSessions: (sessions) => set({ sessions }),
  setCurrentSessionPath: (path) => set({ currentSessionPath: path }),
  setSessionStream: (sessionPath, stream) =>
    set((s) => ({
      sessionStreams: { ...s.sessionStreams, [sessionPath]: stream },
    })),
  removeSessionStream: (sessionPath) =>
    set((s) => {
      const { [sessionPath]: _, ...rest } = s.sessionStreams;
      return { sessionStreams: rest };
    }),
  setPendingNewSession: (pending) => set({ pendingNewSession: pending }),
  setMemoryEnabled: (enabled) => set({ memoryEnabled: enabled }),
  setSessionTodos: (todos) => set({ sessionTodos: todos }),
  setBridgeSession: (info) => set({ bridgeSession: info }),
});
