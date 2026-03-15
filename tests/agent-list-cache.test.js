import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "js-yaml";
import { AgentManager } from "../core/agent-manager.js";

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../lib/desk/activity-store.js", () => ({
  ActivityStore: vi.fn(),
}));

describe("AgentManager.listAgents 缓存", () => {
  let tempDir;
  let agentsDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-test-"));
    agentsDir = path.join(tempDir, "agents");
    fs.mkdirSync(agentsDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createTestAgent(id, name) {
    const dir = path.join(agentsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.yaml"),
      YAML.dump({ agent: { name, yuan: "hanako" } }),
    );
    fs.writeFileSync(path.join(dir, "identity.md"), `# ${name}\n这是 ${name} 的身份`);
  }

  function makeMgr() {
    return new AgentManager({
      agentsDir,
      productDir: tempDir,
      userDir: tempDir,
      channelsDir: tempDir,
      getPrefs: () => ({
        getPrimaryAgent: () => null,
        getPreferences: () => ({}),
      }),
      getModels: () => ({}),
      getHub: () => null,
      getSkills: () => ({}),
      getSearchConfig: () => ({}),
      resolveUtilityConfig: () => ({}),
      getSharedModels: () => ({}),
      getChannelManager: () => ({ setupChannelsForNewAgent: vi.fn(), cleanupAgentFromChannels: vi.fn() }),
      getSessionCoordinator: () => ({}),
    });
  }

  it("listAgents 在 TTL 内使用缓存", () => {
    createTestAgent("alice", "Alice");
    const mgr = makeMgr();

    const first = mgr.listAgents();
    expect(first).toHaveLength(1);
    expect(first[0].name).toBe("Alice");

    // 在 TTL 内新建一个 agent 目录（不经过 createAgent，直接写磁盘模拟外部变更）
    createTestAgent("bob", "Bob");

    // 应该还是缓存结果
    const second = mgr.listAgents();
    expect(second).toHaveLength(1); // 还是 1，缓存未过期
  });

  it("invalidateAgentListCache 后立即反映变更", () => {
    createTestAgent("alice", "Alice");
    const mgr = makeMgr();

    const first = mgr.listAgents();
    expect(first).toHaveLength(1);

    // 修改 config（模拟 PUT /api/agents/:id/config）
    fs.writeFileSync(
      path.join(agentsDir, "alice", "config.yaml"),
      YAML.dump({ agent: { name: "AliceV2", yuan: "butter" } }),
    );

    // 不清缓存 → 看不到更新
    const stale = mgr.listAgents();
    expect(stale[0].name).toBe("Alice");

    // 清缓存后 → 立即看到
    mgr.invalidateAgentListCache();
    const fresh = mgr.listAgents();
    expect(fresh[0].name).toBe("AliceV2");
  });

  it("编辑 identity.md 后清缓存能反映", () => {
    createTestAgent("alice", "Alice");
    const mgr = makeMgr();

    const first = mgr.listAgents();
    expect(first[0].identity).toContain("Alice");

    // 修改 identity（模拟 PUT /api/agents/:id/identity）
    fs.writeFileSync(
      path.join(agentsDir, "alice", "identity.md"),
      "# Alice\n全新的身份描述",
    );

    mgr.invalidateAgentListCache();
    const fresh = mgr.listAgents();
    expect(fresh[0].identity).toBe("全新的身份描述");
  });
});
