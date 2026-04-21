import { describe, expect, it, beforeEach } from "vitest";
import { SkillManager } from "../core/skill-manager.js";

describe("SkillManager.computeDefaultEnabledForNewAgent", () => {
  let sm;

  beforeEach(() => {
    sm = new SkillManager({ skillsDir: "/tmp/hana-test-skills" });
  });

  it("includes user source skills", () => {
    sm._allSkills = [
      { name: "pdf", source: "user" },
      { name: "docx", source: "user" },
    ];
    expect(sm.computeDefaultEnabledForNewAgent()).toEqual(["pdf", "docx"]);
  });

  it("excludes learned source skills", () => {
    sm._allSkills = [
      { name: "pdf", source: "user" },
      { name: "my-learned", source: "learned", _agentId: "agent-a" },
    ];
    expect(sm.computeDefaultEnabledForNewAgent()).toEqual(["pdf"]);
  });

  it("excludes external source skills (covers plugin and workspace sub-categories)", () => {
    sm._allSkills = [
      { name: "pdf", source: "user" },
      { name: "ext-plain", source: "external" },
      { name: "plugin-skill", source: "external", _pluginSkill: true },
      { name: "workspace-skill", source: "external", _workspaceSkill: true },
    ];
    expect(sm.computeDefaultEnabledForNewAgent()).toEqual(["pdf"]);
  });

  it("returns empty array when _allSkills is empty", () => {
    sm._allSkills = [];
    expect(sm.computeDefaultEnabledForNewAgent()).toEqual([]);
  });

  it("preserves skill order from _allSkills", () => {
    sm._allSkills = [
      { name: "a", source: "user" },
      { name: "b", source: "learned", _agentId: "x" },
      { name: "c", source: "user" },
    ];
    expect(sm.computeDefaultEnabledForNewAgent()).toEqual(["a", "c"]);
  });
});
