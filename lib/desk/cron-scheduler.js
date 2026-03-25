/**
 * cron-scheduler.js — Cron 调度器
 *
 * 确定性代码层：每分钟检查一次到期任务，到期时回调执行。
 * 调度逻辑不涉及 LLM，只有执行回调才会创建 session 调 LLM。
 *
 * 参考 OpenClaw 的 Gateway 级调度器设计：
 * 调度器和 Agent Runtime 分开，定时逻辑不跟 LLM 调用耦合。
 */

import { debugLog } from "../debug-log.js";

/**
 * 创建 Cron 调度器
 *
 * @param {object} opts
 * @param {import('./cron-store.js').CronStore} opts.cronStore
 * @param {(job: object) => Promise<void>} opts.executeJob - 执行回调（由 engine 提供）
 * @param {(jobId: string) => void} [opts.abortJob] - 超时时 abort 正在执行的任务
 * @param {(job: object, result: object) => void} [opts.onJobDone] - 执行完成通知
 * @returns {{ start, stop, checkJobs }}
 */
export function createCronScheduler({ cronStore, executeJob, abortJob, onJobDone }) {
  const CHECK_INTERVAL = 60_000; // 每分钟检查一次
  let _timer = null;
  let _checking = false;
  let _checkPromise = null;

  /**
   * 检查所有到期任务并执行
   */
  async function checkJobs() {
    if (_checking) return;
    _checking = true;
    const p = _doCheck();
    _checkPromise = p;
    await p;
  }

  async function _doCheck() {
    try {
      const now = Date.now();
      const jobs = cronStore.listJobs();

      for (const job of jobs) {
        if (!job.enabled) continue;
        if (!job.nextRunAt) continue;

        const nextRunTime = new Date(job.nextRunAt).getTime();
        if (now < nextRunTime) continue;

        // 到期了，执行
        console.log(`\x1b[90m[cron] 执行任务: ${job.label} (${job.id})\x1b[0m`);
        debugLog()?.log("cron", `run ${job.id} (${job.label})`);
        const startedAt = new Date().toISOString();

        const EXEC_TIMEOUT = 5 * 60 * 1000; // 5 分钟超时
        try {
          {
            let timer;
            try {
              await Promise.race([
                executeJob(job),
                new Promise((_, reject) => {
                  timer = setTimeout(() => {
                    abortJob?.(job.id);
                    reject(new Error("execution timeout (5min)"));
                  }, EXEC_TIMEOUT);
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          }
          const finishedAt = new Date().toISOString();

          // 记录成功
          cronStore.logRun(job.id, { status: "success", startedAt, finishedAt });
          cronStore.markRun(job.id);
          debugLog()?.log("cron", `job success ${job.id}`);

          onJobDone?.(job, { status: "success" });
        } catch (err) {
          const finishedAt = new Date().toISOString();

          if (err.skipped) {
            // 跳过：不推进 nextRunAt，下次 check 时重试
            cronStore.logRun(job.id, { status: "skipped", startedAt, finishedAt });
            debugLog()?.log("cron", `job skipped ${job.id}: ${err.message}`);
            onJobDone?.(job, { status: "skipped" });
          } else {
            // 真正失败：记录并推进 nextRunAt
            cronStore.logRun(job.id, { status: "error", startedAt, finishedAt, error: err.message });
            cronStore.markRun(job.id);

            console.error(`\x1b[90m[cron] 任务失败 ${job.id}: ${err.message}\x1b[0m`);
            debugLog()?.error("cron", `job failed ${job.id}: ${err.message}`);
            onJobDone?.(job, { status: "error", error: err.message });
          }
        }
      }
    } catch (err) {
      console.error(`\x1b[90m[cron] checkJobs 错误: ${err.message}\x1b[0m`);
      debugLog()?.error("cron", `checkJobs error: ${err.message}`);
    } finally {
      _checking = false;
    }
  }

  function start() {
    if (_timer) return;
    _timer = setInterval(() => checkJobs(), CHECK_INTERVAL);
    // 不 unref：cron 是核心功能，空闲时也必须可靠触发
    console.log("\x1b[90m[cron] 调度器已启动（间隔 60 秒）\x1b[0m");
  }

  async function stop() {
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
    if (_checkPromise) {
      await _checkPromise.catch(() => {});
      _checkPromise = null;
    }
  }

  return { start, stop, checkJobs };
}
