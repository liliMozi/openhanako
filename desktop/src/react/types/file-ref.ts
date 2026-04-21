export type FileKind =
  | 'image'
  | 'svg'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'doc'
  | 'code'
  | 'markdown'
  | 'other';

export type FileSource =
  | 'desk'
  | 'session-attachment'
  | 'session-block-file'
  | 'session-block-screenshot';

export interface FileRef {
  id: string;
  kind: FileKind;
  source: FileSource;
  name: string;
  /** 当 source === 'session-block-screenshot' 时为 '' */
  path: string;
  ext?: string;
  mime?: string;
  timestamp?: number;
  sessionMessageId?: string;
  inlineData?: { base64: string; mimeType: string };
}
