// plugins/image-gen/adapters/openai.js
import fs from "fs";
import path from "path";
import { saveImage } from "../lib/download.js";

const FORMAT_TO_MIME = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

// OpenAI gpt-image 支持的尺寸
const OPENAI_RATIO_TO_SIZE = {
  "1:1": "1024x1024",
  "4:3": "1536x1024", "3:4": "1024x1536",
  "16:9": "1536x1024", "9:16": "1024x1536",
  "3:2": "1536x1024", "2:3": "1024x1536",
};

export const openaiImageAdapter = {
  id: "openai",
  name: "OpenAI Image",
  types: ["image"],
  capabilities: {
    ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"],
    resolutions: [],
  },

  async checkAuth(ctx) {
    try {
      const creds = await ctx.bus.request("provider:credentials", { providerId: "openai" });
      if (creds.error || !creds.apiKey) {
        return { ok: false, message: creds.error || "未配置 API Key" };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || String(err) };
    }
  },

  async submit(params, ctx) {
    // 1. Fetch credentials
    const creds = await ctx.bus.request("provider:credentials", { providerId: "openai" });
    if (creds.error || !creds.apiKey) {
      throw new Error(`Provider "openai" 未配置 API Key。请在设置 → Providers 中配置。`);
    }

    const { apiKey, baseUrl } = creds;

    // 2. Resolve model
    const modelId = params.model || ctx.config?.get?.("defaultImageModel")?.id || "gpt-image-1";

    // 3. Get provider defaults
    const allDefaults = ctx.config?.get?.("providerDefaults") || {};
    const providerDefaults = allDefaults["openai"] || {};

    // 4. Translate params → API body
    const outputFormat = params.format || providerDefaults?.format || "jpeg";
    const effectiveRatio = params.aspect_ratio || params.aspectRatio || providerDefaults?.aspect_ratio;
    const body = {
      model: modelId,
      prompt: params.prompt,
      n: 1,
      output_format: outputFormat,
    };

    // size: 显式 size > 长宽比查表 > provider 默认
    if (params.size) {
      body.size = params.size;
    } else if (effectiveRatio && OPENAI_RATIO_TO_SIZE[effectiveRatio]) {
      body.size = OPENAI_RATIO_TO_SIZE[effectiveRatio];
    } else if (providerDefaults?.size) {
      body.size = providerDefaults.size;
    }

    const quality = params.quality || providerDefaults?.quality;
    if (quality) body.quality = quality;

    if (providerDefaults?.background) body.background = providerDefaults.background;

    // 5. Handle reference image (local path → base64 data URL) for image-to-image
    if (params.image) {
      const images = Array.isArray(params.image) ? params.image : [params.image];
      body.image = images.map(img => {
        if (path.isAbsolute(img) && fs.existsSync(img)) {
          const buf = fs.readFileSync(img);
          const ext = path.extname(img).slice(1).toLowerCase();
          const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }[ext] || "image/png";
          return `data:${mime};base64,${buf.toString("base64")}`;
        }
        return img;
      });
    }

    // 6. Call HTTP API — OpenAI gpt-image 用 /images/edits 做图生图
    const base = baseUrl.replace(/\/+$/, "");
    const endpoint = body.image
      ? `${base}/images/edits`
      : `${base}/images/generations`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try {
        const err = await res.json();
        if (err.error?.message) msg = `${msg}: ${err.error.message}`;
      } catch {}
      throw new Error(msg);
    }

    const data = await res.json();
    const responseImages = data.data || [];
    if (responseImages.length === 0) {
      throw new Error("API returned no images");
    }

    const mimeType = FORMAT_TO_MIME[outputFormat] || "image/png";

    // Note revised_prompt in log if present (not surfaced to caller)
    const revisedPrompt = responseImages[0]?.revised_prompt;
    if (revisedPrompt && ctx.log) {
      ctx.log(`[openai-image] revised_prompt: ${revisedPrompt}`);
    }

    // 7. Save files using saveImage() — it appends /generated/ internally, so pass ctx.dataDir
    const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const files = [];
    for (let i = 0; i < responseImages.length; i++) {
      const buffer = Buffer.from(responseImages[i].b64_json, "base64");
      const customName = params.filename
        ? (responseImages.length > 1 ? `${params.filename}-${i + 1}` : params.filename)
        : null;
      const { filename } = await saveImage(buffer, mimeType, ctx.dataDir, customName);
      files.push(filename);
    }

    // 8. Return taskId + files
    return { taskId, files };
  },
  // No query() needed — files returned in submit = fake-async
};
