import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStageFilesTool } from "../lib/tools/output-file-tool.js";
import { loadLocale } from "../server/i18n.js";

describe("stage_files tool", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("describes the tool as the unified file delivery handoff", () => {
    loadLocale("en");
    const tool = createStageFilesTool({});

    expect(tool.description).toContain("hand one or more local files to the user");
    expect(tool.description).toContain("browser screenshot");
    expect(tool.description).toContain("Bridge/remote platforms");
    expect(tool.description).toContain("consumers choose the platform-specific delivery");
    expect(tool.parameters.properties.filepaths.description).toContain("StageFile");
  });

  it("registers staged files as session files while preserving legacy mediaUrls", async () => {
    loadLocale("en");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-stage-tool-"));
    const filePath = path.join(tmpDir, "out.txt");
    fs.writeFileSync(filePath, "ok");
    const sessionPath = "/sessions/s1.jsonl";
    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin }) => ({
      id: "sf_test1234567890",
      sessionPath,
      filePath,
      realPath: filePath,
      displayName: label,
      filename: path.basename(filePath),
      label,
      ext: "txt",
      mime: "text/plain",
      size: 2,
      kind: "document",
      origin,
      createdAt: 1,
    }));
    const tool = createStageFilesTool({ registerSessionFile });

    const result = await tool.execute("call-1", { filepaths: [filePath] }, null, null, {
      sessionManager: { getSessionFile: () => sessionPath },
    });

    expect(registerSessionFile).toHaveBeenCalledWith({
      sessionPath,
      filePath,
      label: "out.txt",
      origin: "stage_files",
    });
    expect(result.details.files).toEqual([expect.objectContaining({
      id: "sf_test1234567890",
      fileId: "sf_test1234567890",
      filePath,
      label: "out.txt",
      ext: "txt",
      mime: "text/plain",
      size: 2,
      kind: "document",
    })]);
    expect(result.details.media.items).toEqual([expect.objectContaining({
      type: "session_file",
      fileId: "sf_test1234567890",
      sessionPath,
      filePath,
      filename: "out.txt",
      mime: "text/plain",
      size: 2,
      kind: "document",
    })]);
    expect(result.details.media.mediaUrls).toEqual([filePath]);
  });
});
