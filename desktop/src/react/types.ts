// ── Auto-update ──

export interface AutoUpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'latest';
  version: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
  downloadUrl: string | null;
  progress: {
    percent: number;
    bytesPerSecond: number;
    transferred: number;
    total: number;
  } | null;
  error: string | null;
}

// ── 核心数据结构 ──

export interface Session {
  path: string;
  title: string | null;
  firstMessage: string;
  modified: string;
  messageCount: number;
  agentId: string | null;
  agentName: string | null;
  cwd: string | null;
  _optimistic?: boolean;
}

export interface Agent {
  id: string;
  name: string;
  yuan: string;
  isPrimary: boolean;
  hasAvatar?: boolean;
}

export interface SessionStream {
  streamId: string | null;
  lastSeq: number;
}

export interface Model {
  id: string;
  name: string;
  isCurrent?: boolean;
  reasoning?: boolean;
  xhigh?: boolean;
}

export interface Channel {
  id: string;
  name: string;
  description?: string;
  members: string[];
  lastMessage: string;
  lastSender: string;
  lastTimestamp: string;
  newMessageCount: number;
  isDM?: boolean;
  peerId?: string;
  peerName?: string;
}

export interface ChannelMessage {
  sender: string;
  timestamp: string;
  body: string;
}

export interface Activity {
  id: string;
  type: string;
  title: string;
  timestamp: string;
  agentId?: string;
  agentName?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface Artifact {
  id: string;
  type: string;
  title: string;
  content: string;
  language?: string | null;
  filePath?: string;
  ext?: string;
}

export interface DeskFile {
  name: string;
  isDir: boolean;
  size?: number;
  mtime?: string;
}

export interface TodoItem {
  text: string;
  done: boolean;
}

export interface SessionAgent {
  name: string;
  yuan: string;
  avatarUrl: string | null;
}

// ── 浮动面板类型 ──
export type ActivePanel = 'activity' | 'automation' | 'bridge' | null;
export type TabType = 'chat' | 'channels';

// ── Platform API 类型声明 ──
export interface PlatformApi {
  getServerPort(): Promise<string>;
  getServerToken(): Promise<string>;
  openSettings(tab?: string): void;
  openBrowserViewer(url?: string, theme?: string): void;
  selectFolder(): Promise<string | null>;
  selectSkill(): Promise<string | null>;
  readFile(path: string): Promise<string | null>;
  writeFile(filePath: string, content: string): Promise<boolean>;
  watchFile(filePath: string): Promise<boolean>;
  unwatchFile(filePath: string): Promise<boolean>;
  onFileChanged(callback: (filePath: string) => void): void;
  readFileBase64(path: string): Promise<string | null>;
  readDocxHtml(path: string): Promise<string | null>;
  readXlsxHtml(path: string): Promise<string | null>;
  openEditorWindow(data: { filePath: string; title: string; type: string; language?: string | null }): void;
  onEditorDockFile?(callback: (data: { filePath: string; title: string; type: string; language?: string | null }) => void): void;
  onEditorDetached?(callback: (detached: boolean) => void): void;
  openFolder(path: string): void;
  openFile(path: string): void;
  openExternal(url: string): void;
  showInFinder(path: string): void;
  browserEmergencyStop?(): void;
  openSkillViewer?(opts: { skillPath?: string; name?: string; baseDir?: string; filePath?: string; installed?: boolean }): void;
  settingsChanged(event: string, payload?: unknown): void;
  onSettingsChanged(callback: (event: string, payload: unknown) => void): void;
  onSwitchTab?(callback: (tab: string) => void): void;
  getFilePath?(file: File): string | null;
  startDrag?(filePaths: string | string[]): void;
  appReady(): void;

  // ── Window controls (Windows/Linux) ──
  getPlatform?(): Promise<string>;
  windowMinimize?(): void;
  windowMaximize?(): void;
  windowClose?(): void;
  windowIsMaximized?(): Promise<boolean>;
  onMaximizeChange?(callback: (maximized: boolean) => void): void;

  // ── Browser viewer ──
  updateBrowserViewer?(data: { running?: boolean; url?: string | null; thumbnail?: string | null }): void;
  onBrowserUpdate?(callback: (data: { title?: string; canGoBack?: boolean; canGoForward?: boolean; running?: boolean }) => void): void;
  closeBrowserViewer?(): void;
  closeBrowser?(): void;
  browserGoBack?(): void;
  browserGoForward?(): void;
  browserReload?(): void;

  // ── Skill viewer (preload) ──
  listSkillFiles?(baseDir: string): Promise<unknown[]>;
  readSkillFile?(filePath: string): Promise<string | null>;

  // ── Splash ──
  getAvatarPath?(role: string): Promise<string | null>;
  getSplashInfo?(): Promise<{ agentName?: string; locale?: string; yuan?: string } | null>;

  // ── Notification ──
  showNotification?(title: string, body: string): void;

  // ── App info ──
  getAppVersion?(): Promise<string>;
  checkUpdate?(): Promise<{ version: string; downloadUrl: string } | null>;

  // ── Auto-update (Windows) ──
  autoUpdateCheck?(): Promise<string | null>;
  autoUpdateDownload?(): Promise<boolean>;
  autoUpdateInstall?(): void;
  autoUpdateState?(): Promise<AutoUpdateState>;
  autoUpdateSetChannel?(channel: 'stable' | 'beta'): Promise<void>;
  onAutoUpdateState?(callback: (state: AutoUpdateState) => void): void;

  // ── Skill viewer overlay ──
  onShowSkillViewer?(callback: (data: unknown) => void): void;

  // ── Inter-window communication ──
  notifyMainWindow?(event: string, payload?: unknown): void;

  [key: string]: unknown;
}
