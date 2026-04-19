/**
 * model-sync.js 单元测试
 *
 * 测试：added-models.yaml → models.json 单向投影
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// mock known-models 词典查询：provider + model 二级结构
const KNOWN_MODELS = {
  dashscope: {
    "qwen3.5-flash": { name: "Qwen3.5 Flash", context: 131072, maxOutput: 8192, vision: true, reasoning: true, quirks: ["enable_thinking"] },
  },
  deepseek: {
    "deepseek-chat": { name: "DeepSeek Chat", context: 128000, maxOutput: 8192 },
  },
  openai: {
    "gpt-4o": { name: "GPT-4o", context: 128000, maxOutput: 16384, vision: true },
    "gpt-image-1": { name: "GPT Image 1", type: "image" },
  },
};

vi.mock("../shared/known-models.js", () => ({
  lookupKnown(provider, modelId) {
    if (provider && KNOWN_MODELS[provider]?.[modelId]) return KNOWN_MODELS[provider][modelId];
    for (const models of Object.values(KNOWN_MODELS)) {
      if (models[modelId]) return models[modelId];
    }
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
    expect(model.vision).toBe(true);
    expect(model.reasoning).toBe(true);
    expect(model.quirks).toEqual(["enable_thinking"]);
  });

  it("sets vision: false and input: ['text'] for models without vision", async () => {
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
    expect(model.vision).toBe(false);
    expect(model.reasoning).toBe(false);
    expect(model.input).toEqual(["text"]);
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
    expect(model.vision).toBe(false); // unknown model defaults to false
    expect(model.reasoning).toBe(false);
  });
});
