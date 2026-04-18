/**
 * bootstrap.ts — 共享窗口初始化原子函数
 *
 * 每类窗口（主窗口、设置、onboarding、splash 等）自行组合所需的原子函数，
 * 而非调用一个统一的 "init all" 黑盒。
 */

/* ── 全局声明（由 HTML <script> 加载的 lib/*.js 暴露） ── */
declare function loadSavedTheme(): void;
declare function loadSavedFont(): void;
declare function loadSavedPaperTexture(): void;
declare function initPlatform(): void;

// ── 原子函数 ──

/** 从 localStorage 恢复主题 + 字体 + 纸质纹理偏好 */
export function initTheme(): void {
  if (typeof loadSavedTheme === 'function') loadSavedTheme();
  if (typeof loadSavedFont === 'function') loadSavedFont();
  if (typeof loadSavedPaperTexture === 'function') loadSavedPaperTexture();
}

/** 阻止 Electron 默认的文件拖入导航行为 */
export function initDragPrevention(): void {
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
}

/** 注入 Windows/Linux 自绘窗口控制按钮（macOS 用原生红绿灯，无需调用） */
export function initPlatformControls(): void {
  if (typeof initPlatform === 'function') initPlatform();
}
