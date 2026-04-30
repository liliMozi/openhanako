import { afterEach, describe, expect, it, vi } from "vitest";
import path from "path";
import { HanaEngine } from "../core/engine.js";
import { SettingsManager } from "../lib/pi-sdk/index.js";

describe("HanaEngine resource loader options", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses explicit Hana-owned Pi SDK cwd, agentDir, and in-memory Pi settings", () => {
    const settings = { kind: "in-memory-settings" };
    const inMemory = vi.spyOn(SettingsManager, "inMemory").mockReturnValue(settings);
    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = "/hanako-home";
    engine._agentMgr = {
      activeAgentId: "agent-a",
      agent: {
        agentDir: "/hanako-home/agents/agent-a",
        systemPrompt: "agent prompt",
      },
    };
    engine.getHomeCwd = vi.fn(() => "/workspace-a");

    const options = engine._createResourceLoaderOptions("/hanako-home/skills");

    expect(options).toMatchObject({
      cwd: path.join("/hanako-home", ".pi", "project"),
      agentDir: path.join("/hanako-home", ".pi", "agent"),
      settingsManager: settings,
      noContextFiles: true,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: ["/hanako-home/skills"],
    });
    expect(options.agentsFilesOverride()).toEqual({ agentsFiles: [] });
    expect(options.systemPromptOverride()).toBe("agent prompt");
    expect(options.appendSystemPromptOverride(["from-pi"])).toEqual([]);
    expect(engine.getHomeCwd).not.toHaveBeenCalled();
    expect(inMemory).toHaveBeenCalledTimes(1);
  });
});
