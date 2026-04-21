export interface ContextSlice {
  /** Context usage — token count for the current session */
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
  /** 按 session path 存储的 context usage（权威源） */
  contextBySession: Record<string, { tokens: number | null; window: number | null; percent: number | null }>;
  /** Session paths currently undergoing compaction */
  compactingSessions: string[];
  addCompactingSession: (path: string) => void;
  removeCompactingSession: (path: string) => void;
}

export const createContextSlice = (
  set: (partial: Partial<ContextSlice> | ((s: ContextSlice) => Partial<ContextSlice>)) => void
): ContextSlice => ({
  contextTokens: null,
  contextWindow: null,
  contextPercent: null,
  contextBySession: {},
  compactingSessions: [],
  addCompactingSession: (path) => set((s) => ({
    compactingSessions: s.compactingSessions.includes(path)
      ? s.compactingSessions
      : [...s.compactingSessions, path],
  })),
  removeCompactingSession: (path) => set((s) => ({
    compactingSessions: s.compactingSessions.filter(p => p !== path),
  })),
});

// ── Selectors ──
export const selectContextTokens = (s: ContextSlice) => s.contextTokens;
export const selectContextWindow = (s: ContextSlice) => s.contextWindow;
export const selectContextPercent = (s: ContextSlice) => s.contextPercent;
