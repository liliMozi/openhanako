/**
 * memory-ticker _doDaily 步骤编排测试
 *
 * 关键路径：
 * - 5 个步骤各自独立 try-catch
 * - compileLongterm 依赖 compileWeek（compileWeek 失败则跳过）
 * - 断点续跑：已完成步骤在重试时跳过
 * - assemble 总是执行（step 4）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

// ── Mock compile / deep-memory / debug ──

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

// ── Import under test ──

import { createMemoryTicker } from "../lib/memory/memory-ticker.js";
import {
  compileToday,
  compileWeek,
  compileLongterm,
  compileFacts,
  assemble,
} from "../lib/memory/compile.js";
import { processDirtySessions } from "../lib/memory/deep-memory.js";

// ── Helpers ──

function makeTicker(tmpDir) {
  fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });

  return createMemoryTicker({
    summaryManager: {
      rollingSummary: vi.fn().mockResolvedValue(),
      getSummary: vi.fn().mockReturnValue(null),
      listSummaries: vi.fn().mockReturnValue([]),
    },
    configPath: path.join(tmpDir, "config.yaml"),
    factStore: {},
    getResolvedMemoryModel: () => ({ model: "test-model", provider: "test", api: "openai-completions", api_key: "test-key", base_url: "http://localhost:1234" }),
    onCompiled: vi.fn(),
    sessionDir: path.join(tmpDir, "sessions"),
    memoryMdPath: path.join(tmpDir, "memory.md"),
    todayMdPath: path.join(tmpDir, "today.md"),
    weekMdPath: path.join(tmpDir, "week.md"),
    longtermMdPath: path.join(tmpDir, "longterm.md"),
    factsMdPath: path.join(tmpDir, "facts.md"),
  });
}

// ── Tests ──

describe("_doDaily step orchestration", () => {
  let tmpDir;
  let ticker;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-test-"));
    ticker = makeTicker(tmpDir);
  });

  afterEach(() => {
    ticker.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs all 5 steps when everything succeeds", async () => {
    await ticker.tick();

    expect(compileWeek).toHaveBeenCalledOnce();
    expect(compileLongterm).toHaveBeenCalledOnce();
    expect(compileFacts).toHaveBeenCalledOnce();
    expect(processDirtySessions).toHaveBeenCalledOnce();
    // daily step 0 + final compileTodayAndAssemble
    expect(compileToday).toHaveBeenCalledTimes(2);
    // assemble: once in _doDaily(step 4) + once in _doCompileTodayAndAssemble
    expect(assemble).toHaveBeenCalledTimes(2);
  });

  it("skips compileLongterm when compileWeek fails (dependency)", async () => {
    compileWeek.mockRejectedValueOnce(new Error("LLM timeout"));

    await ticker.tick();

    expect(compileWeek).toHaveBeenCalledOnce();
    expect(compileLongterm).not.toHaveBeenCalled();
    // independent steps still run
    expect(compileFacts).toHaveBeenCalledOnce();
    expect(processDirtySessions).toHaveBeenCalledOnce();
    expect(assemble).toHaveBeenCalled();
  });

  it("retries only failed steps on second tick (checkpoint resume)", async () => {
    // First tick: compileWeek fails
    compileWeek.mockRejectedValueOnce(new Error("network error"));
    await ticker.tick();

    vi.clearAllMocks();

    // Second tick: compileWeek should retry + compileLongterm should run
    await ticker.tick();

    expect(compileWeek).toHaveBeenCalledOnce();
    expect(compileLongterm).toHaveBeenCalledOnce();
    // Already completed in first tick — should be skipped
    expect(compileFacts).not.toHaveBeenCalled();
    expect(processDirtySessions).not.toHaveBeenCalled();
  });

  it("does not re-run _doDaily after full success", async () => {
    await ticker.tick();
    vi.clearAllMocks();

    // Second tick: _lastDailyJobDate already set → _doDaily skipped
    await ticker.tick();

    expect(compileWeek).not.toHaveBeenCalled();
    expect(compileLongterm).not.toHaveBeenCalled();
    expect(compileFacts).not.toHaveBeenCalled();
    expect(processDirtySessions).not.toHaveBeenCalled();
    // _doCompileTodayAndAssemble always runs regardless
    expect(compileToday).toHaveBeenCalledOnce();
    expect(assemble).toHaveBeenCalledOnce();
  });

  it("compileFacts failure does not block other steps", async () => {
    compileFacts.mockRejectedValueOnce(new Error("facts error"));

    await ticker.tick();

    expect(compileWeek).toHaveBeenCalledOnce();
    expect(compileLongterm).toHaveBeenCalledOnce();
    expect(processDirtySessions).toHaveBeenCalledOnce();
    expect(assemble).toHaveBeenCalled();
  });

  it("deepMemory failure retries on next tick", async () => {
    processDirtySessions.mockRejectedValueOnce(new Error("db locked"));
    await ticker.tick();

    vi.clearAllMocks();
    await ticker.tick();

    // Only deepMemory should retry
    expect(compileWeek).not.toHaveBeenCalled();
    expect(compileLongterm).not.toHaveBeenCalled();
    expect(compileFacts).not.toHaveBeenCalled();
    expect(processDirtySessions).toHaveBeenCalledOnce();
  });

  it("multiple failures: both compileWeek and compileFacts retry together", async () => {
    compileWeek.mockRejectedValueOnce(new Error("fail1"));
    compileFacts.mockRejectedValueOnce(new Error("fail2"));
    await ticker.tick();

    vi.clearAllMocks();
    await ticker.tick();

    // Both should retry
    expect(compileWeek).toHaveBeenCalledOnce();
    expect(compileFacts).toHaveBeenCalledOnce();
    // compileLongterm depends on compileWeek — should now run
    expect(compileLongterm).toHaveBeenCalledOnce();
    // deepMemory already succeeded — skipped
    expect(processDirtySessions).not.toHaveBeenCalled();
  });

  it("assemble runs even when all LLM steps fail", async () => {
    compileWeek.mockRejectedValueOnce(new Error("fail"));
    compileFacts.mockRejectedValueOnce(new Error("fail"));
    processDirtySessions.mockRejectedValueOnce(new Error("fail"));

    await ticker.tick();

    // assemble (step 4) always executes
    expect(assemble).toHaveBeenCalled();
  });
});
