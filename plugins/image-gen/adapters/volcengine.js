// plugins/image-gen/adapters/volcengine.js
import fs from "fs";
import path from "path";
import { saveImage } from "../lib/download.js";

const FORMAT_TO_MIME = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

// 分辨率档位 + 长宽比 → 具体像素值查表
const SIZE_TABLE = {
  "2K": {
    "1:1": "2048x2048", "4:3": "2304x1728", "3:4": "1728x2304",
    "16:9": "2848x1600", "9:16": "1600x2848", "3:2": "2496x1664",
    "2:3": "1664x2496", "21:9": "3136x1344",
  },
  "4K": {
    "1:1": "4096x4096", "4:3": "3456x2592", "3:4": "2592x3456",
    "16:9": "4096x2304", "9:16": "2304x4096", "3:2": "3744x2496",
    "2:3": "2496x3744", "21:9": "4704x2016",
  },
};

function resolveSize(size, aspectRatio, providerDefaults) {
  const effectiveRatio = aspectRatio || providerDefaults?.aspect_ratio;
  const effectiveSize = size || providerDefaults?.size || "2K";

  if (effectiveRatio) {
    // 查表：分辨率档位 + 比例 → 像素值
    const tier = SIZE_TABLE[effectiveSize.toUpperCase()] || SIZE_TABLE["2K"];
    return tier[effectiveRatio] || effectiveSize;
  }
  return effectiveSize;
}

export const volcengineImageAdapter = {
  id: "volcengine",
  name: "火山引擎 Seedream",
  types: ["image"],
  capabilities: {
    ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
    resolutions: ["2k", "4k"],
  },

  async checkAuth(ctx) {
    try {
      const creds = await ctx.bus.request("provider:credentials", { providerId: "volcengine" });
      if (creds.error || !creds.apiKey) {
        return { ok: false, message: creds.error || "未配置 API Key" };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || String(err) };
    }
  },

  async submit(params, ctx) {
    // 1. Fetch credentials — try volcengine first, fall back to volcengine-coding
    let creds = await ctx.bus.request("provider:credentials", { providerId: "volcengine" });
    if (creds.error || !creds.apiKey) {
      const fallback = await ctx.bus.request("provider:credentials", { providerId: "volcengine-coding" });
      if (!fallback.error && fallback.apiKey) {
        creds = fallback;
      } else {
        throw new Error(`Provider "volcengine" 未配置 API Key。请在设置 → Providers 中配置。`);
      }
    }

    const { apiKey, baseUrl } = creds;

    // 2. Resolve model
    const modelId = params.model || ctx.config?.get?.("defaultImageModel")?.id || "seedream-3-0";

    // 3. Get provider defaults
    const allDefaults = ctx.config?.get?.("providerDefaults") || {};
    const providerDefaults = allDefaults["volcengine"] || {};

    // 4. Translate params → API body
    const outputFormat = params.format || providerDefaults?.format || "jpeg";
    const body = {
      model: modelId,
      prompt: params.prompt,
      response_format: "b64_json",
      output_format: outputFormat,
      size: resolveSize(params.size, params.aspect_ratio || params.aspectRatio, providerDefaults),
    };

    // 5. Handle reference image (local path → base64 data URL)
    if (params.image) {
      const images = Array.isArray(params.image) ? params.image : [params.image];
      body.image = await Promise.all(images.map(async img => {
        if (path.isAbsolute(img) && fs.existsSync(img)) {
          const buf = await fs.promises.readFile(img);
          const ext = path.extname(img).slice(1).toLowerCase();
          const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }[ext] || "image/png";
          return `data:${mime};base64,${buf.toString("base64")}`;
        }
        return img; // URL 或已经是 base64
      }));
    }

    // Apply provider-specific defaults (watermark defaults to false)
    body.watermark = providerDefaults?.watermark ?? false;
    if (providerDefaults) {
      if (providerDefaults.guidance_scale !== undefined) body.guidance_scale = providerDefaults.guidance_scale;
      if (providerDefaults.seed !== undefined) body.seed = providerDefaults.seed;
    }

    // 6. Call HTTP API
    const url = `${baseUrl.replace(/\/+$/, "")}/images/generations`;
    const res = await fetch(url, {
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
