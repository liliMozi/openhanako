import type { StoreState } from './index';

type SelectionState = Pick<StoreState, 'selectedIdsBySession'>;
type StreamingState = Pick<StoreState, 'streamingSessions'>;

export const EMPTY_SELECTED_IDS = Object.freeze([]) as readonly string[];

export function selectSelectedIdsBySession(
  state: SelectionState,
  sessionPath: string | null | undefined,
): readonly string[] {
  if (!sessionPath) return EMPTY_SELECTED_IDS;
  return state.selectedIdsBySession[sessionPath] ?? EMPTY_SELECTED_IDS;
}

export function selectIsStreamingSession(
  state: StreamingState,
  sessionPath: string | null | undefined,
): boolean {
  return !!sessionPath && state.streamingSessions.includes(sessionPath);
}
