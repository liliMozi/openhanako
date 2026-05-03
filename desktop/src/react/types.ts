// ── Auto-update ──

export interface AutoUpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error' | 'latest';
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
  pinnedAt?: string | null;
  rcAttachment?: {
    sessionKey: string;
    platform: string;
    title?: string | null;
  } | null;
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
  provider: string;
  isCurrent?: boolean;
  reasoning?: boolean;
  xhigh?: boolean;
  /** 输入模态数组（Pi SDK 标准字段）。包含 "image" 表示模型支持图像输入。 */
  input?: ("text" | "image")[];
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
  fileId?: string;
  filePath?: string;
  ext?: string;
  mime?: string;
  kind?: string;
  storageKind?: string;
  status?: 'available' | 'expired' | string;
  missingAt?: number | null;
  fileVersion?: FileVersion | null;
}

export interface DeskFile {
  name: string;
  isDir: boolean;
  size?: number;
  mtime?: string;
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  activeForm: string;
  status: TodoStatus;
}

// ── 浮动面板类型 ──
export type ActivePanel = 'activity' | 'automation' | 'bridge' | null;
export type TabType = 'chat' | 'channels' | `plugin:${string}`;

export interface FileVersion {
  mtimeMs: number;
  size: number;
  sha256?: string;
}

export interface TextFileSnapshot {
  content: string;
  version: FileVersion;
}

export interface VersionedWriteResult {
  ok: boolean;
  conflict?: boolean;
  version?: FileVersion | null;
}

// ── Plugin Card Protocol ──

export interface PluginCardDetails {
  type: string;         // "iframe" | future types
  pluginId: string;
  route: string;
  title?: string;
  description: string;  // IM fallback / degradation text
  aspectRatio?: string;
}

// ── 插件 UI 信息 ──

export interface PluginPageInfo {
  pluginId: string;
  title: string | Record<string, string>;
  icon: string | null;
  routeUrl: string;
}

export interface PluginWidgetInfo {
  pluginId: string;
  title: string | Record<string, string>;
  icon: string | null;
  routeUrl: string;
}

// ── Platform API 类型声明 ──
export interface PlatformApi {
  getServerPort(): Promise<string>;
  getServerToken(): Promise<string>;
  runEditCommand?(command: 'cut' | 'copy' | 'paste' | 'selectAll'): Promise<boolean>;
  openSettings(tab?: string): void;
  openBrowserViewer(url?: string, theme?: string): void;
  selectFolder(): Promise<string | null>;
  selectFiles(): Promise<string[]>;
  selectSkill(): Promise<string | null>;
  selectPlugin?(): Promise<string | null>;
  readFile(path: string): Promise<string | null>;
  writeFile(filePath: string, content: string): Promise<boolean>;
  readFileSnapshot?(path: string): Promise<TextFileSnapshot | null>;
  writeFileIfUnchanged?(filePath: string, content: string, expectedVersion?: FileVersion | null): Promise<VersionedWriteResult>;
  watchFile(filePath: string): Promise<boolean>;
  unwatchFile(filePath: string): Promise<boolean>;
  onFileChanged(callback: (filePath: string) => void): void;
  readFileBase64(path: string): Promise<string | null>;
  /** 把本地路径转成 <img>/<video> 可用的 file:// URL（同步，纯路径转换）。Web fallback 无此方法，消费侧需运行时判空。 */
  getFileUrl?(path: string): string;
  readDocxHtml(path: string): Promise<string | null>;
  readXlsxHtml(path: string): Promise<string | null>;
  /** 派生一个只读 Viewer 窗口展示指定文件。返回 windowId（主进程 BrowserWindow.id）。 */
  spawnViewer(data: { filePath: string; title: string; type: string; language?: string | null }): Promise<number | null>;
  /** Viewer 窗口接收文件元信息（viewer-window-entry 调用）。 */
  onViewerLoad?(callback: (data: { filePath: string; title: string; type: string; language?: string | null; windowId: number }) => void): void;
  /** Viewer 窗口内"关闭"按钮触发。 */
  viewerClose?(): void;
  /** 主窗口监听任意 viewer 关闭，payload 是 windowId（用于清理 pinnedViewers store）。 */
  onViewerClosed?(callback: (windowId: number) => void): void;
  openFolder(path: string): void;
  openFile(path: string): void;
  openExternal(url: string): void;
  showInFinder(path: string): void;
  browserEmergencyStop?(): void;
  openSkillViewer?(opts: { skillPath?: string; name?: string; baseDir?: string; filePath?: string; installed?: boolean }): void;
  settingsChanged(event: string, payload?: unknown): void;
  onSettingsChanged(callback: (event: string, payload: unknown) => void): void | (() => void);
  onOpenSettingsModal?(callback: (tab?: string) => void): void | (() => void);
  onSwitchTab?(callback: (tab: string) => void): void | (() => void);
  onServerRestarted?(callback: (data: { port: number }) => void): void | (() => void);
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

  // ── Splash / Onboarding ──
  getAvatarPath?(role: string): Promise<string | null>;
  getSplashInfo?(): Promise<{ agentName?: string; locale?: string; yuan?: string } | null>;
  onboardingComplete?(): Promise<void>;

  // ── Notification ──
  showNotification?(title: string, body: string): void;

  // ── App info ──
  getAppVersion?(): Promise<string>;
  checkUpdate?(): Promise<{ version: string; downloadUrl: string } | null>;

  // ── Auto-update (Windows) ──
  autoUpdateCheck?(): Promise<string | null>;
  autoUpdateDownload?(): Promise<boolean>;
  autoUpdateInstall?(): Promise<boolean>;
  autoUpdateState?(): Promise<AutoUpdateState>;
  autoUpdateSetChannel?(channel: 'stable' | 'beta'): Promise<void>;
  onAutoUpdateState?(callback: (state: AutoUpdateState) => void): (() => void) | void;

  // ── Skill viewer overlay ──
  onShowSkillViewer?(callback: (data: unknown) => void): void;

  [key: string]: unknown;
}
