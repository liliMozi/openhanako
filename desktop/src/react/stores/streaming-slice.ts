export interface StreamingSlice {
  /** 所有正在 streaming 的 session path 集合（单一事实源） */
  streamingSessions: string[];
  addStreamingSession: (path: string) => void;
  removeStreamingSession: (path: string) => void;
  /** 按 session path 存储的内联错误（权威源） */
  inlineErrors: Record<string, string | null>;
  /** 模型切换进行中（阻止发送） */
  modelSwitching: boolean;
  setModelSwitching: (v: boolean) => void;
}

export const createStreamingSlice = (
  set: (partial: Partial<StreamingSlice> | ((s: StreamingSlice) => Partial<StreamingSlice>)) => void
): StreamingSlice => ({
  streamingSessions: [],
  addStreamingSession: (path) => set((s) => ({
    streamingSessions: s.streamingSessions.includes(path)
      ? s.streamingSessions
      : [...s.streamingSessions, path],
  })),
  removeStreamingSession: (path) => set((s) => ({
    streamingSessions: s.streamingSessions.filter(p => p !== path),
  })),
  inlineErrors: {},
  modelSwitching: false,
  setModelSwitching: (v) => set({ modelSwitching: v }),
});
