import { describe, it, expect, vi, beforeEach } from "vitest";

// generate-image no longer imports adapter modules directly — adapters come
// through ctx._mediaGen.registry.  We import the tool fresh each time so
// module-level state doesn't leak between tests.

let execute, name, description, parameters;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("../plugins/image-gen/tools/generate-image.js");
  execute = mod.execute;
  name = mod.name;
  description = mod.description;
  parameters = mod.parameters;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(overrides = {}) {
  return {
    id: "fake-provider",
    types: ["image"],
    checkAuth: vi.fn(async () => ({ ok: true })),
    submit: vi.fn(async () => ({ taskId: "task-001" })),
    ...overrides,
  };
}

function makeMediaGen(adapterOverrides = {}) {
  const adapter = makeAdapter(adapterOverrides);
  const registry = {
    get: vi.fn((id) => (id === adapter.id ? adapter : undefined)),
    getDefault: vi.fn((_type) => adapter),
    getByType: vi.fn((_type) => [adapter]),
  };
  const store = {
    add: vi.fn(),
    update: vi.fn(),
  };
  const poller = {
    add: vi.fn(),
  };
  return { registry, store, poller, adapter };
}

function makeCtx(mediaGen, busOverrides = {}) {
  return {
    _mediaGen: mediaGen,
    dataDir: "/tmp/test-data",
    sessionPath: "/sessions/test.jsonl",
    bus: {
      request: vi.fn(async () => ({})),
      ...busOverrides,
    },
    log: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generate-image tool — metadata", () => {
  it("exports correct name and required param", () => {
    expect(name).toBe("generate-image");
    expect(description).toBeTruthy();
    expect(parameters.required).toContain("prompt");
  });
});

describe("generate-image tool — initialization guard", () => {
  it("returns error text when ctx._mediaGen is missing", async () => {
    const ctx = makeCtx(null);
    const result = await execute({ prompt: "a cat" }, ctx);
    expect(result.content[0].text).toContain("未初始化");
  });

  it("returns error text when registry is missing from _mediaGen", async () => {
    const ctx = makeCtx({ store: {}, poller: {} });
    const result = await execute({ prompt: "a cat" }, ctx);
    expect(result.content[0].text).toContain("未初始化");
  });
});

describe("generate-image tool — adapter resolution", () => {
  it("returns error when no adapter of that type exists", async () => {
    const { registry, store, poller } = makeMediaGen();
    registry.getByType.mockReturnValue([]);
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "a cat" }, ctx);
    expect(result.content[0].text).toContain("没有可用的图片生成 provider");
  });

  it("returns error when explicit provider not found", async () => {
    const { registry, store, poller } = makeMediaGen();
    registry.get.mockReturnValue(undefined);
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "a cat", provider: "nonexistent" }, ctx);
    expect(result.content[0].text).toContain("没有可用的图片生成 provider");
  });

  it("uses explicit provider via registry.get when provider is specified", async () => {
    const { registry, store, poller, adapter } = makeMediaGen();
    registry.get.mockImplementation((id) => (id === "fake-provider" ? adapter : undefined));
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "a cat", provider: "fake-provider" }, ctx);
    expect(registry.get).toHaveBeenCalledWith("fake-provider");
  });

  it("uses last registered adapter when no provider specified", async () => {
    const { registry, store, poller } = makeMediaGen();
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "a cat" }, ctx);
    expect(registry.getByType).toHaveBeenCalledWith("image");
    expect(registry.get).not.toHaveBeenCalled();
  });
});

describe("generate-image tool — submit error", () => {
  it("returns error when submit throws", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => { throw new Error("CLI not found"); }),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "a cat" }, ctx);
    expect(result.content[0].text).toContain("CLI not found");
  });
});

describe("generate-image tool — single submit returns card", () => {
  it("returns iframe card on successful single submit", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-abc" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "a sunset" }, ctx);

    expect(result.content[0].text).toContain("已提交 1 张");
    expect(result.details.card.type).toBe("iframe");
    expect(result.details.card.route).toMatch(/^\/card\?batch=/);
    expect(result.details.card.title).toBe("图片生成");
    expect(result.details.card.description).toContain("a sunset");
  });

  it("records task in store", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-store" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "mountains" }, ctx);

    expect(store.add).toHaveBeenCalledOnce();
    const call = store.add.mock.calls[0][0];
    expect(call.taskId).toBe("t-store");
    expect(call.type).toBe("image");
    expect(call.prompt).toBe("mountains");
  });

  it("registers task with deferred:register", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-deferred" })),
    });
    const busRequest = vi.fn(async () => ({}));
    const ctx = makeCtx({ registry, store, poller }, { request: busRequest });

    await execute({ prompt: "ocean" }, ctx);

    const deferredCall = busRequest.mock.calls.find(([type]) => type === "deferred:register");
    expect(deferredCall).toBeTruthy();
    expect(deferredCall[1].taskId).toBe("t-deferred");
    expect(deferredCall[1].meta.type).toBe("image-generation");
  });

  it("adds task to poller", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-poll" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "forest" }, ctx);

    expect(poller.add).toHaveBeenCalledWith("t-poll");
  });

  it("calls store.update when submit returns files", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-files", files: ["img.png"] })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "a bird" }, ctx);

    expect(store.update).toHaveBeenCalledWith("t-files", { files: ["img.png"] });
  });
});

describe("generate-image tool — count=3 concurrent submits", () => {
  it("submits count times and records all tasks", async () => {
    let callIndex = 0;
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: `t-${++callIndex}` })),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "stars", count: 3 }, ctx);

    expect(store.add).toHaveBeenCalledTimes(3);
    expect(poller.add).toHaveBeenCalledTimes(3);
    expect(result.content[0].text).toContain("已提交 3 张");
  });

  it("clamps count to max 4", async () => {
    let callIndex = 0;
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: `t-${++callIndex}` })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "clouds", count: 10 }, ctx);

    expect(store.add).toHaveBeenCalledTimes(4);
  });

  it("clamps count to min 1", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-min" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "waves", count: 0 }, ctx);

    expect(store.add).toHaveBeenCalledTimes(1);
  });

  it("all tasks share the same batchId", async () => {
    let callIndex = 0;
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: `t-batch-${++callIndex}` })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "desert", count: 2 }, ctx);

    const batchIds = store.add.mock.calls.map(([arg]) => arg.batchId);
    expect(batchIds[0]).toBe(batchIds[1]);
    expect(batchIds[0]).toBeTruthy();
  });
});

describe("generate-image tool — partial failure handling", () => {
  it("reports partial failure in text and still returns card", async () => {
    let callIndex = 0;
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => {
        callIndex++;
        if (callIndex === 2) throw new Error("network error");
        return { taskId: `t-${callIndex}` };
      }),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "rain", count: 3 }, ctx);

    expect(result.content[0].text).toContain("已提交 2 张");
    expect(result.content[0].text).toContain("1 张提交失败");
    expect(result.details.card).toBeTruthy();
  });

  it("returns all-failed error when every submit throws", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => { throw new Error("quota exceeded"); }),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "snow", count: 2 }, ctx);

    expect(result.content[0].text).toContain("图片提交失败");
    expect(result.content[0].text).toContain("quota exceeded");
    expect(result.details).toBeUndefined();
  });

  it("counts task with no taskId as failure", async () => {
    let callIndex = 0;
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => {
        callIndex++;
        // second call returns no taskId
        return callIndex === 2 ? {} : { taskId: `t-${callIndex}` };
      }),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "ice", count: 2 }, ctx);

    expect(result.content[0].text).toContain("已提交 1 张");
    expect(result.content[0].text).toContain("1 张提交失败");
  });
});

describe("generate-image tool — image param (image-to-image)", () => {
  it("passes image param to adapter.submit", async () => {
    const { registry, store, poller, adapter } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-img2img" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "enhance", image: "/path/to/ref.png" }, ctx);

    const [submittedParams] = adapter.submit.mock.calls[0];
    expect(submittedParams.image).toBe("/path/to/ref.png");
  });

  it("omits image key from params when not provided", async () => {
    const { registry, store, poller, adapter } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-no-img" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "landscape" }, ctx);

    const [submittedParams] = adapter.submit.mock.calls[0];
    expect(submittedParams).not.toHaveProperty("image");
  });
});

describe("generate-image tool — deferred:register failure is non-fatal", () => {
  it("still returns card when deferred:register throws", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-deferred-fail" })),
    });
    const ctx = makeCtx({ registry, store, poller }, {
      request: vi.fn(async (type) => {
        if (type === "deferred:register") throw new Error("bus unavailable");
        return {};
      }),
    });

    const result = await execute({ prompt: "fire" }, ctx);

    expect(result.content[0].text).toContain("已提交 1 张");
    expect(result.details.card).toBeTruthy();
    expect(ctx.log.warn).toHaveBeenCalled();
  });
});
