import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstallSkillTool } from "../lib/tools/install-skill.js";

describe("install_skill session file ownership", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("registers the installed SKILL.md as a session file", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-install-skill-tool-"));
    const agentDir = path.join(tmpDir, "agent");
    const userSkillsDir = path.join(tmpDir, "user-skills");
    fs.mkdirSync(agentDir, { recursive: true });
    const sessionPath = "/sessions/install-tool.jsonl";
    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
      id: "sf_installed_skill",
      sessionPath,
      filePath,
      realPath: filePath,
      displayName: label,
      filename: label,
      label,
      ext: "md",
      mime: "text/markdown",
      size: 32,
      kind: "markdown",
      origin,
      storageKind,
      createdAt: 1,
    }));
    const tool = createInstallSkillTool({
      agentDir,
      getUserSkillsDir: () => userSkillsDir,
      getConfig: () => ({
        capabilities: {
          learn_skills: {
            enabled: true,
            safety_review: false,
          },
        },
      }),
      resolveUtilityConfig: () => null,
      onInstalled: vi.fn(),
      registerSessionFile,
    });

    const result = await tool.execute("call-1", {
      skill_name: "demo-skill",
      skill_content: "---\nname: demo-skill\n---\n# Demo\n",
      reason: "test",
    }, null, null, {
      sessionManager: { getSessionFile: () => sessionPath },
    });

    const skillFilePath = path.join(agentDir, "learned-skills", "demo-skill", "SKILL.md");
    expect(registerSessionFile).toHaveBeenCalledWith({
      sessionPath,
      filePath: skillFilePath,
      label: "SKILL.md",
      origin: "install_skill_output",
      storageKind: "install_output",
    });
    expect(result.details).toMatchObject({
      skillName: "demo-skill",
      skillFilePath,
      installedFile: {
        id: "sf_installed_skill",
        fileId: "sf_installed_skill",
        sessionPath,
        filePath: skillFilePath,
        origin: "install_skill_output",
        storageKind: "install_output",
      },
    });
  });
});
