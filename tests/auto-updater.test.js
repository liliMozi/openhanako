import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks（必须在 import 之前声明）──

const mockAutoUpdater = {
  autoDownload: true,
  autoInstallOnAppQuit: true,
  allowPrerelease: false,
  checkForUpdates: vi.fn().mockResolvedValue({}),
  downloadUpdate: vi.fn().mockResolvedValue(null),
  quitAndInstall: vi.fn(),
  setFeedURL: vi.fn(),
  on: vi.fn(),
};

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    isPackaged: true,
    getVersion: () => "1.0.0",
    getPath: (name) => {
      if (name === "exe") return "/Applications/Hanako.app/Contents/MacOS/Hanako";
      if (name === "userData") return "/tmp/test-userdata";
      return "/tmp";
    },
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: mockAutoUpdater,
}));

describe("auto-updater", () => {
  let handlers;
  let mod;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    handlers = {};

    mockAutoUpdater.on.mockImplementation((event, handler) => {
      handlers[event] = handler;
    });
    mockAutoUpdater.autoDownload = true;
    mockAutoUpdater.autoInstallOnAppQuit = true;
    mockAutoUpdater.allowPrerelease = false;

    const { ipcMain } = await import("electron");
    ipcMain.handle.mockImplementation(() => {});

    mod = await import("../desktop/auto-updater.cjs");
  });

  function initWithMockWindow() {
    const win = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };
    mod.initAutoUpdater(win);
    return win;
  }

  it("should configure autoUpdater correctly", () => {
    initWithMockWindow();
    expect(mockAutoUpdater.autoDownload).toBe(false);
    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it("should map update-available to available state", async () => {
    initWithMockWindow();
    if (handlers["update-available"]) {
      await handlers["update-available"]({ version: "2.0.0", releaseNotes: "New features" });
    }
    const state = mod.getState();
    expect(state.version).toBe("2.0.0");
    expect(["available", "downloading", "error"]).toContain(state.status);
  });

  it("should map update-not-available to latest state", () => {
    initWithMockWindow();
    if (handlers["update-not-available"]) {
      handlers["update-not-available"]();
    }
    expect(mod.getState().status).toBe("latest");
  });

  it("should set allowPrerelease on channel change", () => {
    initWithMockWindow();
    mod.setUpdateChannel("beta");
    expect(mockAutoUpdater.allowPrerelease).toBe(true);
    mod.setUpdateChannel("stable");
    expect(mockAutoUpdater.allowPrerelease).toBe(false);
  });

  it("should map download-progress to downloading state", () => {
    initWithMockWindow();
    if (handlers["download-progress"]) {
      handlers["download-progress"]({
        percent: 42.5, bytesPerSecond: 1024000, transferred: 50000, total: 120000,
      });
    }
    const state = mod.getState();
    expect(state.status).toBe("downloading");
    expect(state.progress.percent).toBe(43);
  });

  it("should map update-downloaded to downloaded state", () => {
    initWithMockWindow();
    if (handlers["update-downloaded"]) {
      handlers["update-downloaded"]({ version: "2.0.0" });
    }
    expect(mod.getState().status).toBe("downloaded");
  });
});
