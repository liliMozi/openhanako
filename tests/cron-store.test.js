import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** 创建临时目录，返回 paths（不实例化 store，用于 _load 测试） */
function makeTmpPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-test-"));
  return {
    jobsPath: path.join(dir, "cron-jobs.json"),
    runsDir: path.join(dir, "cron-runs"),
  };
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

// ════════════════════════════════════════════
//  addJob 输入验证
// ════════════════════════════════════════════

describe("CronStore addJob 输入验证", () => {
  it("无效 type 抛错", () => {
    const store = makeTmpStore();
    expect(() => store.addJob({
      type: "invalid",
      schedule: 60000,
      prompt: "test",
    })).toThrow(/无效的 job type/);
  });

  it("every 类型 schedule < 60000 clamp 到 60000", () => {
    const store = makeTmpStore();
    const job = store.addJob({
      type: "every",
      schedule: 5000,
      prompt: "test",
    });
    expect(job.schedule).toBe(60000);
  });

  it("at 类型 Invalid Date 抛错", () => {
    const store = makeTmpStore();
    expect(() => store.addJob({
      type: "at",
      schedule: "not-a-date",
      prompt: "test",
    })).toThrow(/无法解析为日期/);
  });

  it("at 类型过去时间抛错", () => {
    const store = makeTmpStore();
    expect(() => store.addJob({
      type: "at",
      schedule: "2020-01-01T00:00:00.000Z",
      prompt: "test",
    })).toThrow(/必须是未来时间/);
  });
});

// ════════════════════════════════════════════
//  updateJob 字段白名单
// ════════════════════════════════════════════

describe("CronStore updateJob 字段白名单", () => {
  it("nextRunAt / id / createdAt 不可被覆盖", () => {
    const store = makeTmpStore();
    const job = store.addJob({
      type: "every",
      schedule: 3600000,
      prompt: "test",
    });
    const origId = job.id;
    const origCreatedAt = job.createdAt;
    const origNextRunAt = job.nextRunAt;

    store.updateJob(job.id, {
      id: "hacked_id",
      createdAt: "1999-01-01T00:00:00.000Z",
      nextRunAt: "1999-01-01T00:00:00.000Z",
      label: "new label",
    });

    const updated = store.getJob(origId);
    expect(updated.id).toBe(origId);
    expect(updated.createdAt).toBe(origCreatedAt);
    expect(updated.nextRunAt).toBe(origNextRunAt);
    expect(updated.label).toBe("new label");
  });

  it("schedule 变更触发 nextRunAt 重算", () => {
    const store = makeTmpStore();
    const job = store.addJob({
      type: "every",
      schedule: 3600000,
      prompt: "test",
    });
    const origNextRunAt = job.nextRunAt;

    // 改 schedule 为 2 小时
    const updated = store.updateJob(job.id, { schedule: 7200000 });
    expect(updated.schedule).toBe(7200000);
    // nextRunAt 应该被重算（基于当前时间 + 7200000），跟原来不同
    expect(updated.nextRunAt).not.toBe(origNextRunAt);
  });
});

// ════════════════════════════════════════════
//  _load 错误处理
// ════════════════════════════════════════════

describe("CronStore _load 错误处理", () => {
  it("ENOENT（文件不存在）不报错，jobs 为空", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    // 不写任何文件，直接构造 store
    const spy = vi.spyOn(console, "error");
    const store = new CronStore(jobsPath, runsDir);
    expect(store.size).toBe(0);
    // ENOENT 走静默分支，不应 console.error
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("JSON 损坏 + .tmp 存在 → 从 .tmp 恢复", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });

    // 写损坏的主文件
    fs.writeFileSync(jobsPath, "{ broken json !!!", "utf-8");

    // 写有效的 .tmp 文件
    const tmpData = {
      jobs: [
        { id: "job_1", type: "every", schedule: 3600000, prompt: "recovered", enabled: true, model: "", consecutiveErrors: 0 },
      ],
      nextNum: 2,
    };
    fs.writeFileSync(jobsPath + ".tmp", JSON.stringify(tmpData), "utf-8");

    const spy = vi.spyOn(console, "error");
    const store = new CronStore(jobsPath, runsDir);
    expect(store.size).toBe(1);
    expect(store.getJob("job_1").prompt).toBe("recovered");
    // 应该有恢复日志
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("从 .tmp 恢复"));
    spy.mockRestore();
  });

  it("every schedule < 60000 自动 clamp", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });

    const data = {
      jobs: [
        { id: "job_1", type: "every", schedule: 1000, prompt: "fast", enabled: true, model: "", consecutiveErrors: 0 },
        { id: "job_2", type: "every", schedule: 120000, prompt: "ok", enabled: true, model: "", consecutiveErrors: 0 },
      ],
      nextNum: 3,
    };
    fs.writeFileSync(jobsPath, JSON.stringify(data), "utf-8");

    const store = new CronStore(jobsPath, runsDir);
    expect(store.getJob("job_1").schedule).toBe(60000);
    expect(store.getJob("job_2").schedule).toBe(120000);
  });

  it("多次 listJobs 幂等（清洗后 _save，后续不再重复写）", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });

    const data = {
      jobs: [
        { id: "job_1", type: "every", schedule: 5000, prompt: "test", enabled: true, model: "" },
      ],
      nextNum: 2,
    };
    fs.writeFileSync(jobsPath, JSON.stringify(data), "utf-8");

    const store = new CronStore(jobsPath, runsDir);
    // 首次 _load 触发清洗 + _save
    expect(store.getJob("job_1").schedule).toBe(60000);
    expect(store.getJob("job_1").consecutiveErrors).toBe(0);

    // 记录清洗后文件的 mtime
    const stat1 = fs.statSync(jobsPath);

    // 再次 listJobs（触发 _load），数据已干净，不应再 _save
    // 用一个小延迟确保 mtime 能区分
    const spy = vi.spyOn(store, "_save");
    store.listJobs();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ════════════════════════════════════════════
//  markRun 错误退避
// ════════════════════════════════════════════

describe("CronStore markRun 错误退避", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-03-28T12:00:00.000Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("success 时 consecutiveErrors 归 0", () => {
    const store = makeTmpStore();
    const job = store.addJob({ type: "every", schedule: 3600000, prompt: "test" });
    // 手动设置一些错误计数
    store.getJob(job.id).consecutiveErrors = 3;
    store.markRun(job.id, { success: true });
    expect(store.getJob(job.id).consecutiveErrors).toBe(0);
  });

  it("failure 时 consecutiveErrors 递增", () => {
    const store = makeTmpStore();
    const job = store.addJob({ type: "every", schedule: 3600000, prompt: "test" });
    expect(store.getJob(job.id).consecutiveErrors).toBe(0);

    store.markRun(job.id, { success: false });
    expect(store.getJob(job.id).consecutiveErrors).toBe(1);

    store.markRun(job.id, { success: false });
    expect(store.getJob(job.id).consecutiveErrors).toBe(2);
  });

  it("failure 时 nextRunAt 包含退避时间", () => {
    const store = makeTmpStore();
    const job = store.addJob({ type: "every", schedule: 3600000, prompt: "test" });

    // 首次失败：consecutiveErrors=1 → 退避 1 分钟
    store.markRun(job.id, { success: false });
    const nextRun = new Date(store.getJob(job.id).nextRunAt);
    const expectedBackoff = new Date(Date.now() + 60_000);
    // nextRunAt 应该 >= 退避时间（退避 1 min vs 正常 1 hour，正常间隔更大则取正常）
    // every 3600000 的 normalNext = now + 1h，远大于退避 1 min，所以 nextRunAt = normalNext
    const normalNext = new Date(Date.now() + 3600000);
    expect(nextRun.getTime()).toBeGreaterThanOrEqual(normalNext.getTime() - 1000);
  });

  it("failure 时短间隔任务 nextRunAt 被退避推迟", () => {
    const store = makeTmpStore();
    // 60 秒间隔的任务
    const job = store.addJob({ type: "every", schedule: 60000, prompt: "test" });

    // 第 2 次失败：consecutiveErrors=2 → 退避 5 分钟（300_000 ms）
    store.markRun(job.id, { success: false }); // consecutiveErrors=1, backoff=60s
    store.markRun(job.id, { success: false }); // consecutiveErrors=2, backoff=300s

    const nextRun = new Date(store.getJob(job.id).nextRunAt);
    // normalNext = now + 60s，backoffNext = now + 300s → 取 backoffNext
    const backoffNext = new Date(Date.now() + 300_000);
    // 允许 1 秒误差
    expect(Math.abs(nextRun.getTime() - backoffNext.getTime())).toBeLessThan(1000);
  });

  it("多次失败后退避递增（3 次失败 → 退避 15 分钟）", () => {
    const store = makeTmpStore();
    const job = store.addJob({ type: "every", schedule: 60000, prompt: "test" });

    store.markRun(job.id, { success: false }); // 1 → 60s
    store.markRun(job.id, { success: false }); // 2 → 300s
    store.markRun(job.id, { success: false }); // 3 → 900s

    expect(store.getJob(job.id).consecutiveErrors).toBe(3);

    const nextRun = new Date(store.getJob(job.id).nextRunAt);
    const backoffNext = new Date(Date.now() + 900_000); // 15 分钟
    expect(Math.abs(nextRun.getTime() - backoffNext.getTime())).toBeLessThan(1000);
  });

  it("成功后退避重置", () => {
    const store = makeTmpStore();
    const job = store.addJob({ type: "every", schedule: 60000, prompt: "test" });

    // 连续失败 3 次
    store.markRun(job.id, { success: false });
    store.markRun(job.id, { success: false });
    store.markRun(job.id, { success: false });
    expect(store.getJob(job.id).consecutiveErrors).toBe(3);

    // 成功一次
    store.markRun(job.id, { success: true });
    expect(store.getJob(job.id).consecutiveErrors).toBe(0);

    // 再次失败：退避应从头开始（1 分钟，不是 15 分钟）
    store.markRun(job.id, { success: false });
    expect(store.getJob(job.id).consecutiveErrors).toBe(1);

    const nextRun = new Date(store.getJob(job.id).nextRunAt);
    // backoff[1] = 60_000，normalNext = now + 60_000，两者相同量级
    const backoffNext = new Date(Date.now() + 60_000);
    // 差值应接近 0 或正常间隔（60s），都在退避范围内
    expect(nextRun.getTime()).toBeGreaterThanOrEqual(backoffNext.getTime() - 1000);
  });

  it("退避上限为 60 分钟（超过 BACKOFF 表长度后不再增长）", () => {
    const store = makeTmpStore();
    const job = store.addJob({ type: "every", schedule: 60000, prompt: "test" });

    // 失败 10 次（超过 BACKOFF 表的 5 个元素）
    for (let i = 0; i < 10; i++) {
      store.markRun(job.id, { success: false });
    }

    expect(store.getJob(job.id).consecutiveErrors).toBe(10);
    const nextRun = new Date(store.getJob(job.id).nextRunAt);
    const maxBackoff = new Date(Date.now() + 3_600_000); // 60 分钟
    expect(Math.abs(nextRun.getTime() - maxBackoff.getTime())).toBeLessThan(1000);
  });

  it("默认参数（无 opts）等同 success=true", () => {
    const store = makeTmpStore();
    const job = store.addJob({ type: "every", schedule: 3600000, prompt: "test" });
    store.getJob(job.id).consecutiveErrors = 5;

    // 不传第二个参数
    store.markRun(job.id);
    expect(store.getJob(job.id).consecutiveErrors).toBe(0);
  });
});

// ════════════════════════════════════════════
//  cron 解析器边界
// ════════════════════════════════════════════

describe("cron 解析器边界", () => {
  it("字段值越界返回 null（70 分钟）", () => {
    const store = makeTmpStore();
    const result = store._calcNextRun("cron", "70 * * * *", new Date().toISOString());
    expect(result).toBeNull();
  });

  it("字段值越界返回 null（25 小时）", () => {
    const store = makeTmpStore();
    const result = store._calcNextRun("cron", "0 25 * * *", new Date().toISOString());
    expect(result).toBeNull();
  });

  it("反向范围返回 null", () => {
    const store = makeTmpStore();
    const result = store._calcNextRun("cron", "5-2 * * * *", new Date().toISOString());
    expect(result).toBeNull();
  });

  it("at Invalid Date 返回 null", () => {
    const store = makeTmpStore();
    const result = store._calcNextRun("at", "not-a-date", new Date().toISOString());
    expect(result).toBeNull();
  });

  it("有效 cron 表达式仍正常工作", () => {
    const store = makeTmpStore();
    const result = store._calcNextRun("cron", "0 7 * * *", new Date().toISOString());
    expect(result).not.toBeNull();
  });
});

// ════════════════════════════════════════════
//  logRun 日志修剪
// ════════════════════════════════════════════

describe("CronStore logRun 日志修剪", () => {
  it("logRun 超过 500 行时修剪到 300 行", () => {
    const store = makeTmpStore();
    for (let i = 0; i < 510; i++) {
      store.logRun("job_1", { status: "success", i });
    }
    // 第 501 次写入后触发修剪（501→300），之后 502-510 再追加 9 行 = 309
    const history = store.getRunHistory("job_1", 9999);
    expect(history.length).toBeLessThanOrEqual(310);
    expect(history.length).toBeGreaterThan(0);
    // 确认确实发生了修剪（不修剪的话是 510）
    expect(history.length).toBeLessThan(500);
  });
});
