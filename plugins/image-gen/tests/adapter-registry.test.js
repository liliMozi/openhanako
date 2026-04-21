import { describe, it, expect, beforeEach } from "vitest";
import { AdapterRegistry } from "../lib/adapter-registry.js";

let registry;

const fakeImageAdapter = {
  id: "fake-image",
  name: "Fake Image",
  types: ["image"],
  capabilities: { ratios: ["1:1"], resolutions: ["2k"] },
};

const fakeVideoAdapter = {
  id: "fake-video",
  name: "Fake Video",
  types: ["video"],
  capabilities: { durations: [5, 10] },
};

const fakeBothAdapter = {
  id: "fake-both",
  name: "Fake Both",
  types: ["image", "video"],
  capabilities: { ratios: ["1:1"], resolutions: ["2k"], durations: [5] },
};

beforeEach(() => {
  registry = new AdapterRegistry();
});

describe("register / get", () => {
  it("registers and retrieves an adapter by id", () => {
    registry.register(fakeImageAdapter);
    expect(registry.get("fake-image")).toBe(fakeImageAdapter);
  });

  it("returns null for unknown id", () => {
    expect(registry.get("nope")).toBeNull();
  });

  it("overwrites on duplicate id", () => {
    registry.register(fakeImageAdapter);
    const updated = { ...fakeImageAdapter, name: "Updated" };
    registry.register(updated);
    expect(registry.get("fake-image").name).toBe("Updated");
  });
});

describe("unregister", () => {
  it("removes an adapter", () => {
    registry.register(fakeImageAdapter);
    registry.unregister("fake-image");
    expect(registry.get("fake-image")).toBeNull();
  });

  it("is a no-op for unknown id", () => {
    expect(() => registry.unregister("nope")).not.toThrow();
  });
});

describe("getByType", () => {
  it("returns only adapters supporting the given type", () => {
    registry.register(fakeImageAdapter);
    registry.register(fakeVideoAdapter);
    registry.register(fakeBothAdapter);
    const imageAdapters = registry.getByType("image");
    expect(imageAdapters.map((a) => a.id).sort()).toEqual(["fake-both", "fake-image"]);
  });

  it("returns empty array for unsupported type", () => {
    registry.register(fakeImageAdapter);
    expect(registry.getByType("audio")).toEqual([]);
  });
});

describe("getDefault", () => {
  it("returns the first registered adapter of that type", () => {
    registry.register(fakeImageAdapter);
    registry.register(fakeBothAdapter);
    expect(registry.getDefault("image").id).toBe("fake-image");
  });

  it("returns null when no adapter supports the type", () => {
    expect(registry.getDefault("video")).toBeNull();
  });
});

describe("list", () => {
  it("returns all registered adapters", () => {
    registry.register(fakeImageAdapter);
    registry.register(fakeVideoAdapter);
    expect(registry.list()).toHaveLength(2);
  });
});
