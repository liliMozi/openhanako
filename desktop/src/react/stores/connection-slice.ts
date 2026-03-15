export interface ConnectionSlice {
  serverPort: string | null;
  serverToken: string | null;
  connected: boolean;
  setServerPort: (port: string) => void;
  setServerToken: (token: string) => void;
  setConnected: (connected: boolean) => void;
}

export const createConnectionSlice = (
  set: (partial: Partial<ConnectionSlice>) => void
): ConnectionSlice => ({
  serverPort: null,
  serverToken: null,
  connected: false,
  setServerPort: (port) => set({ serverPort: port }),
  setServerToken: (token) => set({ serverToken: token }),
  setConnected: (connected) => set({ connected }),
});
