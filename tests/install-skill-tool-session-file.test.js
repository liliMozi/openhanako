import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstallSkillTool, reviewDeclaredBins } from "../lib/tools/install-skill.js";

describe("install_skill session file ownership", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    vi.unstubAllGlobals();
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

  it("installs a GitHub monorepo subdirectory URL from the requested branch", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-install-skill-tool-"));
    const agentDir = path.join(tmpDir, "agent");
    const userSkillsDir = path.join(tmpDir, "user-skills");
    fs.mkdirSync(agentDir, { recursive: true });
    const skillContent = "---\nname: demo-skill\nbins: [curl]\n---\n# Demo\n";
    const fetchMock = vi.fn(async (url) => {
      if (url === "https://api.github.com/repos/openclaw/skills") {
        return { ok: true, json: async () => ({ stargazers_count: 100 }) };
      }
      if (url === "https://raw.githubusercontent.com/openclaw/skills/main/skills/demo/demo-skill/SKILL.md") {
        return { ok: true, text: async () => skillContent };
      }
      return { ok: false, status: 404, text: async () => "" };
    });
    vi.stubGlobal("fetch", fetchMock);

    const onInstalled = vi.fn();
    const tool = createInstallSkillTool({
      agentDir,
      getUserSkillsDir: () => userSkillsDir,
      getConfig: () => ({
        capabilities: {
          learn_skills: {
            enabled: true,
            allow_github_fetch: true,
            safety_review: false,
            min_stars: 25,
          },
        },
      }),
      resolveUtilityConfig: () => null,
      onInstalled,
      registerSessionFile: null,
    });

    const result = await tool.execute("call-1", {
      github_url: "https://github.com/openclaw/skills/tree/main/skills/demo/demo-skill",
      reason: "test",
      user_requested: true,
    }, null, null, {});

    const skillFilePath = path.join(userSkillsDir, "demo-skill", "SKILL.md");
    expect(fs.readFileSync(skillFilePath, "utf-8")).toBe(skillContent);
    expect(onInstalled).toHaveBeenCalledWith("demo-skill");
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain(
      "https://raw.githubusercontent.com/openclaw/skills/main/skills/demo/demo-skill/SKILL.md",
    );
    expect(result.details).toMatchObject({
      skillName: "demo-skill",
      source: "github",
      stars: 100,
      skillFilePath,
    });
  });

  it("keeps low-risk bins transparent and reports high-risk bins explicitly", () => {
    expect(reviewDeclaredBins("---\nname: net-helper\nbins: [curl, git]\n---\n# Net helper\n"))
      .toMatchObject({ safe: true, lowRiskBins: ["curl", "git"], unknownBins: [] });

    expect(reviewDeclaredBins("---\nname: destructive\nbins:\n  - rm\n---\n# Bad\n"))
      .toMatchObject({ safe: false, reason: expect.stringContaining("bins: rm") });
  });
});
