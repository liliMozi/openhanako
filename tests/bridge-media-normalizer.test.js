import path from "path";
import { describe, expect, it } from "vitest";

import { mediaItemKey, normalizeMediaItems } from "../lib/bridge/media-item-normalizer.js";

describe("bridge media item normalizer", () => {
  it("keeps structured session_file items", () => {
    const item = { type: "session_file", fileId: "sf_1", sessionPath: "/sessions/a.jsonl" };

    expect(normalizeMediaItems([item])).toEqual([item]);
  });

  it("normalizes remote URLs into remote_url items", () => {
    expect(normalizeMediaItems(["https://example.com/a.png"])).toEqual([
      { type: "remote_url", url: "https://example.com/a.png" },
    ]);
  });

  it("normalizes absolute legacy local paths into legacy_local_path items", () => {
    const filePath = path.resolve("/tmp/hana-media/a.png");

    expect(normalizeMediaItems([filePath])).toEqual([
      { type: "legacy_local_path", filePath },
    ]);
  });

  it("deduplicates entries by stable media key", () => {
    const sessionFile = { type: "session_file", fileId: "sf_1" };
    const remoteUrl = "https://example.com/a.png";

    expect(normalizeMediaItems([
      sessionFile,
      { ...sessionFile },
      remoteUrl,
      { type: "remote_url", url: remoteUrl },
    ])).toEqual([
      sessionFile,
      { type: "remote_url", url: remoteUrl },
    ]);
  });

  it("produces stable keys for typed items", () => {
    expect(mediaItemKey({ type: "session_file", fileId: "sf_1" })).toBe("session_file:sf_1");
    expect(mediaItemKey({ type: "remote_url", url: "https://example.com/a.png" }))
      .toBe("remote_url:https://example.com/a.png");
  });
});
