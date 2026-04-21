import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { CheckpointStore } from "../lib/checkpoint-store.js";

describe("CheckpointStore", () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-test-"));
    store = new CheckpointStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("save stores file content and list returns metadata", async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-src-"));
    const srcFile = path.join(srcDir, "hello.js");
    fs.writeFileSync(srcFile, "const x = 1;\n");

    const id = await store.save({
      sessionPath: "agents/hana/sessions/test",
      tool: "write",
      filePath: srcFile,
      maxSizeKb: 1024,
    });

    expect(id).toBeTruthy();
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
    expect(list[0].tool).toBe("write");
    expect(list[0].path).toBe(srcFile);
    expect(list[0].size).toBeGreaterThan(0);
    expect(list[0].ts).toBeGreaterThan(0);

    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  it("save returns null if file does not exist", async () => {
    const id = await store.save({
      sessionPath: null,
      tool: "write",
      filePath: "/nonexistent/path.js",
      maxSizeKb: 1024,
    });
    expect(id).toBeNull();
  });

  it("save returns null if file exceeds maxSizeKb", async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-big-"));
    const bigFile = path.join(srcDir, "big.bin");
    fs.writeFileSync(bigFile, Buffer.alloc(2048));

    const id = await store.save({
      sessionPath: null,
      tool: "write",
      filePath: bigFile,
      maxSizeKb: 1,
    });
    expect(id).toBeNull();

    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  it("save skips known binary extensions", async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-bin-"));
    const pngFile = path.join(srcDir, "image.png");
    fs.writeFileSync(pngFile, "fake png");

    const id = await store.save({
      sessionPath: null,
      tool: "write",
      filePath: pngFile,
      maxSizeKb: 1024,
    });
    expect(id).toBeNull();

    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  it("restore writes content back to original path", async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-restore-"));
    const srcFile = path.join(srcDir, "sub", "file.js");
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    fs.writeFileSync(srcFile, "original content");

    const id = await store.save({
      sessionPath: null,
      tool: "edit",
      filePath: srcFile,
      maxSizeKb: 1024,
    });

    fs.writeFileSync(srcFile, "modified content");

    const result = await store.restore(id);
    expect(result.restoredTo).toBe(srcFile);
    expect(fs.readFileSync(srcFile, "utf-8")).toBe("original content");

    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  it("restore recreates directory if deleted", async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-redir-"));
    const srcFile = path.join(srcDir, "deep", "nested", "file.js");
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    fs.writeFileSync(srcFile, "nested content");

    const id = await store.save({
      sessionPath: null,
      tool: "write",
      filePath: srcFile,
      maxSizeKb: 1024,
    });

    fs.rmSync(srcDir, { recursive: true, force: true });

    const result = await store.restore(id);
    expect(fs.readFileSync(srcFile, "utf-8")).toBe("nested content");
  });

  it("remove deletes a checkpoint", async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-rm-"));
    const srcFile = path.join(srcDir, "f.js");
    fs.writeFileSync(srcFile, "x");

    const id = await store.save({
      sessionPath: null,
      tool: "write",
      filePath: srcFile,
      maxSizeKb: 1024,
    });

    expect(await store.list()).toHaveLength(1);
    await store.remove(id);
    expect(await store.list()).toHaveLength(0);

    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  it("cleanup removes entries older than retention", async () => {
    fs.mkdirSync(dir, { recursive: true });
    const oldTs = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const oldFile = path.join(dir, `${oldTs}_aaaa.json`);
    fs.writeFileSync(oldFile, JSON.stringify({
      ts: oldTs, sessionPath: null, tool: "write",
      path: "/tmp/old.js", content: "old", size: 3,
    }));

    const srcDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-cl-"));
    const srcFile2 = path.join(srcDir2, "new.js");
    fs.writeFileSync(srcFile2, "new");
    await store.save({ sessionPath: null, tool: "write", filePath: srcFile2, maxSizeKb: 1024 });

    expect(await store.list()).toHaveLength(2);
    await store.cleanup(1);
    const remaining = await store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].path).toBe(srcFile2);

    fs.rmSync(srcDir2, { recursive: true, force: true });
  });
});
