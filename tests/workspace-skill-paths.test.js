import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { resolveWorkspaceSkillPaths, WORKSPACE_SKILL_DIRS } from "../shared/workspace-skill-paths.js";

describe("workspace skill path discovery", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not auto-discover project .pi/skills", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hana-workspace-skills-"));
    roots.push(workspace);
    fs.mkdirSync(path.join(workspace, ".pi", "skills"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".agents", "skills"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".claude", "skills"), { recursive: true });

    const paths = resolveWorkspaceSkillPaths(workspace).map((entry) => path.relative(workspace, entry.dirPath));

    expect(paths).toContain(path.join(".agents", "skills"));
    expect(paths).toContain(path.join(".claude", "skills"));
    expect(paths).not.toContain(path.join(".pi", "skills"));
  });

  it("keeps workspace skill source list free of .pi project paths", () => {
    expect(WORKSPACE_SKILL_DIRS.map((entry) => entry.sub)).not.toContain(".pi/skills");
  });
});
