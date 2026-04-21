/**
 * compile.js fingerprint 陷阱修复测试
 *
 * 场景：rollingSummary 持续失败导致 session_summary 表没有新数据，
 * compileToday / compileWeek 每次都看到 sessions=[]。老实现会写一个
 * "empty" fingerprint，使后续恢复后的首次调用仍然命中 fingerprint skip，
 * today.md / week.md 永远不会被重新编译。
 *
 * 新行为：sessions 为空时不写 fingerprint，确保恢复路径可用。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn().mockResolvedValue("compiled content from llm"),
}));

vi.mock("../server/i18n.js", () => ({
  getLocale: () => "zh-CN",
}));

import { compileToday, compileWeek } from "../lib/memory/compile.js";
import { callText } from "../core/llm-client.js";

function makeFakeSummaryManager(summaries) {
  return {
    getSummariesInRange: vi.fn().mockReturnValue(summaries),
  };
}

const RESOLVED_MODEL = { model: "m", api: "openai-completions", api_key: "k", base_url: "http://x" };

describe("compileToday empty-sessions fingerprint trap fix", () => {
  let tmpDir;
  let todayPath;
  let fpPath;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-compile-"));
    todayPath = path.join(tmpDir, "today.md");
    fpPath = todayPath + ".fingerprint";
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not write fingerprint when sessions are empty", async () => {
    const mgr = makeFakeSummaryManager([]);
    await compileToday(mgr, todayPath, RESOLVED_MODEL);

    expect(fs.existsSync(fpPath)).toBe(false);
    expect(callText).not.toHaveBeenCalled();
  });

  it("recovers immediately after sessions reappear (no stale fingerprint lock)", async () => {
    // 1. 先制造"失败期"：sessions 空，导致写 0 bytes today.md（如果已有内容）
    fs.writeFileSync(todayPath, "stale content from yesterday");
    const mgrEmpty = makeFakeSummaryManager([]);
    await compileToday(mgrEmpty, todayPath, RESOLVED_MODEL);

    // 失败期：today.md 被清空，但没有 fingerprint
    expect(fs.readFileSync(todayPath, "utf-8")).toBe("");
    expect(fs.existsSync(fpPath)).toBe(false);

    // 2. summary 恢复：有新 session
    const mgrRecovered = makeFakeSummaryManager([
      { session_id: "s1", updated_at: "2026-04-17T10:00:00Z", summary: "new session summary" },
    ]);
    await compileToday(mgrRecovered, todayPath, RESOLVED_MODEL);

    // 恢复路径：LLM 被调用，文件被写入，fingerprint 被落下
    expect(callText).toHaveBeenCalledOnce();
    expect(fs.readFileSync(todayPath, "utf-8")).toBe("compiled content from llm");
    expect(fs.existsSync(fpPath)).toBe(true);
  });

  it("removes stale fingerprint when sessions become empty", async () => {
    // 先有数据 + fingerprint
    const mgrWith = makeFakeSummaryManager([
      { session_id: "s1", updated_at: "2026-04-17T10:00:00Z", summary: "real summary" },
    ]);
    await compileToday(mgrWith, todayPath, RESOLVED_MODEL);
    expect(fs.existsSync(fpPath)).toBe(true);

    // 进入失败期：sessions 空
    const mgrEmpty = makeFakeSummaryManager([]);
    await compileToday(mgrEmpty, todayPath, RESOLVED_MODEL);

    // 旧 fingerprint 应被删除（保证下次恢复时不会命中老指纹）
    expect(fs.existsSync(fpPath)).toBe(false);
  });

  it("does not rewrite today.md when it is already empty and sessions are empty", async () => {
    // today.md 本就不存在
    const mgrEmpty = makeFakeSummaryManager([]);
    await compileToday(mgrEmpty, todayPath, RESOLVED_MODEL);
    expect(fs.existsSync(todayPath)).toBe(false);

    // 再来一次仍不创建
    await compileToday(mgrEmpty, todayPath, RESOLVED_MODEL);
    expect(fs.existsSync(todayPath)).toBe(false);
  });

  it("skips via fingerprint when sessions are unchanged (non-empty case preserved)", async () => {
    const mgr = makeFakeSummaryManager([
      { session_id: "s1", updated_at: "2026-04-17T10:00:00Z", summary: "real summary" },
    ]);
    await compileToday(mgr, todayPath, RESOLVED_MODEL);
    expect(callText).toHaveBeenCalledOnce();

    // 相同 sessions 再调：fingerprint 命中，应 skip，LLM 不再被调用
    await compileToday(mgr, todayPath, RESOLVED_MODEL);
    expect(callText).toHaveBeenCalledOnce();
  });
});

describe("compileWeek empty-sessions fingerprint trap fix", () => {
  let tmpDir;
  let weekPath;
  let fpPath;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-compile-week-"));
    weekPath = path.join(tmpDir, "week.md");
    fpPath = weekPath + ".fingerprint";
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not write fingerprint when sessions are empty", async () => {
    const mgr = makeFakeSummaryManager([]);
    await compileWeek(mgr, weekPath, RESOLVED_MODEL);

    expect(fs.existsSync(fpPath)).toBe(false);
    expect(callText).not.toHaveBeenCalled();
  });

  it("removes stale fingerprint when sessions become empty", async () => {
    const mgrWith = makeFakeSummaryManager([
      { session_id: "s1", updated_at: "2026-04-17T10:00:00Z", summary: "week summary" },
    ]);
    await compileWeek(mgrWith, weekPath, RESOLVED_MODEL);
    expect(fs.existsSync(fpPath)).toBe(true);

    const mgrEmpty = makeFakeSummaryManager([]);
    await compileWeek(mgrEmpty, weekPath, RESOLVED_MODEL);

    expect(fs.existsSync(fpPath)).toBe(false);
  });
});
