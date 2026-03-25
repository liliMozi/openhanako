import { describe, expect, it } from "vitest";
import { CronStore } from "../lib/desk/cron-store.js";
import fs from "fs";
import path from "path";
import os from "os";

function makeTmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-test-"));
  return new CronStore(
    path.join(dir, "cron-jobs.json"),
    path.join(dir, "cron-runs"),
  );
}

/** 构造本地时间的 Date（cron 字段匹配的是本地时区） */
function localDate(year, month, day, hour = 0, minute = 0) {
  const d = new Date(year, month - 1, day, hour, minute, 0, 0);
  return d;
}

describe("CronStore cron 解析", () => {
  // ── 步进值 ──

  it("*/30 * * * * → 每30分钟触发", () => {
    const store = makeTmpStore();
    const from = localDate(2026, 3, 25, 10, 5);
    const next = new Date(store._parseSimpleCron("*/30 * * * *", from));
    // */30 匹配 0 和 30，下一个是 10:30
    expect(next.getHours()).toBe(10);
    expect(next.getMinutes()).toBe(30);
  });

  it("*/15 * * * * → 每15分钟触发", () => {
    const store = makeTmpStore();
    const from = localDate(2026, 3, 25, 10, 14);
    const next = new Date(store._parseSimpleCron("*/15 * * * *", from));
    expect(next.getHours()).toBe(10);
    expect(next.getMinutes()).toBe(15);
  });

  it("*/15 从 :45 起算 → 下个整点的 :00", () => {
    const store = makeTmpStore();
    const from = localDate(2026, 3, 25, 10, 45);
    const next = new Date(store._parseSimpleCron("*/15 * * * *", from));
    expect(next.getHours()).toBe(11);
    expect(next.getMinutes()).toBe(0);
  });

  // ── 每日定时（原有功能） ──

  it("30 9 * * * → 每天 9:30", () => {
    const store = makeTmpStore();
    const from = localDate(2026, 3, 25, 8, 0);
    const next = new Date(store._parseSimpleCron("30 9 * * *", from));
    expect(next.getDate()).toBe(25);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(30);
  });

  it("30 9 * * * → 已过9:30则推到明天", () => {
    const store = makeTmpStore();
    const from = localDate(2026, 3, 25, 10, 0);
    const next = new Date(store._parseSimpleCron("30 9 * * *", from));
    expect(next.getDate()).toBe(26);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(30);
  });

  // ── 每小时 ──

  it("0 * * * * → 每小时整点", () => {
    const store = makeTmpStore();
    const from = localDate(2026, 3, 25, 10, 30);
    const next = new Date(store._parseSimpleCron("0 * * * *", from));
    expect(next.getHours()).toBe(11);
    expect(next.getMinutes()).toBe(0);
  });

  // ── 星期字段 ──

  it("0 9 * * 1 → 仅周一 9:00（不是每天）", () => {
    const store = makeTmpStore();
    // 2026-03-25 是周三
    const from = localDate(2026, 3, 25, 8, 0);
    const next = new Date(store._parseSimpleCron("0 9 * * 1", from));
    expect(next.getDay()).toBe(1); // 周一
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    // 下一个周一是 3/30
    expect(next.getDate()).toBe(30);
  });

  it("0 10 * * 0,6 → 仅周末", () => {
    const store = makeTmpStore();
    // 2026-03-25 是周三
    const from = localDate(2026, 3, 25, 8, 0);
    const next = new Date(store._parseSimpleCron("0 10 * * 0,6", from));
    // 下一个周末：周六 3/28
    expect(next.getDay()).toBe(6);
    expect(next.getDate()).toBe(28);
    expect(next.getHours()).toBe(10);
  });

  // ── 日期字段 ──

  it("0 10 1 * * → 每月1号 10:00", () => {
    const store = makeTmpStore();
    const from = localDate(2026, 3, 25, 8, 0);
    const next = new Date(store._parseSimpleCron("0 10 1 * *", from));
    expect(next.getMonth()).toBe(3); // 4月（0-based）
    expect(next.getDate()).toBe(1);
    expect(next.getHours()).toBe(10);
  });

  // ── 范围 ──

  it("0 9 * * 1-5 → 工作日 9:00", () => {
    const store = makeTmpStore();
    // 2026-03-28 是周六
    const from = localDate(2026, 3, 28, 8, 0);
    const next = new Date(store._parseSimpleCron("0 9 * * 1-5", from));
    // 下个工作日：周一 3/30
    expect(next.getDay()).toBe(1);
    expect(next.getDate()).toBe(30);
    expect(next.getHours()).toBe(9);
  });

  // ── 周日 7 → 0 归一化 ──

  it("0 8 * * 7 → 周日（7 归一化为 0）", () => {
    const store = makeTmpStore();
    // 2026-03-25 是周三
    const from = localDate(2026, 3, 25, 8, 0);
    const next = new Date(store._parseSimpleCron("0 8 * * 7", from));
    expect(next.getDay()).toBe(0); // 周日
    // 下一个周日：3/29
    expect(next.getDate()).toBe(29);
    expect(next.getHours()).toBe(8);
  });

  // ── 无效表达式 ──

  it("字段不足5个返回 null", () => {
    const store = makeTmpStore();
    expect(store._parseSimpleCron("30 9", new Date())).toBeNull();
  });

  it("非法步进值返回 null", () => {
    const store = makeTmpStore();
    expect(store._parseSimpleCron("*/0 * * * *", new Date())).toBeNull();
    expect(store._parseSimpleCron("*/abc * * * *", new Date())).toBeNull();
  });

  // ── 回归：连续触发不应产生相同时间 ──

  it("*/30 连续 markRun 后 nextRunAt 持续推进", () => {
    const store = makeTmpStore();
    const t0 = localDate(2026, 3, 25, 10, 5);
    const n1 = new Date(store._parseSimpleCron("*/30 * * * *", t0));
    expect(n1.getMinutes()).toBe(30);

    const n2 = new Date(store._parseSimpleCron("*/30 * * * *", n1));
    expect(n2.getHours()).toBe(11);
    expect(n2.getMinutes()).toBe(0);

    const n3 = new Date(store._parseSimpleCron("*/30 * * * *", n2));
    expect(n3.getHours()).toBe(11);
    expect(n3.getMinutes()).toBe(30);
  });
});

describe("CronStore _calcNextRun", () => {
  it("every 类型：返回 from + ms", () => {
    const store = makeTmpStore();
    const from = "2026-03-25T10:00:00.000Z";
    const next = store._calcNextRun("every", 1800000, from); // 30 min
    expect(new Date(next)).toEqual(new Date("2026-03-25T10:30:00.000Z"));
  });

  it("at 类型：未来时间原样返回", () => {
    const store = makeTmpStore();
    const from = "2026-03-25T10:00:00.000Z";
    const next = store._calcNextRun("at", "2026-03-25T12:00:00.000Z", from);
    expect(next).toBe("2026-03-25T12:00:00.000Z");
  });

  it("at 类型：过去时间返回 null", () => {
    const store = makeTmpStore();
    const from = "2026-03-25T10:00:00.000Z";
    const next = store._calcNextRun("at", "2026-03-25T08:00:00.000Z", from);
    expect(next).toBeNull();
  });
});
