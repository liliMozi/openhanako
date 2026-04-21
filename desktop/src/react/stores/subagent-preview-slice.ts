export interface SubagentPreviewEntry {
  open: boolean;
  sessionPath: string | null;
  loading: boolean;
  loadedOnce: boolean;
}

export interface SubagentPreviewSlice {
  subagentPreviewByTaskId: Record<string, SubagentPreviewEntry>;
  openSubagentPreview: (taskId: string, sessionPath?: string | null) => void;
  closeSubagentPreview: (taskId: string) => void;
  setSubagentPreviewLoading: (taskId: string, loading: boolean) => void;
  markSubagentPreviewLoaded: (taskId: string) => void;
  setSubagentPreviewSessionPath: (taskId: string, sessionPath: string | null) => void;
}

function createDefaultEntry(): SubagentPreviewEntry {
  return {
    open: false,
    sessionPath: null,
    loading: false,
    loadedOnce: false,
  };
}

function getEntry(state: SubagentPreviewSlice, taskId: string): SubagentPreviewEntry {
  return state.subagentPreviewByTaskId[taskId] ?? createDefaultEntry();
}

function setEntry(
  state: SubagentPreviewSlice,
  taskId: string,
  updater: (entry: SubagentPreviewEntry) => SubagentPreviewEntry,
) {
  return {
    subagentPreviewByTaskId: {
      ...state.subagentPreviewByTaskId,
      [taskId]: updater(getEntry(state, taskId)),
    },
  };
}

export const createSubagentPreviewSlice = (
  set: (partial: Partial<SubagentPreviewSlice> | ((s: SubagentPreviewSlice) => Partial<SubagentPreviewSlice>)) => void,
): SubagentPreviewSlice => ({
  subagentPreviewByTaskId: {},

  openSubagentPreview: (taskId, sessionPath = undefined) => set((s) => setEntry(s, taskId, current => ({
    ...current,
    open: true,
    sessionPath: sessionPath !== undefined ? sessionPath : current.sessionPath,
  }))),

  closeSubagentPreview: (taskId) => set((s) => setEntry(s, taskId, current => ({
    ...current,
    open: false,
  }))),

  setSubagentPreviewLoading: (taskId, loading) => set((s) => setEntry(s, taskId, current => ({
    ...current,
    loading,
  }))),

  markSubagentPreviewLoaded: (taskId) => set((s) => setEntry(s, taskId, current => ({
    ...current,
    loading: false,
    loadedOnce: true,
  }))),

  setSubagentPreviewSessionPath: (taskId, sessionPath) => set((s) => setEntry(s, taskId, current => ({
    ...current,
    sessionPath,
  }))),
});
