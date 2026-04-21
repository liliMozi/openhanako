import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

vi.mock("../lib/memory/compile.js", () => ({
  compileToday: vi.fn().mockResolvedValue("compiled"),
  compileWeek: vi.fn().mockResolvedValue("compiled"),
  compileLongterm: vi.fn().mockResolvedValue("compiled"),
  compileFacts: vi.fn().mockResolvedValue("compiled"),
  assemble: vi.fn(),
}));

vi.mock("../lib/memory/deep-memory.js", () => ({
  processDirtySessions: vi.fn().mockResolvedValue({ processed: 0, factsAdded: 0 }),
}));

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
}));

import { createMemoryTicker } from "../lib/memory/memory-ticker.js";
import { compileToday, assemble } from "../lib/memory/compile.js";

function writeSession(sessionPath) {
  const lines = [
    {
      type: "message",
      timestamp: "2026-03-12T15:47:53.599Z",
      message: { role: "user", content: "hello" },
    },
    {
      type: "message",
      timestamp: "2026-03-12T15:48:04.225Z",
      message: { role: "assistant", content: "world" },
    },
  ];
  fs.writeFileSync(sessionPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
}

function makeTicker(tmpDir, isSessionMemoryEnabled) {
  const summaryManager = {
    rollingSummary: vi.fn().mockResolvedValue("summary"),
    getSummary: vi.fn().mockReturnValue(null),
  };

  const ticker = createMemoryTicker({
    summaryManager,
    configPath: path.join(tmpDir, "config.yaml"),
    factStore: {},
    getResolvedMemoryModel: () => ({ model: "test-model", provider: "test", api: "openai-completions", api_key: "test-key", base_url: "http://localhost:1234" }),
    getMemoryMasterEnabled: () => true,
    isSessionMemoryEnabled,
    onCompiled: vi.fn(),
    sessionDir: path.join(tmpDir, "sessions"),
    memoryMdPath: path.join(tmpDir, "memory.md"),
    todayMdPath: path.join(tmpDir, "today.md"),
    weekMdPath: path.join(tmpDir, "week.md"),
    longtermMdPath: path.join(tmpDir, "longterm.md"),
    factsMdPath: path.join(tmpDir, "facts.md"),
  });

  return { ticker, summaryManager };
}

describe("memory ticker respects session-level memory toggle", () => {
  let tmpDir;
  let sessionPath;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-memory-toggle-"));
    fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });
    sessionPath = path.join(tmpDir, "sessions", "2026-03-12T15-47-53-568Z_test.jsonl");
    writeSession(sessionPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips summary + compile when the session memory is disabled", async () => {
    const { ticker, summaryManager } = makeTicker(tmpDir, () => false);

    ticker.notifyTurn(sessionPath);
    await ticker.notifySessionEnd(sessionPath);

    expect(summaryManager.rollingSummary).not.toHaveBeenCalled();
    expect(compileToday).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
  });

  it("still summarizes the session when the session memory is enabled", async () => {
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true);

    ticker.notifyTurn(sessionPath);
    await ticker.notifySessionEnd(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    expect(compileToday).toHaveBeenCalled();
    expect(assemble).toHaveBeenCalled();
  });
});
