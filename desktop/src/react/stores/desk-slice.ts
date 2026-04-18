import type { DeskFile } from '../types';

export const DESK_OWNER = 'desk';

export interface DeskSkillInfo {
  name: string;
  enabled: boolean;
  source?: string;
  externalLabel?: string | null;
  managedBy?: string | null;
}

export interface CwdSkillInfo {
  name: string;
  description: string;
  source: string;
  filePath: string;
  baseDir: string;
}

export interface DeskOwnerState {
  deskFiles: DeskFile[];
  deskBasePath: string;
  deskCurrentPath: string;
  deskJianContent: string | null;
  deskSkills: DeskSkillInfo[];
  cwdSkills: CwdSkillInfo[];
  cwdSkillsOpen: boolean;
}

const EMPTY_OWNER_STATE: DeskOwnerState = {
  deskFiles: [],
  deskBasePath: '',
  deskCurrentPath: '',
  deskJianContent: null,
  deskSkills: [],
  cwdSkills: [],
  cwdSkillsOpen: false,
};

function cloneOwnerState(state?: Partial<DeskOwnerState> | null): DeskOwnerState {
  return {
    deskFiles: [...(state?.deskFiles || [])],
    deskBasePath: state?.deskBasePath || '',
    deskCurrentPath: state?.deskCurrentPath || '',
    deskJianContent: state?.deskJianContent ?? null,
    deskSkills: [...(state?.deskSkills || [])],
    cwdSkills: [...(state?.cwdSkills || [])],
    cwdSkillsOpen: state?.cwdSkillsOpen ?? false,
  };
}

function ownerFromState(state?: { currentSessionPath?: string | null }) {
  return state?.currentSessionPath || DESK_OWNER;
}

export interface DeskSlice {
  deskFiles: DeskFile[];
  deskBasePath: string;
  deskCurrentPath: string;
  deskJianContent: string | null;
  deskSkills: DeskSkillInfo[];
  cwdSkills: CwdSkillInfo[];
  cwdSkillsOpen: boolean;
  deskStateByOwner: Record<string, DeskOwnerState>;
  homeFolder: string | null;
  selectedFolder: string | null;
  cwdHistory: string[];
  getDeskStateForOwner: (owner: string) => DeskOwnerState | null;
  restoreDeskStateForOwner: (owner: string) => void;
  cloneDeskStateToOwner: (targetOwner: string, sourceOwner?: string) => void;
  setCwdSkills: (skills: CwdSkillInfo[]) => void;
  setCwdSkillsOpen: (open: boolean) => void;
  toggleCwdSkillsOpen: () => void;
  setDeskFiles: (files: DeskFile[]) => void;
  setDeskBasePath: (path: string) => void;
  setDeskCurrentPath: (path: string) => void;
  setDeskJianContent: (content: string | null) => void;
  setDeskSkills: (skills: DeskSkillInfo[]) => void;
  setHomeFolder: (folder: string | null) => void;
  setSelectedFolder: (folder: string | null) => void;
  setCwdHistory: (history: string[]) => void;
}

export const createDeskSlice = (
  set: (
    partial: Partial<DeskSlice> | ((state: DeskSlice & { currentSessionPath?: string | null }) => Partial<DeskSlice>)
  ) => void,
  get?: () => (DeskSlice & { currentSessionPath?: string | null }),
): DeskSlice => {
  const patchCurrentOwner = (partial: Partial<DeskOwnerState>) => {
    set((state) => {
      const owner = ownerFromState(state);
      const current = cloneOwnerState(state.deskStateByOwner?.[owner] || EMPTY_OWNER_STATE);
      const nextOwnerState = cloneOwnerState({ ...current, ...partial });
      return {
        deskStateByOwner: {
          ...(state.deskStateByOwner || {}),
          [owner]: nextOwnerState,
        },
        ...partial,
      };
    });
  };

  return {
    ...cloneOwnerState(EMPTY_OWNER_STATE),
    deskStateByOwner: {},
    homeFolder: null,
    selectedFolder: null,
    cwdHistory: [],
    getDeskStateForOwner: (owner) => {
      const state = get?.();
      if (!state) return null;
      return cloneOwnerState(state.deskStateByOwner?.[owner] || EMPTY_OWNER_STATE);
    },
    restoreDeskStateForOwner: (owner) => {
      const state = get?.();
      const restored = cloneOwnerState(state?.deskStateByOwner?.[owner] || EMPTY_OWNER_STATE);
      set(restored);
    },
    cloneDeskStateToOwner: (targetOwner, sourceOwner) => {
      if (!targetOwner) return;
      const state = get?.();
      if (!state) return;
      const fromOwner = sourceOwner || ownerFromState(state);
      const source = cloneOwnerState(state.deskStateByOwner?.[fromOwner] || {
        ...EMPTY_OWNER_STATE,
        deskBasePath: state.deskBasePath,
        deskCurrentPath: state.deskCurrentPath,
        deskJianContent: state.deskJianContent,
        deskFiles: state.deskFiles,
        deskSkills: state.deskSkills,
        cwdSkills: state.cwdSkills,
        cwdSkillsOpen: state.cwdSkillsOpen,
      });
      set({
        deskStateByOwner: {
          ...(state.deskStateByOwner || {}),
          [targetOwner]: source,
        },
      });
    },
    setCwdSkills: (skills) => patchCurrentOwner({ cwdSkills: skills }),
    setCwdSkillsOpen: (open) => patchCurrentOwner({ cwdSkillsOpen: open }),
    toggleCwdSkillsOpen: () => {
      const state = get?.();
      patchCurrentOwner({ cwdSkillsOpen: !(state?.cwdSkillsOpen ?? false) });
    },
    setDeskFiles: (files) => patchCurrentOwner({ deskFiles: files }),
    setDeskBasePath: (path) => patchCurrentOwner({ deskBasePath: path }),
    setDeskCurrentPath: (path) => patchCurrentOwner({ deskCurrentPath: path }),
    setDeskJianContent: (content) => patchCurrentOwner({ deskJianContent: content }),
    setDeskSkills: (skills) => patchCurrentOwner({ deskSkills: skills }),
    setHomeFolder: (folder) => set({ homeFolder: folder }),
    setSelectedFolder: (folder) => set({ selectedFolder: folder }),
    setCwdHistory: (history) => set({ cwdHistory: history }),
  };
};
