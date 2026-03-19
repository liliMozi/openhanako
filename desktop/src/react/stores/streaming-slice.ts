export interface StreamingSlice {
  isStreaming: boolean;
  lastResponseTime: number | null;   // 上次收到模型响应的时间戳
  responseTimeout: boolean;          // 是否处于超时警告状态
  setIsStreaming: (streaming: boolean) => void;
  setLastResponseTime: (time: number) => void;
  setResponseTimeout: (timeout: boolean) => void;
  resetResponseState: () => void;
}

export const createStreamingSlice = (
  set: (partial: Partial<StreamingSlice>) => void
): StreamingSlice => ({
  isStreaming: false,
  lastResponseTime: null,
  responseTimeout: false,
  setIsStreaming: (streaming) => set({ isStreaming: streaming }),
  setLastResponseTime: (time) => set({ lastResponseTime: time, responseTimeout: false }),
  setResponseTimeout: (timeout) => set({ responseTimeout: timeout }),
  resetResponseState: () => set({ lastResponseTime: null, responseTimeout: false }),
});
