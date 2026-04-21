import { describe, expect, it, vi } from "vitest";
import { BrowserManager } from "../lib/browser/browser-manager.js";

const SP1 = "/sessions/session-1.json";
const SP2 = "/sessions/session-2.json";
const SP3 = "/sessions/session-3.json";
const SP4 = "/sessions/session-4.json";
const SP5 = "/sessions/session-5.json";
const SP6 = "/sessions/session-6.json";

describe("BrowserManager URL tracking (per-session)", () => {
  it.each([
    ["scroll", (manager, sp) => manager.scroll("down", 2, sp)],
    ["select", (manager, sp) => manager.select(7, "next", sp)],
    ["pressKey", (manager, sp) => manager.pressKey("Enter", sp)],
    ["wait", (manager, sp) => manager.wait({ timeout: 100 }, sp)],
  ])("%s updates currentUrl from browser command results", async (_name, action) => {
    const manager = new BrowserManager();
    manager._sessions.set(SP1, { running: true, url: "https://before.example.com", headless: false });
    manager._sendCmd = vi.fn().mockResolvedValue({
      currentUrl: "https://after.example.com",
      text: "snapshot",
    });

    const text = await action(manager, SP1);

    expect(text).toBe("snapshot");
    expect(manager.currentUrl(SP1)).toBe("https://after.example.com");
  });
});

describe("BrowserManager explicit sessionPath", () => {
  it("launch() with explicit sessionPath uses it", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockResolvedValue({});

    await manager.launch(SP1);

    expect(manager.isRunning(SP1)).toBe(true);
    expect(manager._sendCmd).toHaveBeenCalledWith("launch", {
      sessionPath: SP1,
      headless: false,
    });
  });

  it("launch() on already-running session returns immediately", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockResolvedValue({});
    manager._sessions.set(SP1, { running: true, url: null, headless: false });

    await manager.launch(SP1);

    // _sendCmd should NOT have been called
    expect(manager._sendCmd).not.toHaveBeenCalled();
  });

  it("navigate() updates session URL and cold save", async () => {
    const manager = new BrowserManager();
    manager._sessions.set(SP1, { running: true, url: null, headless: false });
    manager._sendCmd = vi.fn().mockResolvedValue({
      url: "https://example.com/page",
      title: "Page",
      snapshot: "...",
    });
    manager._saveColdUrl = vi.fn();

    await manager.navigate("https://example.com/page", SP1);

    expect(manager._saveColdUrl).toHaveBeenCalledWith(
      SP1,
      "https://example.com/page",
    );
    expect(manager.currentUrl(SP1)).toBe("https://example.com/page");
  });

  it("close() removes session from Map and cold state", async () => {
    const manager = new BrowserManager();
    manager._sessions.set(SP1, { running: true, url: "https://example.com", headless: false });
    manager._lruOrder = [SP1];
    manager._sendCmd = vi.fn().mockResolvedValue({});
    manager._removeColdUrl = vi.fn();

    await manager.close(SP1);

    expect(manager._removeColdUrl).toHaveBeenCalledWith(SP1);
    expect(manager.isRunning(SP1)).toBe(false);
    expect(manager._sessions.has(SP1)).toBe(false);
    expect(manager._lruOrder).not.toContain(SP1);
  });

  it("getBrowserSessions() merges cold state with all running sessions", () => {
    const manager = new BrowserManager();
    manager._sessions.set(SP1, { running: true, url: "https://example.com", headless: false });
    manager._sessions.set(SP2, { running: true, url: "https://other.com", headless: false });
    manager._loadColdState = vi.fn().mockReturnValue({
      "/sessions/cold-session.json": "https://cold.example.com",
    });

    const sessions = manager.getBrowserSessions();

    expect(sessions).toEqual({
      "/sessions/cold-session.json": "https://cold.example.com",
      [SP1]: "https://example.com",
      [SP2]: "https://other.com",
    });
  });

  it("getBrowserSessions() does not include running sessions without URL", () => {
    const manager = new BrowserManager();
    manager._sessions.set(SP1, { running: true, url: null, headless: false });
    manager._loadColdState = vi.fn().mockReturnValue({});

    const sessions = manager.getBrowserSessions();

    expect(sessions).toEqual({});
  });
});

describe("BrowserManager multi-instance", () => {
  it("can launch up to 5 concurrent sessions", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockResolvedValue({});

    const allSessions = [SP1, SP2, SP3, SP4, SP5];
    for (const sp of allSessions) {
      await manager.launch(sp);
    }

    expect(manager.runningSessions).toHaveLength(5);
    for (const sp of allSessions) {
      expect(manager.isRunning(sp)).toBe(true);
    }
  });

  it("6th session triggers LRU eviction of oldest running session", async () => {
    const manager = new BrowserManager();
    // Track suspend calls
    const suspendCalls = [];
    manager._sendCmd = vi.fn().mockImplementation(async (cmd, params) => {
      if (cmd === "suspend") suspendCalls.push(params?.sessionPath);
      return {};
    });
    manager._saveColdUrl = vi.fn();

    const allSessions = [SP1, SP2, SP3, SP4, SP5];
    for (const sp of allSessions) {
      await manager.launch(sp);
    }

    // Launch 6th session → should evict SP1 (oldest in LRU)
    await manager.launch(SP6);

    expect(suspendCalls).toContain(SP1);
    expect(manager.isRunning(SP1)).toBe(false);
    expect(manager.isRunning(SP6)).toBe(true);
    expect(manager.runningSessions).toHaveLength(5);
  });

  it("LRU evicts least recently used, not just first launched", async () => {
    const manager = new BrowserManager();
    const suspendCalls = [];
    manager._sendCmd = vi.fn().mockImplementation(async (cmd, params) => {
      if (cmd === "suspend") suspendCalls.push(params?.sessionPath);
      return {};
    });
    manager._saveColdUrl = vi.fn();

    const allSessions = [SP1, SP2, SP3, SP4, SP5];
    for (const sp of allSessions) {
      await manager.launch(sp);
    }

    // Touch SP1 to move it to end of LRU
    manager._touchLru(SP1);

    // Launch 6th → should evict SP2 (now oldest in LRU)
    await manager.launch(SP6);

    expect(suspendCalls).toContain(SP2);
    expect(manager.isRunning(SP2)).toBe(false);
    expect(manager.isRunning(SP1)).toBe(true);
    expect(manager.isRunning(SP6)).toBe(true);
  });

  it("close/suspend/resume are isolated per session", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockImplementation(async (cmd, params) => {
      if (cmd === "resume") return { found: true, url: "https://resumed.com" };
      return {};
    });
    manager._saveColdUrl = vi.fn();
    manager._loadColdState = vi.fn().mockReturnValue({});

    // Launch two sessions
    await manager.launch(SP1);
    await manager.launch(SP2);

    // Suspend SP1
    manager._sessions.get(SP1).url = "https://sp1.example.com";
    await manager.suspendForSession(SP1);

    expect(manager.isRunning(SP1)).toBe(false);
    expect(manager.isRunning(SP2)).toBe(true);

    // Close SP2
    await manager.close(SP2);

    expect(manager.isRunning(SP2)).toBe(false);
    expect(manager._sessions.has(SP2)).toBe(false);

    // Resume SP1
    // Need cold state for resume to proceed when not running
    manager._loadColdState = vi.fn().mockReturnValue({
      [SP1]: "https://sp1.example.com",
    });
    await manager.resumeForSession(SP1);

    expect(manager.isRunning(SP1)).toBe(true);
    expect(manager.currentUrl(SP1)).toBe("https://resumed.com");
  });

  it("hasAnyRunning returns true when at least one session is running", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockResolvedValue({});

    expect(manager.hasAnyRunning).toBe(false);

    await manager.launch(SP1);
    expect(manager.hasAnyRunning).toBe(true);

    await manager.launch(SP2);
    expect(manager.hasAnyRunning).toBe(true);

    await manager.close(SP1);
    expect(manager.hasAnyRunning).toBe(true);

    await manager.close(SP2);
    expect(manager.hasAnyRunning).toBe(false);
  });

  it("runningSessions returns correct list", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockResolvedValue({});
    manager._saveColdUrl = vi.fn();

    expect(manager.runningSessions).toEqual([]);

    await manager.launch(SP1);
    await manager.launch(SP2);
    await manager.launch(SP3);

    expect(manager.runningSessions).toHaveLength(3);
    expect(manager.runningSessions).toContain(SP1);
    expect(manager.runningSessions).toContain(SP2);
    expect(manager.runningSessions).toContain(SP3);

    await manager.suspendForSession(SP2);

    expect(manager.runningSessions).toHaveLength(2);
    expect(manager.runningSessions).not.toContain(SP2);
  });

  it("suspendForSession saves cold URL and marks not running", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockResolvedValue({});
    manager._saveColdUrl = vi.fn();

    await manager.launch(SP1);
    manager._sessions.get(SP1).url = "https://example.com/page";

    await manager.suspendForSession(SP1);

    expect(manager._saveColdUrl).toHaveBeenCalledWith(SP1, "https://example.com/page");
    expect(manager.isRunning(SP1)).toBe(false);
    // suspend 后 entry 从 Map 中移除（冷状态已写磁盘，避免僵尸条目累积）
    expect(manager._sessions.has(SP1)).toBe(false);
  });

  it("closeBrowserForSession on running session delegates to close()", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockResolvedValue({});
    manager._removeColdUrl = vi.fn();

    await manager.launch(SP1);

    await manager.closeBrowserForSession(SP1);

    expect(manager._sessions.has(SP1)).toBe(false);
    expect(manager._removeColdUrl).toHaveBeenCalledWith(SP1);
  });

  it("closeBrowserForSession on suspended session destroys view", async () => {
    const manager = new BrowserManager();
    const cmds = [];
    manager._sendCmd = vi.fn().mockImplementation(async (cmd) => {
      cmds.push(cmd);
      return {};
    });
    manager._saveColdUrl = vi.fn();
    manager._removeColdUrl = vi.fn();

    await manager.launch(SP1);
    manager._sessions.get(SP1).url = "https://example.com";
    await manager.suspendForSession(SP1);

    cmds.length = 0; // reset tracking

    await manager.closeBrowserForSession(SP1);

    expect(cmds).toContain("destroyView");
    expect(manager._sessions.has(SP1)).toBe(false);
    expect(manager._removeColdUrl).toHaveBeenCalledWith(SP1);
  });
});
