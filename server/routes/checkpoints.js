import { Hono } from "hono";

export function createCheckpointsRoute(engine) {
  const route = new Hono();

  route.get("/checkpoints", async (c) => {
    try {
      const list = await engine.listCheckpoints();
      return c.json({ checkpoints: list });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/checkpoints/:id/restore", async (c) => {
    try {
      const { id } = c.req.param();
      const result = await engine.restoreCheckpoint(id);
      return c.json({ ok: true, restoredTo: result.restoredTo });
    } catch (err) {
      if (err.code === "ENOENT") {
        return c.json({ error: "checkpoint not found" }, 404);
      }
      return c.json({ error: err.message }, 500);
    }
  });

  route.delete("/checkpoints/:id", async (c) => {
    try {
      const { id } = c.req.param();
      await engine.removeCheckpoint(id);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}
