import type { DeskFile } from '../types';

export interface CwdSkillInfo {
  name: string;
  description: string;
  source: string;
  filePath: string;
  baseDir: string;
}

export interface WorkspaceDeskState {
  deskCurrentPath: string;
  deskFiles: DeskFile[];
  deskTreeFilesByPath: Record<string, DeskFile[]>;
  deskExpandedPaths: string[];
  deskSelectedPath: string;
  deskJianContent: string | null;
  cwdSkills: CwdSkillInfo[];
  cwdSkillsOpen: boolean;
  previewOpen: boolean;
  jianDrawerOpen: boolean;
  openTabs: string[];
  activeTabId: string | null;
}

export interface DeskSlice {
  deskFiles: DeskFile[];
  deskBasePath: string;
  deskCurrentPath: string;
  deskTreeFilesByPath: Record<string, DeskFile[]>;
  deskExpandedPaths: string[];
  deskSelectedPath: string;
  deskJianContent: string | null;
  cwdSkills: CwdSkillInfo[];
  cwdSkillsOpen: boolean;
  homeFolder: string | null;
  selectedFolder: string | null;
  workspaceFolders: string[];
  cwdHistory: string[];
  workspaceDeskStateByRoot: Record<string, WorkspaceDeskState>;
  setCwdSkills: (skills: CwdSkillInfo[]) => void;
  setCwdSkillsOpen: (open: boolean) => void;
  toggleCwdSkillsOpen: () => void;
  setDeskFiles: (files: DeskFile[]) => void;
  setDeskBasePath: (path: string) => void;
  setDeskCurrentPath: (path: string) => void;
  setDeskTreeFiles: (subdir: string, files: DeskFile[]) => void;
  setDeskExpandedPaths: (paths: string[]) => void;
  setDeskSelectedPath: (path: string) => void;
  clearDeskTree: () => void;
  setDeskJianContent: (content: string | null) => void;
  setHomeFolder: (folder: string | null) => void;
  setSelectedFolder: (folder: string | null) => void;
  setWorkspaceFolders: (folders: string[]) => void;
  setCwdHistory: (history: string[]) => void;
  setWorkspaceDeskState: (root: string, state: WorkspaceDeskState) => void;
}

export const createDeskSlice = (
  set: (partial: Partial<DeskSlice> | ((s: DeskSlice) => Partial<DeskSlice>)) => void,
): DeskSlice => ({
  deskFiles: [],
  deskBasePath: '',
  deskCurrentPath: '',
  deskTreeFilesByPath: {},
  deskExpandedPaths: [],
  deskSelectedPath: '',
  deskJianContent: null,
  cwdSkills: [],
  cwdSkillsOpen: false,
  homeFolder: null,
  selectedFolder: null,
  workspaceFolders: [],
  cwdHistory: [],
  workspaceDeskStateByRoot: {},
  setCwdSkills: (skills) => set({ cwdSkills: skills }),
  setCwdSkillsOpen: (open) => set({ cwdSkillsOpen: open }),
  toggleCwdSkillsOpen: () => set((s) => ({ cwdSkillsOpen: !s.cwdSkillsOpen })),
  setDeskFiles: (files) => set({ deskFiles: files }),
  setDeskBasePath: (path) => set({ deskBasePath: path }),
  setDeskCurrentPath: (path) => set({ deskCurrentPath: path }),
  setDeskTreeFiles: (subdir, files) => set((s) => ({
    deskTreeFilesByPath: {
      ...s.deskTreeFilesByPath,
      [subdir]: files,
    },
  })),
  setDeskExpandedPaths: (paths) => set({ deskExpandedPaths: paths }),
  setDeskSelectedPath: (path) => set({ deskSelectedPath: path }),
  clearDeskTree: () => set({
    deskTreeFilesByPath: {},
    deskExpandedPaths: [],
    deskSelectedPath: '',
  }),
  setDeskJianContent: (content) => set({ deskJianContent: content }),
  setHomeFolder: (folder) => set({ homeFolder: folder }),
  setSelectedFolder: (folder) => set({ selectedFolder: folder }),
  setWorkspaceFolders: (folders) => set({ workspaceFolders: folders }),
  setCwdHistory: (history) => set({ cwdHistory: history }),
  setWorkspaceDeskState: (root, state) => set((s) => ({
    workspaceDeskStateByRoot: {
      ...s.workspaceDeskStateByRoot,
      [root]: state,
    },
  })),
});
