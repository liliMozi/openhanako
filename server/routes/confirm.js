/**
 * confirm.js — 阻塞式确认 REST API
 *
 * 前端渲染确认卡片后，用户通过此 API resolve pending confirmation。
 */

import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";

export function createConfirmRoute(confirmStore, engine) {
  const route = new Hono();

  route.post("/confirm/:confirmId", async (c) => {
    const confirmId = c.req.param("confirmId");
    const body = await safeJson(c);
    const { action, value } = body;

    if (!action || !["confirmed", "rejected"].includes(action)) {
      return c.json({ error: "action must be 'confirmed' or 'rejected'" }, 400);
    }

    const found = confirmStore.resolve(confirmId, action, value);
    if (!found) {
      return c.json({ error: "confirmation not found or already resolved" }, 404);
    }

    // 广播状态变更，让前端更新卡片
    engine.emitEvent({
      type: "confirmation_resolved",
      confirmId,
      action,
      value,
    }, null);

    return c.json({ ok: true });
  });

  return route;
}
