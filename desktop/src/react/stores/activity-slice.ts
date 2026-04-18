import type { Activity } from '../types';

export interface ActivitySlice {
  activities: Activity[];
  setActivities: (activities: Activity[]) => void;
}

export const createActivitySlice = (
  set: (partial: Partial<ActivitySlice>) => void
): ActivitySlice => ({
  activities: [],
  setActivities: (activities) => set({ activities }),
});

// ── Selectors ──
export const selectActivities = (s: ActivitySlice) => s.activities;
