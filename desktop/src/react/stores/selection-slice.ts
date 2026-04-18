export interface SelectionSlice {
  selectedIdsBySession: Record<string, string[]>;
  toggleMessageSelection: (sessionPath: string, messageId: string) => void;
  clearSelection: (sessionPath: string) => void;
}

export const createSelectionSlice = (
  set: (partial: Partial<SelectionSlice> | ((s: SelectionSlice) => Partial<SelectionSlice>)) => void,
): SelectionSlice => ({
  selectedIdsBySession: {},

  toggleMessageSelection: (sessionPath, messageId) => set((s) => {
    const current = s.selectedIdsBySession[sessionPath] || [];
    const next = current.includes(messageId)
      ? current.filter(id => id !== messageId)
      : [...current, messageId];
    return {
      selectedIdsBySession: { ...s.selectedIdsBySession, [sessionPath]: next },
    };
  }),

  clearSelection: (sessionPath) => set((s) => {
    const copy = { ...s.selectedIdsBySession };
    delete copy[sessionPath];
    return { selectedIdsBySession: copy };
  }),
});
