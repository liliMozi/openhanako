import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// saveImage writes to disk — mock it out so tests stay pure
vi.mock("../plugins/image-gen/lib/download.js", () => ({
  saveImage: vi.fn(async (_buf, _mime, _dir, customName) => {
    const filename = customName ? `${customName}-abc.png` : `1234-abc.png`;
    return { filename, filePath: `/tmp/generated/${filename}` };
  }),
}));

function makeBusCtx(apiKey, baseUrl, providerId = "volcengine") {
  return {
    bus: {
      request: vi.fn(async (type, payload) => {
        if (type === "provider:credentials" && payload.providerId === providerId) {
          return { apiKey, baseUrl };
        }
        return { error: "not_found" };
      }),
    },
    config: {
      get: vi.fn((key) => {
        if (key === "providerDefaults") return {};
        return null;
      }),
    },
    dataDir: "/tmp/test-data",
    log: vi.fn(),
  };
}

describe("volcengine adapter", () => {
  beforeEach(() => mockFetch.mockReset());

  it("sends correct request and returns files from b64_json", async () => {
    const { volcengineImageAdapter } = await import("../plugins/image-gen/adapters/volcengine.js");

    const fakeB64 = Buffer.from("fake-image").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ b64_json: fakeB64, size: "2048x2048" }],
      }),
    });

    const ctx = makeBusCtx("test-key", "https://ark.cn-beijing.volces.com/api/v3");
    const result = await volcengineImageAdapter.submit({
      prompt: "a cat",
      model: "doubao-seedream-4-0-250828",
      size: "2K",
      format: "png",
    }, ctx);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://ark.cn-beijing.volces.com/api/v3/images/generations");
    expect(opts.headers["Authorization"]).toBe("Bearer test-key");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("doubao-seedream-4-0-250828");
    expect(body.prompt).toBe("a cat");
    expect(body.response_format).toBe("b64_json");
    expect(body.size).toBe("2K");
    expect(body.output_format).toBe("png");

    expect(result.files).toHaveLength(1);
    expect(typeof result.taskId).toBe("string");
    expect(result.taskId.length).toBeGreaterThan(0);
  });

  it("applies providerDefaults (watermark, guidance_scale)", async () => {
    const { volcengineImageAdapter } = await import("../plugins/image-gen/adapters/volcengine.js");

    const fakeB64 = Buffer.from("img").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeB64 }] }),
    });

    const ctx = makeBusCtx("key", "https://test.com");
    ctx.config.get = vi.fn((key) => {
      if (key === "providerDefaults") return { volcengine: { watermark: true, guidance_scale: 7.5 } };
      return null;
    });

    await volcengineImageAdapter.submit({
      prompt: "test",
      model: "test-model",
    }, ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.watermark).toBe(true);
    expect(body.guidance_scale).toBe(7.5);
  });

  it("throws on API error with status and message", async () => {
    const { volcengineImageAdapter } = await import("../plugins/image-gen/adapters/volcengine.js");

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "invalid key" } }),
    });

    const ctx = makeBusCtx("bad", "https://test.com");
    await expect(volcengineImageAdapter.submit({
      prompt: "a cat", model: "test",
    }, ctx)).rejects.toThrow(/401/);
  });

  it("throws when data array is empty", async () => {
    const { volcengineImageAdapter } = await import("../plugins/image-gen/adapters/volcengine.js");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    const ctx = makeBusCtx("key", "https://test.com");
    await expect(volcengineImageAdapter.submit({
      prompt: "test", model: "test",
    }, ctx)).rejects.toThrow();
  });
});

describe("openai adapter", () => {
  beforeEach(() => mockFetch.mockReset());

  it("sends correct request and returns files from b64_json", async () => {
    const { openaiImageAdapter } = await import("../plugins/image-gen/adapters/openai.js");

    const fakeB64 = Buffer.from("fake-openai-image").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ b64_json: fakeB64, revised_prompt: "A fluffy dog in a park" }],
      }),
    });

    const ctx = makeBusCtx("sk-test", "https://api.openai.com/v1", "openai");
    const result = await openaiImageAdapter.submit({
      prompt: "a dog",
      model: "gpt-image-1",
      size: "1024x1024",
      quality: "medium",
      format: "png",
    }, ctx);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(opts.headers["Authorization"]).toBe("Bearer sk-test");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("gpt-image-1");
    expect(body.prompt).toBe("a dog");
    expect(body.quality).toBe("medium");
    expect(body.n).toBe(1);

    expect(result.files).toHaveLength(1);
    expect(typeof result.taskId).toBe("string");
  });

  it("applies providerDefaults (background)", async () => {
    const { openaiImageAdapter } = await import("../plugins/image-gen/adapters/openai.js");

    const fakeB64 = Buffer.from("img").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeB64 }] }),
    });

    const ctx = makeBusCtx("key", "https://api.openai.com/v1", "openai");
    ctx.config.get = vi.fn((key) => {
      if (key === "providerDefaults") return { openai: { background: "transparent" } };
      return null;
    });

    await openaiImageAdapter.submit({
      prompt: "test",
      model: "gpt-image-1",
    }, ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.background).toBe("transparent");
  });

  it("throws on API error", async () => {
    const { openaiImageAdapter } = await import("../plugins/image-gen/adapters/openai.js");

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: "rate limit exceeded" } }),
    });

    const ctx = makeBusCtx("key", "https://test.com", "openai");
    await expect(openaiImageAdapter.submit({
      prompt: "test", model: "test",
    }, ctx)).rejects.toThrow(/429/);
  });
});
