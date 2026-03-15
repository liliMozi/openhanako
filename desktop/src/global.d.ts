/**
 * Hana Desktop — 全局类型声明
 *
 * 集中声明 window 上的全局属性，避免散落的 `(window as any)` 和重复的 declare global。
 */

import type { PlatformApi } from './react/types';

interface MarkdownItInstance {
  render(src: string): string;
  core: { ruler: { after: (name: string, ruleName: string, fn: (state: unknown) => void) => void } };
  renderer: { rules: Record<string, unknown> };
}

declare global {
  interface Window {
    // ── i18n ──
    t: (path: string, vars?: Record<string, string | number>) => string;

    // ── Platform bridge（preload 注入） ──
    platform: PlatformApi;
    hana: PlatformApi;

    // ── Vanilla ↔ React 桥接 ──
    // __hanaActivateProxy / __hanaGetState 在 bridge.ts 中声明（需要 StoreState 类型）
    __hanaState: Record<string, unknown> & {
      ws?: { send(data: string): void; readyState?: number };
    };
    __hanaInit: (() => Promise<void>) | undefined;
    __hanaLog: (level: string, module: string, message: string) => void;
    __REACT_MANAGED: boolean;

    // ── HanaModules（shim 层注入） ──
    HanaModules: Record<string, Record<string, (...args: any[]) => any>>;

    // ── Bridge callbacks ──
    __hanaBridgeLoadStatus?: () => void;
    __hanaBridgeOnMessage?: (msg: {
      sessionKey: string;
      direction: string;
      text: string;
    }) => void;

    // ── Markdown 渲染器 ──
    markdownit: (opts: Record<string, boolean>) => MarkdownItInstance;

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

  // theme helpers（app.js 顶层）
  function loadSavedTheme(): void;
  function loadSavedFont(): void;
  function setTheme(theme: string): void;
}

export {};
