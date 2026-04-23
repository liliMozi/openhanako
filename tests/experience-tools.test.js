import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExperienceTools,
  listExperienceDocuments,
  recordEntry,
  rebuildIndex,
} from "../lib/tools/experience.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-experience-"));
}

describe("experience tools", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      tmpDir = null;
    }
  });

  it("recordEntry rejects path-like categories", () => {
    tmpDir = mktemp();
    const experienceDir = path.join(tmpDir, "experience");
    const indexPath = path.join(tmpDir, "experience.md");

    expect(() => recordEntry(experienceDir, indexPath, "../identity", "bad")).toThrow("invalid experience category");
    expect(fs.existsSync(path.join(tmpDir, "identity.md"))).toBe(false);
  });

  it("stores display title separately from the storage filename", async () => {
    tmpDir = mktemp();
    const tools = createExperienceTools(tmpDir);
    const recordTool = tools.find((tool) => tool.name === "record_experience");
    const recallTool = tools.find((tool) => tool.name === "recall_experience");

    const recordResult = await recordTool.execute("call-1", {
      category: "Design Notes",
      content: "Remember to preserve owner session identity.",
    });

    expect(recordResult.details).toEqual({
      category: "Design Notes",
      content: "Remember to preserve owner session identity.",
    });

    const docs = listExperienceDocuments(path.join(tmpDir, "experience"));
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe("Design Notes");
    expect(docs[0].file).not.toBe("Design Notes.md");

    rebuildIndex(path.join(tmpDir, "experience"), path.join(tmpDir, "experience.md"));
    const indexText = fs.readFileSync(path.join(tmpDir, "experience.md"), "utf-8");
    expect(indexText).toContain("# Design Notes");

    const recallResult = await recallTool.execute("call-2", { category: "Design Notes" });
    expect(recallResult.content[0].text).toContain("# Design Notes");
    expect(recallResult.content[0].text).toContain("1. Remember to preserve owner session identity.");
  });
});
