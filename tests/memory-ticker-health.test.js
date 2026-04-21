/**
 * memory-ticker getHealthStatus API 测试
 *
 * 验证每步（rollingSummary / compileToday / compileWeek / compileLongterm /
 * compileFacts / deepMemory）的成功/失败都记录在 _health，并通过
 * getHealthStatus() 暴露，供 UI 层判断"记忆编译是否在静默失败"。
 */

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
import {
  compileToday,
  compileWeek,
  compileFacts,
} from "../lib/memory/compile.js";
import { processDirtySessions } from "../lib/memory/deep-memory.js";

function writeSession(sessionPath) {
  const lines = [
    { type: "message", timestamp: "2026-04-17T10:00:00.000Z", message: { role: "user", content: "hi" } },
    { type: "message", timestamp: "2026-04-17T10:00:10.000Z", message: { role: "assistant", content: "hello" } },
  ];
  fs.writeFileSync(sessionPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function makeTicker(tmpDir, summaryManagerOverride) {
  fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });
  const summaryManager = summaryManagerOverride || {
    rollingSummary: vi.fn().mockResolvedValue("summary"),
    getSummary: vi.fn().mockReturnValue(null),
  };
  return createMemoryTicker({
    summaryManager,
    configPath: path.join(tmpDir, "config.yaml"),
    factStore: {},
    getResolvedMemoryModel: () => ({ model: "m", provider: "p", api: "openai-completions", api_key: "k", base_url: "http://x" }),
    sessionDir: path.join(tmpDir, "sessions"),
    memoryMdPath: path.join(tmpDir, "memory.md"),
    todayMdPath: path.join(tmpDir, "today.md"),
    weekMdPath: path.join(tmpDir, "week.md"),
    longtermMdPath: path.join(tmpDir, "longterm.md"),
    factsMdPath: path.join(tmpDir, "facts.md"),
  });
}

describe("memory-ticker getHealthStatus", () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-health-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exposes initial health status with all null fields", () => {
    const ticker = makeTicker(tmpDir);
    const h = ticker.getHealthStatus();

    for (const key of ["rollingSummary", "compileToday", "compileWeek", "compileLongterm", "compileFacts", "deepMemory"]) {
      expect(h[key]).toEqual({
        lastSuccessAt: null,
        lastErrorAt: null,
        lastErrorMsg: null,
        failCount: 0,
      });
    }
  });

  it("records lastSuccessAt for each step after a successful tick", async () => {
    const ticker = makeTicker(tmpDir);
    await ticker.tick();

    const h = ticker.getHealthStatus();
    expect(h.compileToday.lastSuccessAt).not.toBeNull();
    expect(h.compileWeek.lastSuccessAt).not.toBeNull();
    expect(h.compileLongterm.lastSuccessAt).not.toBeNull();
    expect(h.compileFacts.lastSuccessAt).not.toBeNull();
    expect(h.deepMemory.lastSuccessAt).not.toBeNull();
    // 所有步骤都应无错误
    for (const key of ["compileToday", "compileWeek", "compileLongterm", "compileFacts", "deepMemory"]) {
      expect(h[key].lastErrorMsg).toBeNull();
      expect(h[key].failCount).toBe(0);
    }
  });

  it("records lastErrorMsg + increments failCount on step failure", async () => {
    compileFacts.mockRejectedValueOnce(new Error("boom"));
    const ticker = makeTicker(tmpDir);
    await ticker.tick();

    const h = ticker.getHealthStatus();
    expect(h.compileFacts.lastErrorMsg).toBe("boom");
    expect(h.compileFacts.lastErrorAt).not.toBeNull();
    expect(h.compileFacts.failCount).toBe(1);
    // 其他步骤不受影响
    expect(h.compileWeek.failCount).toBe(0);
    expect(h.compileToday.failCount).toBe(0);
  });

  it("clears error state once a failing step recovers", async () => {
    compileFacts.mockRejectedValueOnce(new Error("boom1"));
    const ticker = makeTicker(tmpDir);
    await ticker.tick();
    expect(ticker.getHealthStatus().compileFacts.failCount).toBe(1);

    // 第二次 tick：compileFacts 成功（mock 默认返回）
    await ticker.tick();

    const h = ticker.getHealthStatus();
    expect(h.compileFacts.lastErrorMsg).toBeNull();
    expect(h.compileFacts.lastErrorAt).toBeNull();
    expect(h.compileFacts.failCount).toBe(0);
    expect(h.compileFacts.lastSuccessAt).not.toBeNull();
  });

  it("increments failCount on consecutive failures", async () => {
    compileFacts.mockRejectedValue(new Error("persistent"));
    const ticker = makeTicker(tmpDir);

    await ticker.tick();
    await ticker.tick();
    await ticker.tick();

    const h = ticker.getHealthStatus();
    expect(h.compileFacts.failCount).toBeGreaterThanOrEqual(2);
    expect(h.compileFacts.lastErrorMsg).toBe("persistent");
  });

  it("tracks rollingSummary failure from notifyTurn → _doRollingSummary", async () => {
    const rollingSummary = vi.fn().mockRejectedValue(new Error("llm down"));
    const ticker = makeTicker(tmpDir, {
      rollingSummary,
      getSummary: vi.fn().mockReturnValue(null),
    });

    const sessionPath = path.join(tmpDir, "sessions", "s1.jsonl");
    writeSession(sessionPath);

    // 触发 6 次 notifyTurn 才会跑一次 rollingSummary
    for (let i = 0; i < 6; i++) ticker.notifyTurn(sessionPath);
    // 等异步完成
    await new Promise((r) => setTimeout(r, 50));

    const h = ticker.getHealthStatus();
    expect(h.rollingSummary.lastErrorMsg).toBe("llm down");
    expect(h.rollingSummary.failCount).toBeGreaterThanOrEqual(1);
  });

  it("returns a deep copy that cannot mutate internal state", () => {
    const ticker = makeTicker(tmpDir);
    const h1 = ticker.getHealthStatus();
    h1.compileToday.failCount = 999;
    const h2 = ticker.getHealthStatus();
    expect(h2.compileToday.failCount).toBe(0);
  });
});
