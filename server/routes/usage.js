/**
 * Token 用量统计路由
 *
 * GET  /api/usage       — 返回累计统计
 * DELETE /api/usage     — 重置统计
 */
export default async function usageRoute(app, { engine }) {
  const tracker = engine.usageTracker;

  app.get("/api/usage", async () => {
    if (!tracker) return { error: "usage tracker not available" };
    return tracker.getStats();
  });

  app.delete("/api/usage", async () => {
    if (!tracker) return { error: "usage tracker not available" };
    tracker.reset();
    return { ok: true };
  });
}
