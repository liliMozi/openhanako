export interface ConnectionSlice {
  serverPort: string | null;
  serverToken: string | null;
  connected: boolean;
  statusKey: string;
  statusVars: Record<string, string | number>;
  /** Bridge dot: at least one platform connected */
  bridgeDotConnected: boolean;
  wsState: 'connected' | 'reconnecting' | 'disconnected';
  wsReconnectAttempt: number;
  oauthSessionId: string | null;
  setServerPort: (port: string) => void;
  setServerToken: (token: string) => void;
  setConnected: (connected: boolean) => void;
  setOauthSessionId: (id: string | null) => void;
}

export const createConnectionSlice = (
  set: (partial: Partial<ConnectionSlice>) => void
): ConnectionSlice => ({
  serverPort: null,
  serverToken: null,
  connected: false,
  statusKey: 'status.connecting',
  statusVars: {},
  bridgeDotConnected: false,
  wsState: 'disconnected',
  wsReconnectAttempt: 0,
  oauthSessionId: null,
  setServerPort: (port) => set({ serverPort: port }),
  setServerToken: (token) => set({ serverToken: token }),
  setConnected: (connected) => set({ connected }),
  setOauthSessionId: (id) => set({ oauthSessionId: id }),
});
