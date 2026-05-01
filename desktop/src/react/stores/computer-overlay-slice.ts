export type ComputerOverlayPhase = 'preview' | 'running' | 'done' | 'error' | 'clear';
export type ComputerOverlayVisualSurface = 'renderer' | 'provider';

export interface ComputerOverlayTarget {
  coordinateSpace?: 'element' | 'window';
  elementId?: string;
  x?: number;
  y?: number;
}

export interface ComputerOverlayState {
  phase: Exclude<ComputerOverlayPhase, 'clear'>;
  action: string;
  sessionPath: string;
  agentId?: string | null;
  leaseId?: string | null;
  snapshotId?: string | null;
  target?: ComputerOverlayTarget | null;
  inputMode?: 'background' | 'foreground-input';
  visualSurface?: ComputerOverlayVisualSurface;
  requiresForeground?: boolean;
  interruptKey?: string | null;
  errorCode?: string | null;
  ts: number;
}

export interface ComputerOverlaySlice {
  computerOverlayBySession: Record<string, ComputerOverlayState>;
  setComputerOverlayForSession: (sessionPath: string, event: Omit<ComputerOverlayState, 'sessionPath'> & { sessionPath?: string }) => void;
  clearComputerOverlayForSession: (sessionPath: string) => void;
}

export const createComputerOverlaySlice = (
  set: (partial: Partial<ComputerOverlaySlice> | ((state: any) => Partial<ComputerOverlaySlice>)) => void,
): ComputerOverlaySlice => ({
  computerOverlayBySession: {},

  setComputerOverlayForSession: (sessionPath, event) => set((state) => ({
    computerOverlayBySession: {
      ...state.computerOverlayBySession,
      [sessionPath]: {
        ...event,
        sessionPath,
        phase: event.phase,
        action: event.action,
        ts: event.ts || Date.now(),
      },
    },
  })),

  clearComputerOverlayForSession: (sessionPath) => set((state) => {
    const { [sessionPath]: _removed, ...rest } = state.computerOverlayBySession;
    return { computerOverlayBySession: rest };
  }),
});

export function computeComputerOverlayPosition(event: ComputerOverlayState | null | undefined): { x: number; y: number } {
  if (!event) return { x: 50, y: 46 };
  const target = event.target;
  if (target?.coordinateSpace === 'window' && typeof target.x === 'number' && typeof target.y === 'number') {
    return {
      x: Math.max(8, Math.min(92, 8 + (target.x % 1000) / 1000 * 84)),
      y: Math.max(14, Math.min(86, 14 + (target.y % 800) / 800 * 72)),
    };
  }
  const basis = `${event.action}:${target?.elementId || event.snapshotId || event.leaseId || ''}`;
  let hash = 0;
  for (let i = 0; i < basis.length; i += 1) hash = (hash * 31 + basis.charCodeAt(i)) >>> 0;
  return {
    x: 34 + (hash % 30),
    y: 36 + ((hash >> 5) % 24),
  };
}
