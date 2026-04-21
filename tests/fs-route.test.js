import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createFsRoute } from "../server/routes/fs.js";

describe("fs route", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-fs-route-"));

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
  });

  function buildApp({ hanakoHome, workspace }) {
    const app = new Hono();
    const engine = {
      hanakoHome,
      currentAgentId: "hana",
      getAgent(id) {
        if (id !== "hana") return null;
        return {
          deskManager: { homePath: workspace },
        };
      },
    };
    app.route("/api", createFsRoute(engine));
    return app;
  }

  it("rejects symlink escapes from an allowed workspace", async () => {
    const hanakoHome = path.join(tempRoot, "hanako");
    const workspace = path.join(tempRoot, "workspace");
    const outsideDir = path.join(tempRoot, "outside");
    fs.mkdirSync(path.join(hanakoHome, "user"), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const outsideFile = path.join(outsideDir, "secret.txt");
    const linkedFile = path.join(workspace, "secret-link.txt");
    fs.writeFileSync(outsideFile, "top secret", "utf-8");
    fs.symlinkSync(outsideFile, linkedFile);

    const app = buildApp({ hanakoHome, workspace });
    const res = await app.request(`/api/fs/read?path=${encodeURIComponent(linkedFile)}`);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "path not allowed" });
  });

  it("keeps missing files inside the workspace as 404 instead of 403", async () => {
    const hanakoHome = path.join(tempRoot, "hanako");
    const workspace = path.join(tempRoot, "workspace");
    fs.mkdirSync(path.join(hanakoHome, "user"), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });

    const missingFile = path.join(workspace, "missing.txt");
    const app = buildApp({ hanakoHome, workspace });
    const res = await app.request(`/api/fs/read?path=${encodeURIComponent(missingFile)}`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "file not found" });
  });
});
