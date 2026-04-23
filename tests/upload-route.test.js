import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { countFiles, createUploadRoute } from "../server/routes/upload.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-upload-route-"));
}

describe("upload route", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      tmpDir = null;
    }
  });

  it("rejects a symlink root path", async () => {
    tmpDir = mktemp();
    const targetFile = path.join(tmpDir, "real.txt");
    const linkPath = path.join(tmpDir, "link.txt");
    fs.writeFileSync(targetFile, "hello", "utf-8");
    fs.symlinkSync(targetFile, linkPath);

    const app = new Hono();
    app.route("/api", createUploadRoute({ hanakoHome: path.join(tmpDir, "hana-home") }));

    const res = await app.request("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [linkPath] }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.uploads[0]).toMatchObject({
      src: linkPath,
      error: "symlink not allowed",
    });
  });

  it("rejects directories that contain symlinks", async () => {
    tmpDir = mktemp();
    const dirPath = path.join(tmpDir, "cycle");
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, "note.txt"), "hello", "utf-8");
    fs.symlinkSync(dirPath, path.join(dirPath, "loop"));

    const app = new Hono();
    app.route("/api", createUploadRoute({ hanakoHome: path.join(tmpDir, "hana-home") }));

    const res = await app.request("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [dirPath] }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.uploads[0]).toMatchObject({
      src: dirPath,
      error: "symlink not allowed",
    });
  });

  it("stops counting once the configured file limit is exceeded", async () => {
    tmpDir = mktemp();
    const dirPath = path.join(tmpDir, "many-files");
    fs.mkdirSync(dirPath, { recursive: true });
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(dirPath, `f-${i}.txt`), "x", "utf-8");
    }

    const count = await countFiles(dirPath, { limit: 9 });
    expect(count).toBe(10);
  });
});
