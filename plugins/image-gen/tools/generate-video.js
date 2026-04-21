/**
 * plugins/image-gen/tools/generate-video.js
 *
 * Non-blocking video generation. Submits via adapter, returns card immediately.
 */
import path from "node:path";

export const name = "generate-video";
export const description =
  "根据文字描述生成视频。非阻塞：提交后立即返回，完成后自动通知。";

export const parameters = {
  type: "object",
  properties: {
    prompt:   { type: "string", description: "视频描述（中英文均可）" },
    image:    { type: "string", description: "参考图路径（图生视频）" },
    duration: { type: "number", description: "视频时长 4-15 秒（默认 5）" },
    ratio:    { type: "string", description: "长宽比：1:1, 16:9, 9:16, 4:3, 3:4, 21:9" },
    model:    { type: "string", description: "模型版本：seedance2.0, seedance2.0fast（默认 seedance2.0）" },
    provider: { type: "string", description: "指定 provider（可选）" },
  },
  required: ["prompt"],
};

export async function execute(input, ctx) {
  const { registry, store, poller } = ctx._mediaGen || {};
  if (!registry || !store || !poller) {
    return { content: [{ type: "text", text: "视频生成插件未初始化" }] };
  }

  // Build adapter context
  const generatedDir = path.join(ctx.dataDir, "generated");
  const submitCtx = { dataDir: ctx.dataDir, bus: ctx.bus, log: ctx.log, generatedDir, config: ctx.config };

  // Resolve adapter: explicit → last registered (external adapters take over)
  const adapter = input.provider
    ? registry.get(input.provider)
    : registry.getByType("video").at(-1) || null;
  if (!adapter) {
    return { content: [{ type: "text", text: "没有可用的视频生成 provider" }] };
  }

  const batchId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const params = {
    type: "video",
    prompt: input.prompt,
    ...(input.image && { image: input.image }),
    ...(input.duration && { duration: input.duration }),
    ...(input.ratio && { ratio: input.ratio }),
    ...(input.model && { model: input.model }),
  };

  // Single submit (no concurrent video generation)
  let result;
  try {
    result = await adapter.submit(params, submitCtx);
  } catch (err) {
    return {
      content: [{ type: "text", text: `视频提交失败：${err?.message || "未知错误"}` }],
    };
  }

  if (!result?.taskId) {
    return {
      content: [{ type: "text", text: "视频提交失败：未知错误" }],
    };
  }

  store.add({
    taskId: result.taskId,
    adapterId: adapter.id,
    batchId,
    type: "video",
    prompt: input.prompt,
    params,
    sessionPath: ctx.sessionPath,
  });

  // If submit returned files, update the task with them
  if (result.files?.length) {
    store.update(result.taskId, { files: result.files });
  }

  // Register deferred notification
  try {
    await ctx.bus.request("deferred:register", {
      taskId: result.taskId,
      sessionPath: ctx.sessionPath,
      meta: { type: "video-generation", prompt: input.prompt },
    });
  } catch (err) {
    ctx.log.warn(`deferred:register failed for ${result.taskId}:`, err);
  }

  // Register in TaskRegistry for visibility and cancellation
  try {
    await ctx.bus.request("task:register", {
      taskId: result.taskId,
      type: "media-generation",
      parentSessionPath: ctx.sessionPath,
      meta: { type: "video-generation", prompt: input.prompt },
    });
  } catch {}

  // Add to poller (handles fake-async detection internally)
  poller.add(result.taskId);

  return {
    content: [{ type: "text", text: "已提交视频生成，完成后会自动显示在下方卡片中。" }],
    details: {
      card: {
        type: "iframe",
        route: `/card?batch=${batchId}`,
        title: "视频生成",
        description: input.prompt.slice(0, 60),
        aspectRatio: input.ratio || "16:9",
      },
    },
  };
}
