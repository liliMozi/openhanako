// plugins/image-gen/routes/media.js
import fs from "fs";
import path from "path";

const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime" };

export default function (app, ctx) {
  // Serve generated media — streaming + Range support
  app.get("/media/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
      return c.json({ error: "invalid filename" }, 400);
    }
    const filePath = path.join(ctx.dataDir, "generated", filename);

    let stat;
    try { stat = fs.statSync(filePath); } catch { return c.json({ error: "not found" }, 404); }

    const ext = path.extname(filename).slice(1);
    const mime = MIME[ext] || "application/octet-stream";
    const total = stat.size;
    const range = c.req.header("range");

    if (range) {
      // Range request — partial content (video seeking, progressive load)
      const match = range.match(/bytes=(\d*)-(\d*)/);
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : total - 1;
      const chunkSize = end - start + 1;

      const stream = fs.createReadStream(filePath, { start, end });
      const { readable, writable } = new TransformStream();
      streamPipe(stream, writable);

      return new Response(readable, {
        status: 206,
        headers: {
          "Content-Type": mime,
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Content-Length": String(chunkSize),
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    // Full request — stream the entire file (no readFileSync)
    const stream = fs.createReadStream(filePath);
    const { readable, writable } = new TransformStream();
    streamPipe(stream, writable);

    return new Response(readable, {
      headers: {
        "Content-Type": mime,
        "Content-Length": String(total),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=86400",
      },
    });
  });

  // Preset providers that support image generation
  const IMAGE_PROVIDER_PRESETS = [
    { id: "volcengine", displayName: "火山引擎 (豆包)" },
    { id: "openai", displayName: "OpenAI" },
  ];

  // Known image models per provider (mirrors known-models.json type:image entries)
  const KNOWN_IMAGE_MODELS = {
    volcengine: [
      { id: "doubao-seedream-3-0-t2i", name: "Seedream 3.0" },
      { id: "doubao-seedream-4-0-250828", name: "Seedream 4.0" },
      { id: "doubao-seedream-4-5-251128", name: "Seedream 4.5" },
      { id: "doubao-seedream-5-0-lite-260128", name: "Seedream 5.0 Lite" },
    ],
    openai: [
      { id: "gpt-image-1", name: "GPT Image 1" },
      { id: "gpt-image-1.5", name: "GPT Image 1.5" },
      { id: "gpt-image-1-mini", name: "GPT Image 1 Mini" },
      { id: "dall-e-3", name: "DALL-E 3" },
    ],
  };

  // Provider summary for Media settings tab
  app.get("/providers", async (c) => {
    try {
      const { models } = await ctx.bus.request("provider:models-by-type", { type: "image" });
      // Group added image models by provider
      const grouped = {};
      for (const m of (models || [])) {
        if (!grouped[m.provider]) {
          const creds = await ctx.bus.request("provider:credentials", { providerId: m.provider });
          grouped[m.provider] = {
            providerId: m.provider,
            hasCredentials: !creds.error,
            models: [],
            availableModels: [],
          };
        }
        grouped[m.provider].models.push({ id: m.id, name: m.name });
      }
      // Ensure preset providers always appear + attach available models
      for (const preset of IMAGE_PROVIDER_PRESETS) {
        if (!grouped[preset.id]) {
          const creds = await ctx.bus.request("provider:credentials", { providerId: preset.id });
          grouped[preset.id] = {
            providerId: preset.id,
            displayName: preset.displayName,
            hasCredentials: !creds.error,
            models: [],
            availableModels: [],
          };
        } else if (!grouped[preset.id].displayName) {
          grouped[preset.id].displayName = preset.displayName;
        }
        // Compute available = known - already added
        const known = KNOWN_IMAGE_MODELS[preset.id] || [];
        const addedIds = new Set(grouped[preset.id].models.map(m => m.id));
        grouped[preset.id].availableModels = known.filter(m => !addedIds.has(m.id));
      }
      return c.json({ providers: grouped, config: ctx.config.get() || {} });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Save plugin config (default model, provider defaults)
  app.put("/config", async (c) => {
    try {
      const body = await c.req.json();
      for (const [key, value] of Object.entries(body)) {
        ctx.config.set(key, value);
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });
}

/** Pipe a Node.js Readable into a Web WritableStream */
function streamPipe(nodeStream, writable) {
  const writer = writable.getWriter();
  nodeStream.on("data", (chunk) => writer.write(chunk));
  nodeStream.on("end", () => writer.close());
  nodeStream.on("error", () => writer.close());
}
