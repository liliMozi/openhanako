import { afterEach, describe, expect, it, vi } from "vitest";
import { createCronScheduler } from "../lib/desk/cron-scheduler.js";

function createStore(job) {
  const calls = {
    runs: [],
    marks: [],
  };

  return {
    calls,
    store: {
      listJobs() {
        return [job];
      },
      logRun(id, run) {
        calls.runs.push({ id, run });
      },
      markRun(id) {
        calls.marks.push(id);
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cron-scheduler", () => {
  it("执行成功时记录 success", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const job = {
      id: "job_1",
      label: "测试任务",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    };
    const { store, calls } = createStore(job);
    const done = [];
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: async () => {},
      onJobDone: (j, result) => done.push({ id: j.id, result }),
    });

    await scheduler.checkJobs();

    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0].id).toBe("job_1");
    expect(calls.runs[0].run.status).toBe("success");
    expect(calls.marks).toEqual(["job_1"]);
    expect(done).toEqual([{ id: "job_1", result: { status: "success" } }]);
  });

  it("执行抛错时记录 error 和错误信息", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const job = {
      id: "job_2",
      label: "失败任务",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    };
    const { store, calls } = createStore(job);
    const done = [];
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: async () => {
        throw new Error("boom");
      },
      onJobDone: (j, result) => done.push({ id: j.id, result }),
    });

    await scheduler.checkJobs();

    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0].id).toBe("job_2");
    expect(calls.runs[0].run.status).toBe("error");
    expect(calls.runs[0].run.error).toBe("boom");
    expect(calls.marks).toEqual(["job_2"]);
    expect(done).toEqual([{ id: "job_2", result: { status: "error", error: "boom" } }]);
  });

  it("executeJob 抛 skipped 错误时记录 skipped，不推进 nextRunAt", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const job = {
      id: "job_3",
      label: "跳过任务",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    };
    const { store, calls } = createStore(job);
    const done = [];
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: async () => {
        const err = new Error("agent 正在执行另一个 cron");
        err.skipped = true;
        throw err;
      },
      onJobDone: (j, result) => done.push({ id: j.id, result }),
    });

    await scheduler.checkJobs();

    // 应该记录 skipped 状态
    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0].id).toBe("job_3");
    expect(calls.runs[0].run.status).toBe("skipped");

    // 关键：markRun 不应被调用（不推进 nextRunAt，下次重试）
    expect(calls.marks).toEqual([]);

    expect(done).toEqual([{ id: "job_3", result: { status: "skipped" } }]);
  });
});
