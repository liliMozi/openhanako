/**
 * plugins/image-gen/tools/generate-image.js
 *
 * Non-blocking image generation. Submits via adapter, returns card immediately.
 */
import path from "node:path";

export const name = "generate-image";
export const description =
  "根据文字描述生成图片。非阻塞：提交后立即返回，完成后自动通知。";

export const parameters = {
  type: "object",
  properties: {
    prompt:     { type: "string", description: "图片描述（中英文均可）" },
    count:      { type: "number", description: "并发生成张数，默认 1，最大 9" },
    image:      { type: "string", description: "参考图路径（图生图）" },
    ratio:      { type: "string", description: "长宽比：1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 21:9" },
    resolution: { type: "string", description: "分辨率：2k, 4k（默认 2k）" },
    model:      { type: "string", description: "模型版本：3.0, 3.1, 4.0, 4.1, 4.5, 4.6, 5.0（默认 5.0）" },
    provider:   { type: "string", description: "指定 provider（可选）" },
  },
  required: ["prompt"],
};

export async function execute(input, ctx) {
  const { registry, store, poller } = ctx._mediaGen || {};
  if (!registry || !store || !poller) {
    return { content: [{ type: "text", text: "图片生成插件未初始化" }] };
  }

  // Build adapter context
  const generatedDir = path.join(ctx.dataDir, "generated");
  const submitCtx = { dataDir: ctx.dataDir, bus: ctx.bus, log: ctx.log, generatedDir, config: ctx.config };

  // Resolve adapter: explicit → last registered (external adapters take over)
  const adapter = input.provider
    ? registry.get(input.provider)
    : registry.getByType("image").at(-1) || null;
  if (!adapter) {
    return { content: [{ type: "text", text: "没有可用的图片生成 provider" }] };
  }

  const count = Math.min(Math.max(input.count || 1, 1), 9);
  const batchId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const params = {
    type: "image",
    prompt: input.prompt,
    ...(input.ratio && { ratio: input.ratio }),
    ...(input.resolution && { resolution: input.resolution }),
    ...(input.model && { model: input.model }),
    ...(input.image && { image: input.image }),
  };

  // Concurrent submit
  const promises = Array.from({ length: count }, () =>
    adapter.submit(params, submitCtx).catch((err) => ({ _error: err })),
  );
  const results = await Promise.all(promises);

  const succeeded = [];
  let failCount = 0;

  for (const r of results) {
    if (r._error || !r.taskId) { failCount++; continue; }
    succeeded.push(r);

    store.add({
      taskId: r.taskId,
      adapterId: adapter.id,
      batchId,
      type: "image",
      prompt: input.prompt,
      params,
      sessionPath: ctx.sessionPath,
    });

    // If submit returned files, update the task with them
    if (r.files?.length) {
      store.update(r.taskId, { files: r.files });
    }

    // Register deferred notification
    try {
      await ctx.bus.request("deferred:register", {
        taskId: r.taskId,
        sessionPath: ctx.sessionPath,
        meta: { type: "image-generation", prompt: input.prompt },
      });
    } catch (err) {
      ctx.log.warn(`deferred:register failed for ${r.taskId}:`, err);
    }

    // Register in TaskRegistry for visibility and cancellation
    try {
      await ctx.bus.request("task:register", {
        taskId: r.taskId,
        type: "media-generation",
        parentSessionPath: ctx.sessionPath,
        meta: { type: "image-generation", prompt: input.prompt },
      });
    } catch {}

    // Add to poller (handles fake-async detection internally)
    poller.add(r.taskId);
  }

  if (succeeded.length === 0) {
    const firstErr = results.find((r) => r._error)?._error;
    return {
      content: [{ type: "text", text: `图片提交失败：${firstErr?.message || "未知错误"}` }],
    };
  }

  let text = `已提交 ${succeeded.length} 张图片生成，完成后会自动显示在下方卡片中。`;
  if (failCount > 0) text += `\n（${failCount} 张提交失败，请检查网络或余额）`;

  return {
    content: [{ type: "text", text }],
    details: {
      card: {
        type: "iframe",
        route: `/card?batch=${batchId}`,
        title: "图片生成",
        description: `${input.prompt.slice(0, 60)} (${succeeded.length}张)`,
        aspectRatio: input.ratio || "1:1",
      },
    },
  };
}
