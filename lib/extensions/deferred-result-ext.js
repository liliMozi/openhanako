/**
 * Deferred Result Pi SDK Extension
 *
 * On session_start:
 *   1. 订阅 DeferredResultStore 的 resolve/fail 事件
 *   2. 扫描未送达的已完成任务，补发 steer
 *
 * 结果通过 pi.sendMessage({ deliverAs: "steer", triggerTurn: true }) 注入 session，
 * 成功后调 store.markDelivered(taskId)。
 */

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatResultNotification(taskId, result, meta) {
  const type = escapeXml(meta?.type || "background-task");
  const body =
    typeof result === "string"
      ? escapeXml(result)
      : escapeXml(JSON.stringify(result, null, 2));
  return `<hana-background-result task-id="${escapeXml(taskId)}" status="success" type="${type}">\n${body}\n</hana-background-result>`;
}

function formatFailNotification(taskId, reason, meta) {
  const type = escapeXml(meta?.type || "background-task");
  return `<hana-background-result task-id="${escapeXml(taskId)}" status="failed" type="${type}">\n${escapeXml(reason)}\n</hana-background-result>`;
}

function formatAbortNotification(taskId, reason, meta) {
  const type = escapeXml(meta?.type || "background-task");
  return `<hana-background-result task-id="${escapeXml(taskId)}" status="aborted" type="${type}">\n${escapeXml(reason || "task was stopped")}\n</hana-background-result>`;
}

/**
 * 尝试 steer 送达一个任务结果，成功后 markDelivered
 * @returns {boolean} 是否送达成功
 */
function tryDeliver(pi, store, taskId, task) {
  try {
    const content = task.status === "resolved"
      ? formatResultNotification(taskId, task.result, task.meta)
      : task.status === "aborted"
        ? formatAbortNotification(taskId, task.reason, task.meta)
        : formatFailNotification(taskId, task.reason, task.meta);
    pi.sendMessage(
      { customType: "hana-background-result", content, display: false },
      { deliverAs: "steer", triggerTurn: true },
    );
    store.markDelivered(taskId);
    return true;
  } catch (err) {
    console.error(`[deferred-result-ext] steer failed for ${taskId}:`, err.message || err, err.stack?.split('\n').slice(0, 3).join('\n'));
    return false;
  }
}

/**
 * @param {import("../deferred-result-store.js").DeferredResultStore} deferredStore
 * @returns {(pi: object) => void}
 */
export function createDeferredResultExtension(deferredStore) {
  return function (pi) {
    let sessionPath = null;
    let unsubResult = null;
    let unsubFail = null;
    let retryTimer = null;

    pi.on("session_start", (event, ctx) => {
      sessionPath = ctx.sessionManager.getSessionFile();

      // ── 补发未送达的已完成任务 ──
      setTimeout(() => {
        const undelivered = deferredStore.listUndelivered(sessionPath);
        for (const task of undelivered) {
          tryDeliver(pi, deferredStore, task.taskId, task);
        }

        // 如果还有 pending 任务，提醒 LLM
        const pending = deferredStore.listPending(sessionPath);
        if (pending.length) {
          try {
            pi.sendMessage(
              {
                customType: "hana-deferred-task-reminder",
                content: `<hana-deferred-tasks>${pending.length} 个后台任务进行中；使用 check_pending_tasks 工具可查看详情。</hana-deferred-tasks>`,
                display: false,
              },
              { deliverAs: "steer", triggerTurn: false },
            );
          } catch { /* best effort */ }
        }
      }, 500);

      // ── 实时订阅 ──
      unsubResult = deferredStore.onResult((taskId, sp, result, meta) => {
        if (sp !== sessionPath) return;
        const task = deferredStore.query(taskId);
        if (task) tryDeliver(pi, deferredStore, taskId, task);
      });

      unsubFail = deferredStore.onFail((taskId, sp, reason, meta) => {
        if (sp !== sessionPath) return;
        const task = deferredStore.query(taskId);
        if (task) tryDeliver(pi, deferredStore, taskId, task);
      });

      // ── 定时重试未送达的（每 30 秒扫一次）──
      retryTimer = setInterval(() => {
        if (!sessionPath) return;
        const undelivered = deferredStore.listUndelivered(sessionPath);
        for (const task of undelivered) {
          tryDeliver(pi, deferredStore, task.taskId, task);
        }
      }, 30_000);
    });

    pi.on("session_shutdown", () => {
      unsubResult?.();
      unsubFail?.();
      unsubResult = null;
      unsubFail = null;
      if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    });
  };
}
