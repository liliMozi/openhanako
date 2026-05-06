/**
 * model-sync.js 单元测试
 *
 * 测试：added-models.yaml → models.json 单向投影
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// mock known-models 词典查询：provider + model 二级结构，未命中时再查通用 fallback
const KNOWN_MODELS = {
  dashscope: {
    "qwen3.5-flash": {
      name: "Qwen3.5 Flash",
      context: 131072,
      maxOutput: 8192,
      image: true,
      reasoning: true,
      quirks: ["enable_thinking"],
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "qwen", groundingMode: "native" },
    },
    "qwen3.6-plus": {
      name: "Qwen3.6 Plus",
      context: 1000000,
      maxOutput: 65536,
      image: true,
      reasoning: true,
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "qwen", groundingMode: "native" },
    },
    "qwen3-vl-plus": {
      name: "Qwen3 VL Plus",
      context: 262144,
      maxOutput: 32768,
      image: true,
      reasoning: true,
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "qwen", groundingMode: "native" },
    },
  },
  deepseek: {
    "deepseek-chat": { name: "DeepSeek Chat", context: 128000, maxOutput: 8192 },
    "deepseek-v4-pro": { name: "DeepSeek V4 Pro", context: 1000000, maxOutput: 384000, reasoning: true, xhigh: true },
  },
  openai: {
    "gpt-4o": {
      name: "GPT-4o",
      context: 128000,
      maxOutput: 16384,
      image: true,
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "anchor", groundingMode: "prompted" },
    },
    "gpt-image-1": { name: "GPT Image 1", type: "image" },
  },
  gemini: {
    "gemini-3-flash-preview": {
      name: "Gemini 3 Flash Preview",
      context: 1048576,
      maxOutput: 65535,
      image: true,
      reasoning: true,
      visionCapabilities: { grounding: true, boxes: true, points: false, coordinateSpace: "norm-1000", boxOrder: "yxyx", outputFormat: "gemini", groundingMode: "native" },
    },
  },
  "kimi-coding": {
    "kimi-for-coding": {
      name: "Kimi for Coding",
      context: 262144,
      maxOutput: 32768,
      image: true,
      reasoning: true,
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "anchor", groundingMode: "prompted" },
    },
    "kimi-k2.6": {
      name: "Kimi K2.6",
      context: 262144,
      maxOutput: 98304,
      image: true,
      reasoning: true,
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "anchor", groundingMode: "prompted" },
    },
  },
  minimax: {
    "MiniMax-M2.7": { name: "MiniMax M2.7", context: 204800, maxOutput: 131072, reasoning: true },
  },
  // 兼容读验证：legacy-vision 模型词典里用旧字段 vision，model-sync 应当识别并投影为 input
  legacy: {
    "legacy-vision-model": { name: "Legacy Vision Model", context: 32000, vision: true },
  },
};

const GENERIC_MODEL_FALLBACKS = {
  "kimi-k2.6": {
    name: "Kimi K2.6",
    context: 262144,
    maxOutput: 98304,
    image: true,
    reasoning: true,
    visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "anchor", groundingMode: "prompted" },
  },
};

vi.mock("../shared/known-models.js", () => ({
  lookupKnown(provider, modelId) {
    if (provider && KNOWN_MODELS[provider]?.[modelId]) return KNOWN_MODELS[provider][modelId];
    const bare = modelId.includes("/") ? modelId.split("/").pop() : null;
    if (bare && provider && KNOWN_MODELS[provider]?.[bare]) return KNOWN_MODELS[provider][bare];
    if (GENERIC_MODEL_FALLBACKS[modelId]) return GENERIC_MODEL_FALLBACKS[modelId];
    if (bare && GENERIC_MODEL_FALLBACKS[bare]) return GENERIC_MODEL_FALLBACKS[bare];
    return null;
  },
}));

const tmpDir = path.join(os.tmpdir(), "hana-test-model-sync-" + Date.now());
let modelsJsonPath;
let authJsonPath;

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  modelsJsonPath = path.join(tmpDir, "models.json");
  authJsonPath = path.join(tmpDir, "auth.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadSync() {
  const mod = await import("../core/model-sync.js");
  return mod.syncModels;
}

describe("syncModels", () => {
  it("writes providers with credentials and models to models.json", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3.5-flash"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.dashscope).toBeDefined();
    expect(result.providers.dashscope.baseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(result.providers.dashscope.api).toBe("openai-completions");
    expect(result.providers.dashscope.apiKey).toBe("sk-test");
    expect(result.providers.dashscope.models).toHaveLength(1);
    expect(result.providers.dashscope.models[0].id).toBe("qwen3.5-flash");
  });

  it("skips providers without api_key (and not localhost/OAuth)", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        // no api_key
        models: ["qwen3.5-flash"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.dashscope).toBeUndefined();
    expect(Object.keys(result.providers)).toHaveLength(0);
  });

  it("skips providers without models", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        // no models
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.dashscope).toBeUndefined();
  });

  it("skips providers without base_url", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        // no base_url
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3.5-flash"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.dashscope).toBeUndefined();
  });

  it("enriches model metadata from known-models dictionary", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3.5-flash"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.dashscope.models[0];
    expect(model.name).toBe("Qwen3.5 Flash");
    expect(model.contextWindow).toBe(131072);
    expect(model.maxTokens).toBe(8192);
    expect(model.input).toEqual(["text", "image"]);
    // 运行时 Model 对象不再挂 vision 字段（Pi SDK 标准用 input 数组）
    expect(model.vision).toBeUndefined();
    expect(model.reasoning).toBe(true);
    expect(model.quirks).toEqual(["enable_thinking"]);
    expect(model.compat.thinkingFormat).toBe("qwen");
  });

  it("projects native and prompted visual grounding family formats", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3-vl-plus", "qwen3.5-flash", "qwen3.6-plus"],
      },
      openai: {
        base_url: "https://api.openai.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["gpt-4o"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.dashscope.models[0].visionCapabilities).toEqual({
      grounding: true,
      boxes: true,
      points: true,
      coordinateSpace: "norm-1000",
      boxOrder: "xyxy",
      outputFormat: "qwen",
      groundingMode: "native",
    });
    expect(result.providers.dashscope.models[1].visionCapabilities).toMatchObject({
      outputFormat: "qwen",
      groundingMode: "native",
    });
    expect(result.providers.dashscope.models[2].visionCapabilities).toMatchObject({
      outputFormat: "qwen",
      groundingMode: "native",
    });
    expect(result.providers.openai.models[0].visionCapabilities).toMatchObject({
      outputFormat: "anchor",
      groundingMode: "prompted",
    });
  });

  it("accepts explicit user visual grounding capabilities for custom image models", async () => {
    const syncModels = await loadSync();

    const providers = {
      custom: {
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [{
          id: "custom-grounded-vl",
          image: true,
          visionCapabilities: {
            grounding: true,
            boxes: true,
            points: false,
            coordinateSpace: "norm-1000",
            boxOrder: "yxyx",
            outputFormat: "gemini",
            groundingMode: "native",
          },
        }],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.custom.models[0].visionCapabilities).toEqual({
      grounding: true,
      boxes: true,
      points: false,
      coordinateSpace: "norm-1000",
      boxOrder: "yxyx",
      outputFormat: "gemini",
      groundingMode: "native",
    });
  });

  it("enriches provider models from generic fallbacks when provider-specific metadata is missing", async () => {
    const syncModels = await loadSync();

    const providers = {
      volcengine: {
        base_url: "https://ark.cn-beijing.volces.com/api/v3",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["kimi-k2.6"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.volcengine.models[0];
    expect(model.name).toBe("Kimi K2.6");
    expect(model.contextWindow).toBe(262144);
    expect(model.maxTokens).toBe(98304);
    expect(model.input).toEqual(["text", "image"]);
    expect(model.reasoning).toBe(true);
  });

  it("projects Kimi Coding Plan stable model with Anthropic thinking compat", async () => {
    const syncModels = await loadSync();

    const providers = {
      "kimi-coding": {
        base_url: "https://api.kimi.com/coding/",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: ["kimi-for-coding"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["kimi-coding"]).toMatchObject({
      baseUrl: "https://api.kimi.com/coding/",
      api: "anthropic-messages",
      apiKey: "sk-test",
    });
    expect(result.providers["kimi-coding"].models).toBeUndefined();
    expect(result.providers["kimi-coding"].modelOverrides).toBeUndefined();
  });

  it("preserves user metadata for Pi built-in Kimi Coding models as model overrides", async () => {
    const syncModels = await loadSync();

    const providers = {
      "kimi-coding": {
        base_url: "https://api.kimi.com/coding/",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: [{ id: "kimi-for-coding", name: "Kimi 自定义显示名", maxOutput: 16000, image: false }],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["kimi-coding"].models).toBeUndefined();
    expect(result.providers["kimi-coding"].modelOverrides["kimi-for-coding"]).toEqual({
      name: "Kimi 自定义显示名",
      maxTokens: 16000,
      input: ["text"],
    });
  });

  it("keeps Kimi OpenAI-compatible configs custom while reusing Pi request headers", async () => {
    const syncModels = await loadSync();

    const providers = {
      "kimi-coding": {
        base_url: "https://api.kimi.com/coding/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["kimi-for-coding"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers["kimi-coding"].models[0];
    expect(model.id).toBe("kimi-for-coding");
    expect(model.headers).toEqual({ "User-Agent": "KimiCLI/1.5" });
  });

  it("marks Anthropic-compatible reasoning models with anthropic thinking format", async () => {
    const syncModels = await loadSync();

    const providers = {
      "kimi-coding": {
        base_url: "https://api.kimi.com/coding/",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: ["kimi-k2.6"],
      },
      minimax: {
        base_url: "https://api.minimaxi.com/anthropic",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: ["MiniMax-M2.7"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["kimi-coding"].models[0].compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: "anthropic",
    });
    expect(result.providers.minimax.models[0].compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: "anthropic",
    });
  });

  it("marks DeepSeek V4 on the Anthropic endpoint with an explicit reasoning profile", async () => {
    const syncModels = await loadSync();

    const providers = {
      deepseek: {
        base_url: "https://api.deepseek.com/anthropic",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: ["deepseek-v4-pro"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.deepseek.models[0].compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: "anthropic",
      reasoningProfile: "deepseek-v4-anthropic",
    });
  });

  it("does not infer thinkingFormat from Anthropic protocol without reasoning capability", async () => {
    const syncModels = await loadSync();

    const providers = {
      "custom-anthropic-proxy": {
        base_url: "https://example.test/anthropic",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: [{ id: "plain-chat", reasoning: false }],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["custom-anthropic-proxy"].models[0].compat).toEqual({
      supportsDeveloperRole: false,
    });
  });

  it("sets input: ['text'] for models without image modality (no vision field on Model)", async () => {
    const syncModels = await loadSync();

    const providers = {
      deepseek: {
        base_url: "https://api.deepseek.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["deepseek-chat"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.deepseek.models[0];
    expect(model.vision).toBeUndefined();
    expect(model.reasoning).toBe(false);
    expect(model.input).toEqual(["text"]);
  });

  it("infers image modality for discovered multimodal model ids", async () => {
    const syncModels = await loadSync();

    const providers = {
      zhipu: {
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["GLM-5V-Turbo"],
      },
      minimax: {
        base_url: "https://api.minimax.chat/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [{ id: "mimo-v2-omni", name: "MIMO v2 Omni" }],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.zhipu.models[0].input).toEqual(["text", "image"]);
    expect(result.providers.minimax.models[0].input).toEqual(["text", "image"]);
  });

  it("rejects the official DeepSeek provider id before writing models.json", async () => {
    const syncModels = await loadSync();

    const providers = {
      deepseek: {
        base_url: "https://api.deepseek.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["deepseek"],
      },
    };

    expect(() => syncModels(providers, { modelsJsonPath }))
      .toThrow(/deepseek.*provider.*model/i);
    expect(fs.existsSync(modelsJsonPath)).toBe(false);
  });

  it("accepts legacy 'vision' field in dictionary and projects to input array", async () => {
    const syncModels = await loadSync();
    const providers = {
      legacy: {
        base_url: "https://legacy.api.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["legacy-vision-model"],
      },
    };
    syncModels(providers, { modelsJsonPath });
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.legacy.models[0];
    expect(model.input).toEqual(["text", "image"]);
    expect(model.vision).toBeUndefined();
  });

  it("accepts legacy 'vision' field in user override and projects to input array", async () => {
    const syncModels = await loadSync();
    const providers = {
      deepseek: {
        base_url: "https://api.deepseek.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [{ id: "deepseek-chat", vision: true }],  // legacy user override
      },
    };
    syncModels(providers, { modelsJsonPath });
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.deepseek.models[0];
    expect(model.input).toEqual(["text", "image"]);
    expect(model.vision).toBeUndefined();
  });

  it("handles model objects with user overrides (name, context, maxOutput)", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [
          { id: "qwen3.5-flash", name: "My Custom Qwen", context: 65536, maxOutput: 4096 },
        ],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.dashscope.models[0];
    expect(model.id).toBe("qwen3.5-flash");
    expect(model.name).toBe("My Custom Qwen");
    expect(model.contextWindow).toBe(65536);
    expect(model.maxTokens).toBe(4096);
  });

  it("uses atomic write (tmp + rename)", async () => {
    const syncModels = await loadSync();

    const renameSpy = vi.spyOn(fs, "renameSync");

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3.5-flash"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    // renameSync should have been called with a tmp path → final path
    expect(renameSpy).toHaveBeenCalledTimes(1);
    const [src, dest] = renameSpy.mock.calls[0];
    expect(dest).toBe(modelsJsonPath);
    expect(src).toMatch(/\.tmp$/);

    renameSpy.mockRestore();
  });

  it("returns false if no changes", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3.5-flash"],
      },
    };

    // first call: writes
    const changed1 = syncModels(providers, { modelsJsonPath });
    expect(changed1).toBe(true);

    // second call: same data, no change
    const changed2 = syncModels(providers, { modelsJsonPath });
    expect(changed2).toBe(false);
  });

  it("allows localhost providers without api_key", async () => {
    const syncModels = await loadSync();

    const providers = {
      ollama: {
        base_url: "http://localhost:11434/v1",
        api: "openai-completions",
        // no api_key — but localhost, should pass
        models: ["llama3"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.ollama).toBeDefined();
    expect(result.providers.ollama.apiKey).toBe("local");
    expect(result.providers.ollama.models[0].id).toBe("llama3");
  });

  it("allows IPv6 loopback providers without api_key", async () => {
    const syncModels = await loadSync();

    const providers = {
      ollama: {
        base_url: "http://[::1]:11434/v1",
        api: "openai-completions",
        models: ["llama3"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.ollama).toBeDefined();
    expect(result.providers.ollama.apiKey).toBe("local");
    expect(result.providers.ollama.models[0].id).toBe("llama3");
  });

  it("allows no-auth providers without api_key on remote base URLs", async () => {
    const syncModels = await loadSync();

    const providers = {
      ollama: {
        base_url: "http://192.168.1.20:11434/v1",
        api: "openai-completions",
        auth_type: "none",
        models: ["llama3"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.ollama).toBeDefined();
    expect(result.providers.ollama.apiKey).toBe("local");
    expect(result.providers.ollama.models[0].id).toBe("llama3");
  });

  it("derives no-auth policy from ProviderRegistry for existing Ollama configs", async () => {
    const { ModelManager } = await import("../core/model-manager.js");
    fs.writeFileSync(path.join(tmpDir, "added-models.yaml"), [
      "providers:",
      "  ollama:",
      "    base_url: http://192.168.1.20:11434/v1",
      "    api: openai-completions",
      "    models:",
      "      - llama3",
      "",
    ].join("\n"), "utf-8");

    const mm = new ModelManager({ hanakoHome: tmpDir });
    mm._modelRegistry = {
      refresh: vi.fn(),
      getAvailable: vi.fn().mockResolvedValue([{ id: "llama3", provider: "ollama" }]),
    };

    const changed = await mm.syncAndRefresh();

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.ollama).toBeDefined();
    expect(result.providers.ollama.apiKey).toBe("local");
    expect(mm._modelRegistry.refresh).toHaveBeenCalledTimes(1);
    expect(mm.availableModels).toEqual([{ id: "llama3", provider: "ollama" }]);
  });

  it("handles multiple providers in one call", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-dash",
        models: ["qwen3.5-flash"],
      },
      deepseek: {
        base_url: "https://api.deepseek.com/v1",
        api: "openai-completions",
        api_key: "sk-deep",
        models: ["deepseek-chat"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(Object.keys(result.providers)).toHaveLength(2);
    expect(result.providers.dashscope.models[0].id).toBe("qwen3.5-flash");
    expect(result.providers.deepseek.models[0].id).toBe("deepseek-chat");
    expect(result.providers.deepseek.models[0].name).toBe("DeepSeek Chat");
  });

  it("sets compat.supportsStore=false for gemini provider (avoid 400 from /v1beta/openai)", async () => {
    const syncModels = await loadSync();

    const providers = {
      gemini: {
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["gemini-2.0-flash"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.gemini.models[0].compat).toBeDefined();
    expect(result.providers.gemini.models[0].compat.supportsStore).toBe(false);
  });

  it("sets compat.supportsStore=false when base_url points at generativelanguage even with non-gemini provider id", async () => {
    const syncModels = await loadSync();

    const providers = {
      "my-gemini-proxy": {
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["gemini-2.0-flash"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["my-gemini-proxy"].models[0].compat.supportsStore).toBe(false);
  });

  it("skips models with type: image from models.json output", async () => {
    const syncModels = await loadSync();

    const providers = {
      openai: {
        base_url: "https://api.openai.com/v1",
        api_key: "sk-test",
        api: "openai-completions",
        models: [
          "gpt-4o",
          { id: "gpt-image-1", type: "image" },
        ],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const models = result.providers.openai?.models || [];
    const ids = models.map(m => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).not.toContain("gpt-image-1");
  });

  it("skips string model entries whose type is image via known-models lookup", async () => {
    const syncModels = await loadSync();

    const providers = {
      openai: {
        base_url: "https://api.openai.com/v1",
        api_key: "sk-test",
        api: "openai-completions",
        models: ["gpt-4o", "gpt-image-1"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const models = result.providers.openai?.models || [];
    const ids = models.map(m => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).not.toContain("gpt-image-1");
  });

  it("falls back to humanized name for unknown models", async () => {
    const syncModels = await loadSync();

    const providers = {
      custom: {
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        api_key: "sk-custom",
        models: ["my-custom-model-240101"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.custom.models[0];
    // date suffix stripped, humanized
    expect(model.name).toBe("My Custom Model");
    expect(model.contextWindow).toBe(128000); // default
    expect(model.input).toEqual(["text"]); // unknown model defaults to text-only
    expect(model.vision).toBeUndefined();
    expect(model.reasoning).toBe(false);
  });
});
