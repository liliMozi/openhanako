export interface StreamingSlice {
  isStreaming: boolean;
  setIsStreaming: (streaming: boolean) => void;
}

export const createStreamingSlice = (
  set: (partial: Partial<StreamingSlice>) => void
): StreamingSlice => ({
  isStreaming: false,
  setIsStreaming: (streaming) => set({ isStreaming: streaming }),
});
