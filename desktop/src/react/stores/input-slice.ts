export interface AttachedFile {
  path: string;
  name: string;
  isDirectory?: boolean;
  /** 内联 base64 数据（粘贴图片时使用，跳过文件读取） */
  base64Data?: string;
  mimeType?: string;
}

export interface DocContextFile {
  path: string;
  name: string;
}

export interface QuotedSelection {
  text: string;
  sourceTitle: string;
  sourceFilePath?: string;
  lineStart?: number;
  lineEnd?: number;
  charCount: number;
}

export interface InputSlice {
  attachedFiles: AttachedFile[];
  /** 按 session path 存储的附件（权威源） */
  attachedFilesBySession: Record<string, AttachedFile[]>;
  /** 按 session path 存储的草稿文本（内存级，关窗口清空） */
  drafts: Record<string, string>;
  deskContextAttached: boolean;
  docContextAttached: boolean;
  inputFocusTrigger: number;
  quotedSelection: QuotedSelection | null;
  addAttachedFile: (file: AttachedFile) => void;
  removeAttachedFile: (index: number) => void;
  setAttachedFiles: (files: AttachedFile[]) => void;
  clearAttachedFiles: () => void;
  setDraft: (sessionPath: string, text: string) => void;
  clearDraft: (sessionPath: string) => void;
  setDeskContextAttached: (attached: boolean) => void;
  toggleDeskContext: () => void;
  setDocContextAttached: (attached: boolean) => void;
  toggleDocContext: () => void;
  requestInputFocus: () => void;
  setQuotedSelection: (sel: QuotedSelection) => void;
  clearQuotedSelection: () => void;
}

export const createInputSlice = (
  set: (partial: Partial<InputSlice> | ((s: InputSlice) => Partial<InputSlice>)) => void
): InputSlice => ({
  attachedFiles: [],
  attachedFilesBySession: {},
  drafts: {},
  deskContextAttached: false,
  docContextAttached: false,
  inputFocusTrigger: 0,
  quotedSelection: null,
  addAttachedFile: (file) =>
    set((s) => ({ attachedFiles: [...s.attachedFiles, file] })),
  removeAttachedFile: (index) =>
    set((s) => ({ attachedFiles: s.attachedFiles.filter((_, i) => i !== index) })),
  setAttachedFiles: (files) => set({ attachedFiles: files }),
  clearAttachedFiles: () => set({ attachedFiles: [] }),
  setDraft: (sessionPath, text) =>
    set((s) => ({ drafts: { ...s.drafts, [sessionPath]: text } })),
  clearDraft: (sessionPath) =>
    set((s) => {
      const { [sessionPath]: _, ...rest } = s.drafts;
      return { drafts: rest };
    }),
  setDeskContextAttached: (attached) => set({ deskContextAttached: attached }),
  toggleDeskContext: () =>
    set((s) => ({ deskContextAttached: !s.deskContextAttached })),
  setDocContextAttached: (attached) => set({ docContextAttached: attached }),
  toggleDocContext: () =>
    set((s) => ({ docContextAttached: !s.docContextAttached })),
  requestInputFocus: () =>
    set((s) => ({ inputFocusTrigger: s.inputFocusTrigger + 1 })),
  setQuotedSelection: (sel) => set({ quotedSelection: sel }),
  clearQuotedSelection: () => set({ quotedSelection: null }),
});
