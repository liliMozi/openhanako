import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createArtifactTool } from "../lib/tools/artifact-tool.js";

describe("create_artifact session file ownership", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("persists agent-created artifacts in the session file cache and registers them", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-artifact-tool-"));
    const sessionPath = path.join(tmpDir, "agents", "hana", "sessions", "main.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "", "utf-8");

    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
      id: "sf_artifact",
      sessionPath,
      filePath,
      realPath: filePath,
      displayName: label,
      filename: path.basename(filePath),
      label,
      ext: "md",
      mime: "text/markdown",
      size: 11,
      kind: "markdown",
      origin,
      storageKind,
      createdAt: 1,
      status: "available",
      missingAt: null,
    }));
    const tool = createArtifactTool({
      getHanakoHome: () => tmpDir,
      registerSessionFile,
    });

    const result = await tool.execute("call-1", {
      type: "markdown",
      title: "Weekly Plan",
      content: "# Plan\n- ship",
    }, null, null, {
      sessionManager: { getSessionFile: () => sessionPath },
    });

    expect(registerSessionFile).toHaveBeenCalledTimes(1);
    expect(registerSessionFile.mock.calls[0][0]).toMatchObject({
      sessionPath,
      label: "Weekly Plan.md",
      origin: "agent_artifact",
      storageKind: "managed_cache",
    });
    const artifactPath = registerSessionFile.mock.calls[0][0].filePath;
    expect(artifactPath).toContain(path.join(tmpDir, "session-files"));
    expect(fs.readFileSync(artifactPath, "utf-8")).toBe("# Plan\n- ship");
    expect(result.details).toMatchObject({
      artifactId: expect.stringMatching(/^art-/),
      type: "markdown",
      title: "Weekly Plan",
      content: "# Plan\n- ship",
      fileId: "sf_artifact",
      filePath: artifactPath,
      origin: "agent_artifact",
      storageKind: "managed_cache",
      status: "available",
      artifactFile: {
        id: "sf_artifact",
        fileId: "sf_artifact",
        filePath: artifactPath,
        origin: "agent_artifact",
        storageKind: "managed_cache",
      },
    });
  });

  it("keeps legacy in-memory artifacts when there is no active session", async () => {
    const registerSessionFile = vi.fn();
    const tool = createArtifactTool({
      getHanakoHome: () => "/tmp/hana",
      registerSessionFile,
    });

    const result = await tool.execute("call-1", {
      type: "code",
      title: "Snippet",
      content: "console.log(1)",
      language: "javascript",
    });

    expect(registerSessionFile).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      type: "code",
      title: "Snippet",
      content: "console.log(1)",
      language: "javascript",
    });
    expect(result.details.filePath).toBeUndefined();
  });
});
