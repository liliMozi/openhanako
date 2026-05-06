import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addBookmarkEntry,
  addChannelMember,
  appendMessage,
  createChannel,
  parseChannel,
  readBookmarks,
  updateBookmark,
} from "../lib/channels/channel-store.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-channel-store-"));
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

describe("channel-store write locking", () => {
  let tmpDir;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      tmpDir = null;
    }
  });

  it("writes a default channel description when callers omit one", async () => {
    tmpDir = mktemp();
    const { id } = await createChannel(tmpDir, {
      id: "ch_without_description",
      name: "No Description",
      members: ["hana", "yui"],
    });

    const content = fs.readFileSync(path.join(tmpDir, `${id}.md`), "utf-8");
    const { meta } = parseChannel(content);

    expect(meta.description).toBe("No description");
  });

  it("preserves appended messages when frontmatter rewrite overlaps", async () => {
    tmpDir = mktemp();
    const channelPath = path.join(tmpDir, "crew.md");
    fs.writeFileSync(
      channelPath,
      [
        "---",
        "members: [alice]",
        "---",
        "",
      ].join("\n"),
      "utf-8",
    );

    const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
    const rewritePaused = deferred();
    const allowRewrite = deferred();
    const tmpPath = channelPath + ".tmp";

    vi.spyOn(fs.promises, "writeFile").mockImplementation(async (target, data, options) => {
      if (target === tmpPath) {
        rewritePaused.resolve();
        await allowRewrite.promise;
      }
      return originalWriteFile(target, data, options);
    });

    const rewritePromise = addChannelMember(channelPath, "bob");
    await rewritePaused.promise;

    const appendPromise = appendMessage(channelPath, "alice", "hello from lock test");

    allowRewrite.resolve();
    await Promise.all([rewritePromise, appendPromise]);

    const content = fs.readFileSync(channelPath, "utf-8");
    const { meta, messages } = parseChannel(content);
    expect(meta.members).toContain("alice");
    expect(meta.members).toContain("bob");
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe("hello from lock test");
  });

  it("preserves bookmark updates across concurrent read-modify-write operations", async () => {
    tmpDir = mktemp();
    const bookmarksPath = path.join(tmpDir, "channels.md");
    fs.writeFileSync(
      bookmarksPath,
      [
        "# 频道",
        "",
        "- ch_alpha (last: never)",
        "",
      ].join("\n"),
      "utf-8",
    );

    const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
    const writePaused = deferred();
    const allowWrite = deferred();
    const tmpPath = bookmarksPath + ".tmp";

    vi.spyOn(fs.promises, "writeFile").mockImplementation(async (target, data, options) => {
      if (target === tmpPath) {
        writePaused.resolve();
        await allowWrite.promise;
      }
      return originalWriteFile(target, data, options);
    });

    const updatePromise = updateBookmark(bookmarksPath, "ch_alpha", "2026-04-23 12:34:56");
    await writePaused.promise;

    const addPromise = addBookmarkEntry(bookmarksPath, "ch_beta");

    allowWrite.resolve();
    await Promise.all([updatePromise, addPromise]);

    const bookmarks = readBookmarks(bookmarksPath);
    expect(bookmarks.get("ch_alpha")).toBe("2026-04-23 12:34:56");
    expect(bookmarks.get("ch_beta")).toBe("never");
  });
});
