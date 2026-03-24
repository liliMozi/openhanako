/**
 * confirm.js — 阻塞式确认 REST API
 *
 * 前端渲染确认卡片后，用户通过此 API resolve pending confirmation。
 */

export default async function confirmRoute(app, { confirmStore, engine }) {
  app.post("/api/confirm/:confirmId", async (req, res) => {
    const { confirmId } = req.params;
    const { action, value } = req.body || {};

    if (!action || !["confirmed", "rejected"].includes(action)) {
      return res.status(400).send({ error: "action must be 'confirmed' or 'rejected'" });
    }

    const found = confirmStore.resolve(confirmId, action, value);
    if (!found) {
      return res.status(404).send({ error: "confirmation not found or already resolved" });
    }

    // 广播状态变更，让前端更新卡片
    engine.emitEvent({
      type: "confirmation_resolved",
      confirmId,
      action,
      value,
    }, null);

    res.send({ ok: true });
  });
}
