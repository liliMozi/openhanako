/**
 * Hana Desktop — 全局类型声明
 *
 * 集中声明 window 上的全局属性，避免散落的 `(window as any)` 和重复的 declare global。
 */

import type { PlatformApi } from './react/types';

declare global {
  interface Window {
    // ── i18n ──
    t: (path: string, vars?: Record<string, string | number>) => string;

    // ── Platform bridge（preload 注入） ──
    platform: PlatformApi;
    hana: PlatformApi;

    // ── 日志上报 ──
    __hanaLog: (level: string, module: string, message: string) => void;

    // ── 主题 ──
    applyTheme?: (theme: string) => void;

    // ── Desk skills reload callback ──
    __loadDeskSkills?: () => void;

    // ── Notification bridge ──
    showNotification?: (title: string, body: string) => void;
    updateBrowserViewer?: (data: { url: string; thumbnail?: string }) => void;

    // ── i18n loader ──
    i18n: {
      locale: string;
      defaultName: string;
      _data: Record<string, unknown>;
      _agentOverrides: Record<string, unknown>;
      load(locale: string): Promise<void>;
      setAgentOverrides(overrides: Record<string, unknown> | null): void;
      t(path: string, vars?: Record<string, string | number>): string;
    };
  }

  // theme helpers（theme.js 全局函数）
  function loadSavedTheme(): void;
  function loadSavedFont(): void;
  function setTheme(theme: string): void;
  function setSerifFont(enabled: boolean): void;
}

export {};
