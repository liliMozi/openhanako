/**
 * image-gen/routes/tasks.js
 *
 * REST API for task data. Used by card iframe and management panel.
 */

export default function (app, ctx) {
  const store = () => ctx._mediaGen?.store;

  // Get tasks in a batch (for card)
  app.get("/tasks/batch/:batchId", (c) => {
    const s = store();
    if (!s) return c.json({ error: "not initialized" }, 503);
    const tasks = s.getByBatch(c.req.param("batchId"));
    return c.json({ tasks });
  });

  // List all tasks (for panel)
  app.get("/tasks", (c) => {
    const s = store();
    if (!s) return c.json({ error: "not initialized" }, 503);
    const filter = c.req.query("filter"); // all | images | videos | favorited
    let tasks;
    switch (filter) {
      case "favorited":
        tasks = s.listFavorited();
        break;
      case "images":
        tasks = s.listAll().filter((t) => t.type === "text2image" || t.type === "image2image");
        break;
      case "videos":
        tasks = s.listAll().filter((t) => t.type?.includes("video"));
        break;
      default:
        tasks = s.listAll();
        break;
    }
    // Sort by createdAt descending
    tasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return c.json({ tasks });
  });

  // Get single task
  app.get("/tasks/:taskId", (c) => {
    const s = store();
    if (!s) return c.json({ error: "not initialized" }, 503);
    const task = s.get(c.req.param("taskId"));
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json({ task });
  });
}
