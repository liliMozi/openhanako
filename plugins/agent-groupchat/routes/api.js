import fs from "fs";

export default function (app, ctx) {
  const { bus } = ctx;

  app.post("/groupchat/append", async (c) => {
    const { groupId, role, speaker, content } = await c.req.json();
    if (!groupId || !content) {
      return c.json({ ok: false, error: "groupId and content required" }, 400);
    }
    try {
      await bus.request("groupchat:append", { groupId, role: role || "owner", speaker: speaker || "master", content });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  app.get("/groupchat/messages", async (c) => {
    const groupId = c.req.query("groupId");
    const since = parseInt(c.req.query("since") || "0");
    if (!groupId) return c.json({ ok: false, error: "groupId required" }, 400);
    const messages = await bus.request("groupchat:messages", { groupId, since });
    return c.json({ messages });
  });

  app.get("/groupchat/list", async (c) => {
    const groups = await bus.request("groupchat:list", {});
    return c.json({ groups });
  });

  app.post("/groupchat/create", async (c) => {
    const { name, members } = await c.req.json();
    if (!name || !members) return c.json({ ok: false, error: "name and members required" }, 400);
    const group = await bus.request("groupchat:create", { name, members });
    return c.json({ group });
  });

  app.delete("/groupchat/delete", async (c) => {
    const groupId = c.req.query("groupId");
    if (!groupId) return c.json({ ok: false, error: "groupId required" }, 400);
    await bus.request("groupchat:delete", { groupId });
    return c.json({ ok: true });
  });

  app.get("/groupchat/read-file", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ ok: false, error: "path required" }, 400);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return c.json({ ok: true, path: filePath, content });
    } catch (err) {
      return c.json({ ok: false, error: err.message }, 404);
    }
  });
}
