/**
 * Integration test for createSession tool snapshot behavior (Task 5).
 *
 * Covers the three branches:
 *   A. restore=true + meta has toolNames  → replay snapshot
 *   B. restore=true + meta missing        → legacy, keep all tools
 *   C. restore=false                       → fresh compute from config
 * Plus tampering protection: core tools survive even if listed in disabled.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";

const { createAgentSessionMock, sessionManagerCreateMock, sessionManagerOpenMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
  sessionManagerOpenMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  SessionManager: {
    create: sessionManagerCreateMock,
    open: sessionManagerOpenMock,
  },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
  estimateTokens: vi.fn(() => 0),
  findCutPoint: vi.fn(),
  generateSummary: vi.fn(),
  emitSessionShutdown: vi.fn(),
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { SessionCoordinator } from "../core/session-coordinator.js";

// Fake tool objects — only needs `.name` to satisfy `.map(t => t.name)` paths
function makeTool(name) {
  return { name, execute: vi.fn() };
}

// Pi SDK built-in tools — in production these come from
// createSandboxedTools().tools, NOT from agent.tools. Mirror that structure so
// tests exercise the real code paths.
const SDK_BUILTIN_OBJS = [
  "read", "bash", "edit", "write", "grep", "find", "ls",
].map(makeTool);

// OpenHanako custom tools — in production these come from agent.tools getter
// and flow through buildTools.customTools. create_artifact is intentionally
// absent from fresh sessions; it is a restore-only compatibility tool.
const HANAKO_CUSTOM_OBJS = [
  "search_memory", "pin_memory", "unpin_memory", "web_search",
  "web_fetch", "todo_write", "notify",
  "stage_files", "subagent", "channel", "record_experience",
  "recall_experience", "check_pending_tasks", "current_status", "wait", "stop_task",
  "browser", "cron", "dm", "install_skill", "update_settings",
].map(makeTool);

function allNames() {
  return [
    ...SDK_BUILTIN_OBJS.map((t) => t.name),
    ...HANAKO_CUSTOM_OBJS.map((t) => t.name),
  ];
}

describe("session-coordinator tool snapshot (createSession)", () => {
  let tmpDir, agentDir, sessionDir, coord, fakeSessionPath, activeToolsSpy, currentAgentConfig, defaultModeSaveSpy, storedDefaultMode, storedThinkingLevel, lastSessionOptions, fakeEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-snapshot-"));
    agentDir = path.join(tmpDir, "agents", "test");
    sessionDir = path.join(agentDir, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    fakeSessionPath = path.join(sessionDir, "test-session.jsonl");

    currentAgentConfig = {}; // tests mutate this before calling createSession

    activeToolsSpy = vi.fn();
    defaultModeSaveSpy = vi.fn();
    storedDefaultMode = "ask";
    storedThinkingLevel = "auto";
    lastSessionOptions = null;
    fakeEngine = {
      getUiContext: vi.fn(() => null),
      isVisionAuxiliaryEnabled: vi.fn(() => false),
      getVisionBridge: vi.fn(() => null),
    };

    sessionManagerCreateMock.mockReturnValue({ getCwd: () => tmpDir });
    sessionManagerOpenMock.mockReturnValue({ getCwd: () => tmpDir });
    createAgentSessionMock.mockImplementation(async (options) => {
      lastSessionOptions = options;
      return {
      session: {
        sessionManager: { getSessionFile: () => fakeSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model", name: "test-model" },
        setActiveToolsByName: activeToolsSpy,
      },
      };
    });

    const agent = {
      id: "test",
      agentDir,
      sessionDir,
      tools: HANAKO_CUSTOM_OBJS,
      get config() { return currentAgentConfig; },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "mock-prompt",
      memoryEnabled: true,
    };

    coord = new SessionCoordinator({
      agentsDir: path.join(tmpDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "test",
      getModels: () => ({
        currentModel: { id: "test-model", name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: (level) => level === "auto" ? "medium" : level,
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "mock-prompt",
        getAppendSystemPrompt: () => [],
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: SDK_BUILTIN_OBJS, customTools: HANAKO_CUSTOM_OBJS }),
      emitEvent: vi.fn(),
      emitDevLog: vi.fn(),
      getHomeCwd: () => tmpDir,
      agentIdFromSessionPath: () => "test",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({
        getThinkingLevel: () => storedThinkingLevel,
        getSessionPermissionModeDefault: () => storedDefaultMode,
        setSessionPermissionModeDefault: defaultModeSaveSpy,
      }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
      getDeferredResultStore: () => null,
      getEngine: () => fakeEngine,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Case C tests ─────────────────────────────────────────────

  it("Case C: new session with NO tools config applies DEFAULT_DISABLED (update_settings + dm off)", async () => {
    currentAgentConfig = {}; // fresh agent or upgrade, tools field absent
    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).not.toContain("update_settings");
    expect(appliedList).not.toContain("dm");
    // everything else still on
    expect(appliedList).toContain("browser");
    expect(appliedList).toContain("cron");
    expect(appliedList).toContain("install_skill");
    expect(appliedList).toContain("read"); // SDK built-in preserved
    expect(coord.getAccessMode()).toBe("operate");

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionPath)].accessMode).toBe("operate");
  });

  it("starts fresh sessions in ask even when an old persisted default says operate", async () => {
    storedDefaultMode = "operate";
    currentAgentConfig = { tools: { disabled: [] } };

    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    expect(coord.getPermissionModeDefault()).toBe("ask");
    expect(coord.getPermissionMode(sessionPath)).toBe("ask");
    expect(coord.getAccessMode(sessionPath)).toBe("operate");
    expect(defaultModeSaveSpy).not.toHaveBeenCalled();

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionPath)]).toMatchObject({
      permissionMode: "ask",
      accessMode: "operate",
      planMode: false,
    });
  });

  it("remembers the last selected permission mode only for the current app run", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    const { sessionPath: firstPath } = await coord.createSession(null, tmpDir, true);

    coord.setPermissionMode("operate");

    const secondSessionPath = path.join(sessionDir, "second-session.jsonl");
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => secondSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model", name: "test-model" },
        setActiveToolsByName: activeToolsSpy,
      },
    });
    const { sessionPath: secondPath } = await coord.createSession(null, tmpDir, true);

    expect(coord.getPermissionMode(firstPath)).toBe("operate");
    expect(coord.getPermissionMode(secondPath)).toBe("operate");
    expect(coord.getPermissionModeDefault()).toBe("operate");
    expect(defaultModeSaveSpy).not.toHaveBeenCalled();
  });

  it("can stage a pending new-session permission mode without mutating the active session", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    const { sessionPath: activePath } = await coord.createSession(null, tmpDir, true);

    const result = coord.setPendingPermissionMode("read_only");

    expect(result).toMatchObject({ ok: true, mode: "read_only", enabled: true });
    expect(coord.getPermissionMode(activePath)).toBe("ask");
    expect(coord.getPermissionModeDefault()).toBe("read_only");

    const secondSessionPath = path.join(sessionDir, "pending-read-only.jsonl");
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => secondSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model", name: "test-model" },
        setActiveToolsByName: activeToolsSpy,
      },
    });
    const { sessionPath: nextPath } = await coord.createSession(null, tmpDir, true);

    expect(coord.getPermissionMode(nextPath)).toBe("read_only");
    expect(defaultModeSaveSpy).not.toHaveBeenCalled();
  });

  it("persists the resolved thinking level as session-owned state when creating a session", async () => {
    storedThinkingLevel = "high";
    currentAgentConfig = { tools: { disabled: [] } };

    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    expect(lastSessionOptions.thinkingLevel).toBe("high");
    expect(coord.getSessionThinkingLevel(sessionPath)).toBe("high");

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionPath)]).toMatchObject({
      thinkingLevel: "high",
    });
  });

  it("can switch only the current session permission mode without mutating the runtime default", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    const { sessionPath: firstPath } = await coord.createSession(null, tmpDir, true);

    const result = coord.setCurrentSessionPermissionMode("operate");

    expect(result).toMatchObject({ ok: true, mode: "operate", enabled: false });
    expect(coord.getPermissionMode(firstPath)).toBe("operate");
    expect(coord.getPermissionModeDefault()).toBe("ask");

    const secondSessionPath = path.join(sessionDir, "second-ask-session.jsonl");
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => secondSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model", name: "test-model" },
        setActiveToolsByName: activeToolsSpy,
      },
    });
    const { sessionPath: secondPath } = await coord.createSession(null, tmpDir, true);

    expect(coord.getPermissionMode(secondPath)).toBe("ask");
    expect(defaultModeSaveSpy).not.toHaveBeenCalled();

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(firstPath)]).toMatchObject({
      permissionMode: "operate",
      accessMode: "operate",
      planMode: false,
    });
    expect(meta[path.basename(secondPath)]).toMatchObject({
      permissionMode: "ask",
      accessMode: "operate",
      planMode: false,
    });
  });

  it("can switch an explicit loaded session permission mode without relying on focus", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    const { sessionPath: firstPath } = await coord.createSession(null, tmpDir, true);
    coord.setPermissionMode("read_only");

    const secondSessionPath = path.join(sessionDir, "focused-session.jsonl");
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => secondSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model", name: "test-model" },
        setActiveToolsByName: activeToolsSpy,
      },
    });
    const { sessionPath: secondPath } = await coord.createSession(null, tmpDir, true);
    expect(coord.currentSessionPath).toBe(secondPath);

    const result = coord.setSessionPermissionMode(firstPath, "operate");

    expect(result).toMatchObject({ ok: true, mode: "operate", enabled: false });
    expect(coord.getPermissionMode(firstPath)).toBe("operate");
    expect(coord.getPermissionMode(secondPath)).toBe("read_only");
    expect(coord.getPermissionModeDefault()).toBe("read_only");
  });

  it("new session with pending read-only access mode keeps tool schema stable", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    coord.setPendingAccessMode("read_only");

    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).toEqual(allNames());

    const entry = coord._sessions.get(sessionPath);
    expect(entry.accessMode).toBe("read_only");
    expect(entry.permissionMode).toBe("read_only");
    expect(entry.planMode).toBe(true);

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionPath)].permissionMode).toBe("read_only");
    expect(meta[path.basename(sessionPath)].accessMode).toBe("read_only");
  });

  it("Case C: new session with EXPLICIT empty disabled includes all tools in snapshot", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    // setActiveToolsByName should have been called with the full list
    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).toEqual(allNames());

    // sessionEntry.toolNames should match
    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).toEqual(allNames());

    // Persisted to meta
    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(fakeSessionPath)].toolNames).toEqual(allNames());
  });

  it("Case C: snapshot includes Pi SDK built-ins (regression for P1 — bundle must carry read/bash/etc)", async () => {
    currentAgentConfig = { tools: { disabled: ["browser"] } };
    await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    // All 7 Pi SDK built-ins must be in the active set even though agent.tools
    // doesn't contain them — they come from sessionTools. Without the P1 fix,
    // setActiveToolsByName would receive only custom tool names and silently
    // disable read/bash/edit/write/grep/find/ls for every fresh session.
    for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
      expect(appliedList).toContain(name);
    }
  });

  it("Case C: browser disabled is excluded from snapshot", async () => {
    currentAgentConfig = { tools: { disabled: ["browser"] } };
    await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).not.toContain("browser");
    expect(appliedList).toContain("cron");
    expect(appliedList).toContain("read");
  });

  it("Case C: tampering with core tool name still keeps it (subset tamper protection)", async () => {
    currentAgentConfig = { tools: { disabled: ["browser", "read"] } };
    await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).toContain("read");  // core tool preserved
    expect(appliedList).not.toContain("browser");  // optional tool excluded
  });

  it("Case C: persists toolNames to session-meta.json", async () => {
    currentAgentConfig = { tools: { disabled: ["browser", "cron"] } };
    await coord.createSession(null, tmpDir, true);

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    const persisted = meta[path.basename(fakeSessionPath)].toolNames;
    expect(persisted).not.toContain("browser");
    expect(persisted).not.toContain("cron");
    expect(persisted).toContain("dm");
    expect(persisted).toContain("install_skill");
  });

  // ── Case A tests ─────────────────────────────────────────────

  it("Case A: restore with meta containing toolNames replays that exact snapshot", async () => {
    // Pre-write meta with a specific short snapshot
    const replayList = ["read", "bash", "edit", "todo_write"];
    const metaPath = path.join(sessionDir, "session-meta.json");
    await fsp.writeFile(
      metaPath,
      JSON.stringify({ [path.basename(fakeSessionPath)]: { toolNames: replayList } }, null, 2),
    );

    await coord.createSession(null, tmpDir, true, null, { restore: true });

    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    expect(activeToolsSpy.mock.calls[0][0]).toEqual(replayList);
  });

  // ── Case B tests ─────────────────────────────────────────────

  it("Case B: restore with meta missing toolNames does NOT call setActiveToolsByName", async () => {
    // Pre-write meta WITHOUT toolNames
    const metaPath = path.join(sessionDir, "session-meta.json");
    await fsp.writeFile(
      metaPath,
      JSON.stringify({ [path.basename(fakeSessionPath)]: { memoryEnabled: true } }, null, 2),
    );

    const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

    expect(activeToolsSpy).not.toHaveBeenCalled();

    // sessionEntry.toolNames is null (not undefined, not [])
    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).toBeNull();
  });

  it("Case B: restore when session-meta.json doesn't exist also keeps all tools", async () => {
    // No meta file on disk
    const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

    expect(activeToolsSpy).not.toHaveBeenCalled();
    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).toBeNull();
  });

  // ── Meta read-failure fallback (P2) ──────────────────────────

  it("restore with unreadable session-meta.json recomputes from current config (fallback) instead of enabling all tools", async () => {
    // Write malformed JSON to trigger a parse error (non-ENOENT)
    await fsp.writeFile(path.join(sessionDir, "session-meta.json"), "{ not valid json ]", "utf-8");
    currentAgentConfig = { tools: { disabled: ["browser"] } };

    const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

    // Snapshot must have been applied (not silent Case B fallback)
    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).not.toContain("browser"); // current disabled list honored
    expect(appliedList).toContain("cron");
    expect(appliedList).toContain("read");

    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).not.toContain("browser");
  });

  // ── Runtime permission mode after session creation ─────────────────────

  it("updates setPlanMode after session creation and leaves active tools unchanged", async () => {
    currentAgentConfig = { tools: { disabled: ["browser"] } };
    const { sessionPath } = await coord.createSession(null, tmpDir, true);
    expect(activeToolsSpy).toHaveBeenCalledTimes(1); // initial snapshot apply

    const result = coord.setPlanMode(true, SDK_BUILTIN_OBJS.map((t) => t.name));

    expect(result).toMatchObject({ ok: true, mode: "read_only", enabled: true });
    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    expect(defaultModeSaveSpy).not.toHaveBeenCalled();
    expect(coord.getPermissionModeDefault()).toBe("read_only");
    expect(coord.getAccessMode()).toBe("read_only");
    expect(coord.getPermissionMode(sessionPath)).toBe("read_only");
  });

  it("keeps runtime permission changes out of dynamic append system prompt", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    await coord.createSession(null, tmpDir, true);

    const before = lastSessionOptions.resourceLoader.getAppendSystemPrompt();
    coord.setPermissionMode("read_only");
    const after = lastSessionOptions.resourceLoader.getAppendSystemPrompt();

    expect(after).toEqual(before);
    expect(after.join("\n")).not.toMatch(/READ-ONLY MODE|ASK MODE|只读模式|先问模式/);
  });

  it("does not inject passive UI context into the last user message", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    fakeEngine.getUiContext.mockReturnValue({
      currentViewed: tmpDir,
      activeFile: path.join(tmpDir, "diary.md"),
      activePreview: null,
      pinnedFiles: [],
    });
    await coord.createSession(null, tmpDir, true);

    const extensions = lastSessionOptions.resourceLoader.getExtensions().extensions;
    const contextHandlers = extensions.flatMap((extension) => extension.handlers?.get?.("context") || []);
    const messages = [{ role: "user", content: "跑一遍测试" }];
    for (const handler of contextHandlers) {
      await handler({ messages }, {
        cwd: tmpDir,
        sessionManager: { getSessionFile: () => fakeSessionPath },
      });
    }

    expect(messages).toEqual([{ role: "user", content: "跑一遍测试" }]);
  });

  it("restores accessMode from session meta before applying tools", async () => {
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({
        [path.basename(fakeSessionPath)]: {
          memoryEnabled: true,
          accessMode: "read_only",
          toolNames: allNames(),
        },
      }, null, 2),
    );
    await coord.createSession(null, tmpDir, true, null, { restore: true });

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).toContain("browser");
    expect(appliedList).toContain("web_search");
    expect(appliedList).toContain("bash");
    expect(coord.getAccessMode()).toBe("read_only");
  });

  it("maps legacy planMode meta to read-only access mode", async () => {
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({
        [path.basename(fakeSessionPath)]: {
          memoryEnabled: true,
          planMode: true,
          toolNames: allNames(),
        },
      }, null, 2),
    );
    await coord.createSession(null, tmpDir, true, null, { restore: true });

    const planList = activeToolsSpy.mock.calls[0][0];
    expect(planList).toContain("read");
    expect(planList).toContain("browser");
    expect(planList).toContain("bash");
    expect(planList).toContain("cron");
    expect(coord.getAccessMode()).toBe("read_only");
  });
});
