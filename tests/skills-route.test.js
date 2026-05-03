import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function expectAppEvent(emitEvent, type, payload) {
  expect(emitEvent).toHaveBeenCalledWith({
    type: "app_event",
    event: {
      type,
      payload,
      source: "server",
    },
  }, null);
}

describe("skills route", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-skills-route-"));

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
  });

  it("runtime=1 时返回包含 workspace skills 的运行时视图，默认仍是 agent 全局技能列表", async () => {
    const agentId = "hana";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Hana\n", "utf-8");

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();

    const getAllSkills = vi.fn(() => [{ name: "global-skill", enabled: true }]);
    const getRuntimeSkills = vi.fn(() => [
      { name: "global-skill", enabled: true },
      { name: "workspace-skill", enabled: true, managedBy: "workspace" },
    ]);

    const engine = {
      agentsDir: tempRoot,
      getAllSkills,
      getRuntimeSkills,
    };

    app.route("/api", createSkillsRoute(engine));

    const defaultRes = await app.request(`/api/skills?agentId=${agentId}`);
    expect(defaultRes.status).toBe(200);
    expect(await defaultRes.json()).toEqual({
      skills: [{ name: "global-skill", enabled: true }],
    });
    expect(getAllSkills).toHaveBeenCalledWith(agentId);
    expect(getRuntimeSkills).not.toHaveBeenCalled();

    const runtimeRes = await app.request(`/api/skills?agentId=${agentId}&runtime=1`);
    expect(runtimeRes.status).toBe(200);
    expect(await runtimeRes.json()).toEqual({
      skills: [
        { name: "global-skill", enabled: true },
        { name: "workspace-skill", enabled: true, managedBy: "workspace" },
      ],
    });
    expect(getRuntimeSkills).toHaveBeenCalledWith(agentId);
  });

  it("emits skills-changed after updating an agent's enabled skills", async () => {
    const agentId = "hana";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Hana\n", "utf-8");

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      getAllSkills: vi.fn(() => [
        { name: "writer" },
        { name: "reader" },
      ]),
      getAgent: vi.fn(() => ({ id: agentId })),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      emitEvent: vi.fn(),
    };

    app.route("/api", createSkillsRoute(engine));

    const res = await app.request(`/api/agents/${agentId}/skills`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: ["writer", "unknown"] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enabled: ["writer"] });
    expect(engine.updateConfig).toHaveBeenCalledWith({
      skills: { enabled: ["writer"] },
    }, { agentId });
    expectAppEvent(engine.emitEvent, "skills-changed", { agentId });
  });

  it("does not emit skills-changed when enabled skills validation fails", async () => {
    const agentId = "hana";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Hana\n", "utf-8");

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      getAllSkills: vi.fn(),
      updateConfig: vi.fn(),
      emitEvent: vi.fn(),
    };

    app.route("/api", createSkillsRoute(engine));

    const res = await app.request(`/api/agents/${agentId}/skills`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "writer" }),
    });

    expect(res.status).toBe(400);
    expect(engine.updateConfig).not.toHaveBeenCalled();
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });

  it("emits global skills-changed after reloading skills", async () => {
    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    const engine = {
      reloadSkills: vi.fn().mockResolvedValue(undefined),
      emitEvent: vi.fn(),
    };

    app.route("/api", createSkillsRoute(engine));

    const res = await app.request("/api/skills/reload", { method: "POST" });

    expect(res.status).toBe(200);
    expect(engine.reloadSkills).toHaveBeenCalledTimes(1);
    expectAppEvent(engine.emitEvent, "skills-changed", { agentId: null });
  });

  it("registers a session-scoped skill install source before installing", async () => {
    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    const srcDir = path.join(tempRoot, "incoming-skill");
    const userSkillsDir = path.join(tempRoot, "user-skills");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "SKILL.md"), "---\nname: sample-skill\n---\n# Sample\n", "utf-8");
    const sessionPath = "/sessions/install-source.jsonl";
    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
      id: "sf_skill_source",
      sessionPath,
      filePath,
      realPath: filePath,
      displayName: label,
      filename: path.basename(filePath),
      label,
      ext: "",
      mime: "inode/directory",
      size: null,
      kind: "directory",
      origin,
      storageKind,
      createdAt: 1,
    }));
    const engine = {
      userSkillsDir,
      agentsDir: tempRoot,
      registerSessionFile,
      reloadSkills: vi.fn().mockResolvedValue(undefined),
      emitEvent: vi.fn(),
      getAllSkills: vi.fn(() => []),
      currentAgentId: "",
    };

    app.route("/api", createSkillsRoute(engine));

    const res = await app.request("/api/skills/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: srcDir, sessionPath }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(registerSessionFile).toHaveBeenCalledWith({
      sessionPath,
      filePath: srcDir,
      label: "incoming-skill",
      origin: "skill_install_source",
      storageKind: "install_source",
    });
    expect(data).toMatchObject({
      ok: true,
      skill: { name: "sample-skill" },
      sourceFile: {
        id: "sf_skill_source",
        fileId: "sf_skill_source",
        sessionPath,
        filePath: srcDir,
        origin: "skill_install_source",
        storageKind: "install_source",
      },
    });
  });
});

describe("DELETE /skills/:name — per-agent target selection", () => {
  let tempRoot;
  let agentsDir;
  let skillsDir;

  /**
   * 构造一个带 skillsDir / agentsDir / 多 agent 的完整 engine mock。
   * 每个 agent 在 agentsDir/<id>/config.yaml 有实际的配置文件,便于验证 enabled 列表清理。
   */
  function buildEngine({ agents = [], currentAgentId = null } = {}) {
    const agentMap = new Map();
    for (const id of agents) {
      const agentDir = path.join(agentsDir, id);
      fs.mkdirSync(agentDir, { recursive: true });
      if (!fs.existsSync(path.join(agentDir, "config.yaml"))) {
        fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: " + id + "\n", "utf-8");
      }
      agentMap.set(id, { agentDir });
    }
    return {
      skillsDir,
      agentsDir,
      currentAgentId,
      getAgent: (id) => agentMap.get(id),
      // DELETE handler 只会用 getAllSkills 做 readonly 检查;返回空列表即可,
      // 这样即使不是 external 技能也不会被误判为 readonly
      getAllSkills: vi.fn(() => []),
      getRuntimeSkills: vi.fn(() => []),
      reloadSkills: vi.fn(async () => {}),
    };
  }

  function writeLearnedSkill(agentId, skillName) {
    const dir = path.join(agentsDir, agentId, "learned-skills", skillName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skillName}\n---\n`, "utf-8");
    return dir;
  }

  function writeUserSkill(skillName) {
    const dir = path.join(skillsDir, skillName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skillName}\n---\n`, "utf-8");
    return dir;
  }

  function writeAgentConfigWithEnabled(agentId, enabledSkills) {
    const configPath = path.join(agentsDir, agentId, "config.yaml");
    const body =
      `agent:\n  name: ${agentId}\nskills:\n  enabled:\n` +
      enabledSkills.map(n => `    - ${n}`).join("\n") + "\n";
    fs.writeFileSync(configPath, body, "utf-8");
  }

  async function readAgentEnabled(agentId) {
    // 跳过 config-loader 缓存以免 test 间污染
    const { loadConfig, clearConfigCache } = await import("../lib/memory/config-loader.js");
    clearConfigCache();
    const cfg = loadConfig(path.join(agentsDir, agentId, "config.yaml"));
    return cfg?.skills?.enabled || [];
  }

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-skills-delete-"));
    agentsDir = path.join(tempRoot, "agents");
    skillsDir = path.join(tempRoot, "skills");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("backward-compat: 无 agentId query 时仍走 resolveAgent fallback 删除用户级 skill", async () => {
    const engine = buildEngine({ agents: ["agent-a"], currentAgentId: "agent-a" });
    writeUserSkill("my-skill");

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    app.route("/api", createSkillsRoute(engine));

    const res = await app.request("/api/skills/my-skill", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fs.existsSync(path.join(skillsDir, "my-skill"))).toBe(false);
    expect(engine.reloadSkills).toHaveBeenCalled();
  });

  it("显式 agentId: learned skill 在指定 agent 的 learned-skills 目录被删除", async () => {
    const engine = buildEngine({
      agents: ["agent-a", "agent-b"],
      currentAgentId: "agent-a",
    });
    const learnedDir = writeLearnedSkill("agent-b", "test-skill");
    expect(fs.existsSync(learnedDir)).toBe(true);

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    app.route("/api", createSkillsRoute(engine));

    const res = await app.request("/api/skills/test-skill?agentId=agent-b", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fs.existsSync(learnedDir)).toBe(false);
  });

  it("核心回归 (#419): 同名 learned skill 在两个 agent 下时只删除指定 agent 的", async () => {
    const engine = buildEngine({
      agents: ["agent-a", "agent-b"],
      currentAgentId: "agent-a", // 焦点在 a, 但要删 b
    });
    const dirA = writeLearnedSkill("agent-a", "dup-skill");
    const dirB = writeLearnedSkill("agent-b", "dup-skill");
    expect(fs.existsSync(dirA)).toBe(true);
    expect(fs.existsSync(dirB)).toBe(true);

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    app.route("/api", createSkillsRoute(engine));

    const res = await app.request("/api/skills/dup-skill?agentId=agent-b", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // agent-b 的被删; agent-a 的必须完好无损 — 这是 #419 级别的回归
    expect(fs.existsSync(dirB)).toBe(false);
    expect(fs.existsSync(dirA)).toBe(true);
    expect(fs.existsSync(path.join(dirA, "SKILL.md"))).toBe(true);
  });

  it("显式 agentId: 用户级 skill 被删除,且所有 agent 的 enabled 列表都被清理", async () => {
    const engine = buildEngine({
      agents: ["agent-a", "agent-b"],
      currentAgentId: "agent-a",
    });
    writeUserSkill("globalskill");
    writeAgentConfigWithEnabled("agent-a", ["globalskill", "other"]);
    writeAgentConfigWithEnabled("agent-b", ["globalskill", "other"]);

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    app.route("/api", createSkillsRoute(engine));

    const res = await app.request("/api/skills/globalskill?agentId=agent-b", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(fs.existsSync(path.join(skillsDir, "globalskill"))).toBe(false);

    const enabledA = await readAgentEnabled("agent-a");
    const enabledB = await readAgentEnabled("agent-b");
    expect(enabledA).not.toContain("globalskill");
    expect(enabledB).not.toContain("globalskill");
    expect(enabledA).toContain("other");
    expect(enabledB).toContain("other");
  });

  it("显式 agentId 不存在时返回 404 agent not found", async () => {
    const engine = buildEngine({ agents: ["agent-a"], currentAgentId: "agent-a" });
    writeUserSkill("my-skill");

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();
    app.route("/api", createSkillsRoute(engine));

    const res = await app.request("/api/skills/my-skill?agentId=nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "agent not found" });
    // 文件必须保持原样
    expect(fs.existsSync(path.join(skillsDir, "my-skill"))).toBe(true);
  });
});
