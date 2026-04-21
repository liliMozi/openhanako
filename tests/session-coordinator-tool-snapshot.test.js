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
// and flow through buildTools.customTools.
const HANAKO_CUSTOM_OBJS = [
  "search_memory", "pin_memory", "unpin_memory", "web_search",
  "web_fetch", "todo_write", "create_artifact", "notify",
  "stage_files", "subagent", "channel", "record_experience",
  "recall_experience", "check_pending_tasks", "wait", "stop_task",
  "browser", "cron", "dm", "install_skill", "update_settings",
].map(makeTool);

function allNames() {
  return [
    ...SDK_BUILTIN_OBJS.map((t) => t.name),
    ...HANAKO_CUSTOM_OBJS.map((t) => t.name),
  ];
}

describe("session-coordinator tool snapshot (createSession)", () => {
  let tmpDir, agentDir, sessionDir, coord, fakeSessionPath, activeToolsSpy, currentAgentConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-snapshot-"));
    agentDir = path.join(tmpDir, "agents", "test");
    sessionDir = path.join(agentDir, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    fakeSessionPath = path.join(sessionDir, "test-session.jsonl");

    currentAgentConfig = {}; // tests mutate this before calling createSession

    activeToolsSpy = vi.fn();

    sessionManagerCreateMock.mockReturnValue({ getCwd: () => tmpDir });
    sessionManagerOpenMock.mockReturnValue({ getCwd: () => tmpDir });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => fakeSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model", name: "test-model" },
        setActiveToolsByName: activeToolsSpy,
      },
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
        resolveThinkingLevel: () => "medium",
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
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
      getDeferredResultStore: () => null,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Case C tests ─────────────────────────────────────────────

  it("Case C: new session with NO tools config applies DEFAULT_DISABLED (update_settings + dm off)", async () => {
    currentAgentConfig = {}; // fresh agent or upgrade, tools field absent
    await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).not.toContain("update_settings");
    expect(appliedList).not.toContain("dm");
    // everything else still on
    expect(appliedList).toContain("browser");
    expect(appliedList).toContain("cron");
    expect(appliedList).toContain("install_skill");
    expect(appliedList).toContain("read"); // SDK built-in preserved
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

  // ── setPlanMode post-creation (P2) ──────────────────────────

  it("setPlanMode ON after session creation preserves disabled-tool choice via sessionEntry.toolNames", async () => {
    currentAgentConfig = { tools: { disabled: ["browser"] } };
    await coord.createSession(null, tmpDir, true);
    expect(activeToolsSpy).toHaveBeenCalledTimes(1); // initial snapshot apply

    // Now toggle plan mode ON
    coord.setPlanMode(true, SDK_BUILTIN_OBJS);

    // Second setActiveToolsByName call from plan mode
    expect(activeToolsSpy).toHaveBeenCalledTimes(2);
    const planOnList = activeToolsSpy.mock.calls[1][0];
    // Read-only SDK subset present
    expect(planOnList).toContain("read");
    expect(planOnList).toContain("grep");
    expect(planOnList).toContain("find");
    expect(planOnList).toContain("ls");
    // Write-capable SDK tools absent in plan mode
    expect(planOnList).not.toContain("bash");
    expect(planOnList).not.toContain("edit");
    expect(planOnList).not.toContain("write");
    // Custom tool that was NOT disabled stays available
    expect(planOnList).toContain("cron");
    // Custom tool that WAS disabled stays disabled even in plan mode
    expect(planOnList).not.toContain("browser");
  });

  it("setPlanMode OFF after plan-on restores the snapshot (not raw agent.tools)", async () => {
    currentAgentConfig = { tools: { disabled: ["browser"] } };
    await coord.createSession(null, tmpDir, true);
    coord.setPlanMode(true, SDK_BUILTIN_OBJS);
    coord.setPlanMode(false, SDK_BUILTIN_OBJS);

    const planOffList = activeToolsSpy.mock.calls[2][0];
    // All SDK built-ins back
    for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
      expect(planOffList).toContain(name);
    }
    // Customs respecting the snapshot
    expect(planOffList).toContain("cron");
    expect(planOffList).not.toContain("browser"); // still disabled per snapshot
  });

  it("setPlanMode on legacy session (toolNames=null) falls back to raw agent.tools", async () => {
    // Pre-write meta WITHOUT toolNames
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(fakeSessionPath)]: { memoryEnabled: true } }, null, 2),
    );
    await coord.createSession(null, tmpDir, true, null, { restore: true });
    // Case B: no initial snapshot applied
    expect(activeToolsSpy).not.toHaveBeenCalled();

    coord.setPlanMode(true, SDK_BUILTIN_OBJS);

    // Plan mode still applies read-only SDK + full agent.tools (legacy fallback)
    const planList = activeToolsSpy.mock.calls[0][0];
    expect(planList).toContain("read");
    expect(planList).toContain("browser"); // not disabled — legacy session sees all customs
    expect(planList).toContain("cron");
  });
});
