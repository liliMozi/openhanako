import type { Model } from '../types';

export type ThinkingLevel = 'off' | 'auto' | 'xhigh';

export interface ModelSlice {
  models: Model[];
  currentModel: string | null;
  thinkingLevel: ThinkingLevel;
  setModels: (models: Model[]) => void;
  setCurrentModel: (model: string | null) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
}

export const createModelSlice = (
  set: (partial: Partial<ModelSlice>) => void
): ModelSlice => ({
  models: [],
  currentModel: null,
  thinkingLevel: 'auto',
  setModels: (models) => set({ models }),
  setCurrentModel: (model) => set({ currentModel: model }),
  setThinkingLevel: (level) => set({ thinkingLevel: level }),
});
