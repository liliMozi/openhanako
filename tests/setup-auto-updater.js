/**
 * Global setup for auto-updater tests.
 *
 * Problem: auto-updater.cjs uses require("electron") and require("electron-updater").
 * These CJS require() calls bypass vitest's vi.mock ESM registry.
 *
 * Strategy:
 * 1. Pre-populate Node's require.cache so the initial CJS load doesn't crash on
 *    electron.app.getVersion() (which is undefined when electron is unmocked).
 * 2. In beforeEach, re-sync require.cache["electron-updater"] to whatever vitest's
 *    ESM mock registry returns for "electron-updater" — which gives us the
 *    { autoUpdater: mockAutoUpdater } object from the test file.
 *    Same for "electron" so ipcMain/app are live vi.fn() mocks.
 */
import { beforeEach } from "vitest";
import Module from "node:module";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── Helper: inject a stub module into require.cache ──────────────────────────

function injectCjsStub(moduleId, stubExports) {
  let resolvedPath;
  try {
    resolvedPath = require.resolve(moduleId);
  } catch {
    resolvedPath = moduleId;
  }
  const mod = new Module(resolvedPath);
  mod.exports = stubExports;
  mod.loaded = true;
  require.cache[resolvedPath] = mod;
  return resolvedPath;
}

// ── Initial stubs (prevent crash on first require) ────────────────────────────

const electronStub = {
  ipcMain: { handle: () => {} },
  app: {
    isPackaged: true,
    getVersion: () => "1.0.0",
    getPath: (name) => {
      if (name === "exe") return "/Applications/Hanako.app/Contents/MacOS/Hanako";
      if (name === "userData") return "/tmp/test-userdata";
      return "/tmp";
    },
  },
};

const autoUpdaterPlaceholder = {
  autoDownload: true,
  autoInstallOnAppQuit: true,
  allowPrerelease: false,
  checkForUpdates: () => Promise.resolve({}),
  downloadUpdate: () => Promise.resolve(null),
  quitAndInstall: () => {},
  setFeedURL: () => {},
  on: () => {},
};

const electronUpdaterStub = { autoUpdater: autoUpdaterPlaceholder };

injectCjsStub("electron", electronStub);
const electronUpdaterPath = injectCjsStub("electron-updater", electronUpdaterStub);

let electronPath;
try {
  electronPath = require.resolve("electron");
} catch {
  electronPath = "electron";
}

// ── beforeEach: sync require.cache with vitest's live ESM mock ────────────────
//
// After vi.resetModules(), the test re-imports auto-updater.cjs which calls
// require("electron-updater"). At that point require.cache must contain the
// SAME autoUpdater object that the test's mockAutoUpdater refers to.
//
// vitest's vi.mock("electron-updater", factory) registers a persistent factory
// that survives vi.resetModules(). Importing "electron-updater" via ESM import()
// calls that factory and returns { autoUpdater: mockAutoUpdater }.
// We then write that result into require.cache so the subsequent CJS require()
// in auto-updater.cjs gets the same object.

beforeEach(async () => {
  // Import electron-updater through vitest's ESM mock system.
  // If a vi.mock("electron-updater", factory) is registered in the test file,
  // this returns { autoUpdater: mockAutoUpdater } — the exact mock object.
  try {
    const liveEu = await import("electron-updater");
    // liveEu is the mock namespace: { autoUpdater: mockAutoUpdater, ... }
    // Write it into require.cache so CJS require("electron-updater") gets the same object.
    if (require.cache[electronUpdaterPath]) {
      // Build a plain exports object from the ESM namespace (no "default" key).
      const exports = {};
      for (const key of Object.keys(liveEu)) {
        if (key !== "default") exports[key] = liveEu[key];
      }
      require.cache[electronUpdaterPath].exports = exports;
    }
  } catch (e) {
    // If no vi.mock is registered for this test, keep the placeholder stub.
  }

  // Update electron stub with live ipcMain/app mocks from vi.mock("electron").
  try {
    const liveElectron = await import("electron");
    if (require.cache[electronPath]) {
      const exports = {};
      for (const key of Object.keys(liveElectron)) {
        if (key !== "default") exports[key] = liveElectron[key];
      }
      require.cache[electronPath].exports = exports;
    }
  } catch (e) {
    // Keep placeholder.
  }
});
