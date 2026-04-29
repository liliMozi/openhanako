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

const mockWindows = [];

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => mockWindows) },
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
  let ipcHandlers;
  let mod;
  let ipcMain;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    handlers = {};
    ipcHandlers = {};
    mockWindows.length = 0;

    mockAutoUpdater.on.mockImplementation((event, handler) => {
      handlers[event] = handler;
    });
    mockAutoUpdater.autoDownload = true;
    mockAutoUpdater.autoInstallOnAppQuit = true;
    mockAutoUpdater.allowPrerelease = false;

    ({ ipcMain } = await import("electron"));
    ipcMain.handle.mockImplementation((name, handler) => {
      ipcHandlers[name] = handler;
    });

    mod = await import("../desktop/auto-updater.cjs");
  });

  function createMockWindow() {
    return {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };
  }

  function initWithMockWindow(opts = {}) {
    const win = createMockWindow();
    mockWindows.push(win);
    mod.initAutoUpdater(win, opts);
    return win;
  }

  function createDestroyedWindow() {
    const win = {
      isDestroyed: () => true,
      webContents: { send: vi.fn() },
    };
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

  it("broadcasts update state to every live renderer window", () => {
    const win1 = initWithMockWindow();
    const win2 = createMockWindow();
    const destroyed = createDestroyedWindow();
    mockWindows.push(win2, destroyed);

    if (handlers["update-not-available"]) {
      handlers["update-not-available"]();
    }

    expect(win1.webContents.send).toHaveBeenCalledWith("auto-update-state", expect.objectContaining({ status: "latest" }));
    expect(win2.webContents.send).toHaveBeenCalledWith("auto-update-state", expect.objectContaining({ status: "latest" }));
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
  });

  it("second init reuses process-level setup without narrowing broadcasts to one window", () => {
    const win1 = initWithMockWindow();
    const win2 = createMockWindow();
    mockWindows.push(win2);

    mod.initAutoUpdater(win2);

    expect(mockAutoUpdater.on).toHaveBeenCalledTimes(6);
    expect(ipcMain.handle).toHaveBeenCalledTimes(5);

    if (handlers["update-not-available"]) {
      handlers["update-not-available"]();
    }

    expect(win1.webContents.send).toHaveBeenCalledWith("auto-update-state", expect.objectContaining({ status: "latest" }));
    expect(win2.webContents.send).toHaveBeenCalledWith("auto-update-state", expect.objectContaining({ status: "latest" }));
  });

  it("installDownloadedUpdate enters installing state and delegates to quitAndInstall", async () => {
    const shutdownServer = vi.fn().mockResolvedValue(undefined);
    const setIsUpdating = vi.fn();
    const win = initWithMockWindow({ shutdownServer, setIsUpdating });

    if (handlers["update-downloaded"]) {
      handlers["update-downloaded"]({ version: "2.0.0" });
    }

    const ok = await mod.installDownloadedUpdate("manual");

    expect(ok).toBe(true);
    expect(setIsUpdating).toHaveBeenCalledWith(true);
    expect(shutdownServer).toHaveBeenCalledTimes(1);
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(mod.getState()).toEqual(expect.objectContaining({ status: "installing", version: "2.0.0" }));
    expect(win.webContents.send).toHaveBeenCalledWith("auto-update-state", expect.objectContaining({ status: "installing" }));
  });

  it("manual install IPC uses the same install path as app quit", async () => {
    const shutdownServer = vi.fn().mockResolvedValue(undefined);
    initWithMockWindow({ shutdownServer });

    if (handlers["update-downloaded"]) {
      handlers["update-downloaded"]({ version: "2.0.0" });
    }

    const ok = await ipcHandlers["auto-update-install"]();

    expect(ok).toBe(true);
    expect(shutdownServer).toHaveBeenCalledTimes(1);
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });
});
