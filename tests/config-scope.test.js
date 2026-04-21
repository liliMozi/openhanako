/**
 * config-scope.js + migrate-config-scope.js 单元测试
 *
 * 测试：splitByScope、injectGlobalFields、migrateConfigScope
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { splitByScope, injectGlobalFields } from "../shared/config-scope.js";
import { migrateConfigScope } from "../shared/migrate-config-scope.js";

// ---------------------------------------------------------------------------
// splitByScope
// ---------------------------------------------------------------------------

describe("splitByScope", () => {
  it("extracts top-level global fields (locale, sandbox) while keeping agent fields (models)", () => {
    const partial = { locale: "zh-CN", sandbox: false, models: ["gpt-4"] };
    const { global: g, agent } = splitByScope(partial);

    expect(g).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "locale", value: "zh-CN" }),
      expect.objectContaining({ key: "sandbox", value: false }),
    ]));
    expect(agent.models).toEqual(["gpt-4"]);
    expect(agent.locale).toBeUndefined();
    expect(agent.sandbox).toBeUndefined();
  });

  it("extracts nested global fields (capabilities.learn_skills) while keeping sibling nested fields", () => {
    const partial = {
      capabilities: { learn_skills: true, other_cap: "keep" },
    };
    const { global: g, agent } = splitByScope(partial);

    expect(g).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "capabilities.learn_skills", value: true }),
    ]));
    expect(agent.capabilities).toBeDefined();
    expect(agent.capabilities.other_cap).toBe("keep");
    expect(agent.capabilities.learn_skills).toBeUndefined();
  });

  it("removes empty parent after extracting the only nested global child", () => {
    const partial = { capabilities: { learn_skills: false } };
    const { global: g, agent } = splitByScope(partial);

    expect(g).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "capabilities.learn_skills", value: false }),
    ]));
    expect(agent.capabilities).toBeUndefined();
  });

  it("desk.home_folder is agent-scoped, heartbeat_interval also agent-scoped", () => {
    const partial = {
      desk: { home_folder: "/home/user", heartbeat_interval: 30 },
    };
    const { global: g, agent } = splitByScope(partial);

    // home_folder is now agent scope — NOT extracted as global
    expect(g).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "desk.home_folder" }),
    ]));
    expect(agent.desk.home_folder).toBe("/home/user");
    expect(agent.desk.heartbeat_interval).toBe(30);
  });

  it("extracts desk.heartbeat_master as global", () => {
    const partial = {
      desk: { heartbeat_master: false, heartbeat_interval: 20 },
    };
    const { global: g, agent } = splitByScope(partial);

    expect(g).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "desk.heartbeat_master", value: false }),
    ]));
    expect(agent.desk.heartbeat_interval).toBe(20);
    expect(agent.desk.heartbeat_master).toBeUndefined();
  });

  it("returns empty global array when no global fields present", () => {
    const partial = { models: ["qwen-plus"], name: "Alice" };
    const { global: g, agent } = splitByScope(partial);

    expect(g).toHaveLength(0);
    expect(agent.models).toEqual(["qwen-plus"]);
    expect(agent.name).toBe("Alice");
  });

  it("returns empty agent when only global fields present", () => {
    const partial = { locale: "en", sandbox: true, update_channel: "beta" };
    const { global: g, agent } = splitByScope(partial);

    expect(g.length).toBeGreaterThan(0);
    expect(Object.keys(agent)).toHaveLength(0);
  });

  it("handles empty partial", () => {
    const { global: g, agent } = splitByScope({});

    expect(g).toHaveLength(0);
    expect(agent).toEqual({});
  });

  it("does not mutate original partial nested objects", () => {
    const caps = { learn_skills: true, other: "x" };
    const partial = { capabilities: caps };
    splitByScope(partial);

    // The original nested object must remain untouched
    expect(caps.learn_skills).toBe(true);
    expect(caps.other).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// injectGlobalFields
// ---------------------------------------------------------------------------

describe("injectGlobalFields", () => {
  it("injects all global fields from engine getters", () => {
    const engine = {
      getLocale: () => "ja",
      getTimezone: () => "Asia/Tokyo",
      getSandbox: () => false,
      getUpdateChannel: () => "beta",
      getThinkingLevel: () => "high",
      getLearnSkills: () => true,
      getHeartbeatMaster: () => true,
    };
    const config = {};
    injectGlobalFields(config, engine);

    expect(config.locale).toBe("ja");
    expect(config.timezone).toBe("Asia/Tokyo");
    expect(config.sandbox).toBe(false);
    expect(config.update_channel).toBe("beta");
    expect(config.thinking_level).toBe("high");
    expect(config.capabilities?.learn_skills).toBe(true);
    expect(config.desk?.heartbeat_master).toBe(true);
  });

  it("skips getters that don't exist on engine (doesn't throw)", () => {
    // Engine only implements a subset of getters
    const engine = {
      getLocale: () => "en",
    };
    const config = {};
    expect(() => injectGlobalFields(config, engine)).not.toThrow();
    expect(config.locale).toBe("en");
    // Fields whose getters are absent should not appear
    expect(config.sandbox).toBeUndefined();
  });

  it("creates nested parent (capabilities, desk) if not present", () => {
    const engine = {
      getLearnSkills: () => false,
      getHeartbeatMaster: () => false,
    };
    const config = {};
    injectGlobalFields(config, engine);

    expect(config.capabilities).toBeDefined();
    expect(config.capabilities.learn_skills).toBe(false);
    expect(config.desk).toBeDefined();
    expect(config.desk.heartbeat_master).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// migrateConfigScope — helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-migrate-test-"));
}

function writeAgentConfig(agentsDir, agentId, cfgObj) {
  const dir = path.join(agentsDir, agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), YAML.dump(cfgObj, { lineWidth: -1 }), "utf-8");
}

function makeMockPrefs(initial = {}) {
  let store = { ...initial };
  return {
    getPreferences: () => store,
    savePreferences: (p) => { store = { ...p }; },
    _getStore: () => store,
  };
}

// ---------------------------------------------------------------------------
// migrateConfigScope
// ---------------------------------------------------------------------------

describe("migrateConfigScope", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("migrates global fields from agent config to preferences", () => {
    const agentsDir = path.join(tmpDir, "agents");
    writeAgentConfig(agentsDir, "agent-1", { locale: "zh-CN", sandbox: false, name: "Alice" });

    const prefs = makeMockPrefs({});
    migrateConfigScope({ agentsDir, prefs, primaryAgentId: "agent-1" });

    const store = prefs._getStore();
    expect(store.locale).toBe("zh-CN");
    expect(store.sandbox).toBe(false);
    // agent scope field must NOT be migrated to prefs
    expect(store.name).toBeUndefined();
    // migration marker
    expect(store._configScopeMigrated).toBe(true);
  });

  it("does not overwrite existing non-default preferences (stable is the default so agent beta wins)", () => {
    const agentsDir = path.join(tmpDir, "agents");
    // Agent wants "beta"
    writeAgentConfig(agentsDir, "agent-1", { update_channel: "beta" });

    // Preferences already has the default "stable" — agent value should win
    const prefs = makeMockPrefs({ update_channel: "stable" });
    migrateConfigScope({ agentsDir, prefs, primaryAgentId: "agent-1" });

    const store = prefs._getStore();
    expect(store.update_channel).toBe("beta");

    // Now run with a genuinely non-default prefs value
    const agentsDir2 = path.join(tmpDir, "agents2");
    writeAgentConfig(agentsDir2, "agent-2", { update_channel: "beta" });
    const prefs2 = makeMockPrefs({ update_channel: "nightly" });
    migrateConfigScope({ agentsDir: agentsDir2, prefs: prefs2, primaryAgentId: "agent-2" });

    const store2 = prefs2._getStore();
    // prefs had "nightly" (non-default) — must NOT be overwritten by agent "beta"
    expect(store2.update_channel).toBe("nightly");
  });

  it("prefers primary agent value in multi-agent conflict", () => {
    const agentsDir = path.join(tmpDir, "agents");
    writeAgentConfig(agentsDir, "primary", { locale: "ja" });
    writeAgentConfig(agentsDir, "secondary", { locale: "ko" });

    const prefs = makeMockPrefs({});
    migrateConfigScope({ agentsDir, prefs, primaryAgentId: "primary" });

    expect(prefs._getStore().locale).toBe("ja");
  });

  it("is idempotent — second run is a no-op", () => {
    const agentsDir = path.join(tmpDir, "agents");
    writeAgentConfig(agentsDir, "agent-1", { locale: "zh-CN" });

    const prefs = makeMockPrefs({});
    migrateConfigScope({ agentsDir, prefs, primaryAgentId: "agent-1" });

    // Manually change prefs between runs to verify second run doesn't override
    const store = prefs._getStore();
    store.locale = "en";
    prefs.savePreferences(store);

    migrateConfigScope({ agentsDir, prefs, primaryAgentId: "agent-1" });

    // Second run must be skipped entirely — locale stays "en"
    expect(prefs._getStore().locale).toBe("en");
  });

  it("creates backup file before modifying config", () => {
    const agentsDir = path.join(tmpDir, "agents");
    writeAgentConfig(agentsDir, "agent-1", { locale: "zh-CN", name: "Alice" });

    const prefs = makeMockPrefs({});
    migrateConfigScope({ agentsDir, prefs, primaryAgentId: "agent-1" });

    const backupPath = path.join(agentsDir, "agent-1", "config.yaml.pre-scope-migration");
    expect(fs.existsSync(backupPath)).toBe(true);

    const backup = YAML.load(fs.readFileSync(backupPath, "utf-8"));
    expect(backup.locale).toBe("zh-CN");
  });

  it("handles nested global fields (capabilities.learn_skills)", () => {
    const agentsDir = path.join(tmpDir, "agents");
    writeAgentConfig(agentsDir, "agent-1", {
      capabilities: { learn_skills: true, other: "keep" },
      name: "Alice",
    });

    const prefs = makeMockPrefs({});
    migrateConfigScope({ agentsDir, prefs, primaryAgentId: "agent-1" });

    const store = prefs._getStore();
    expect(store.capabilities?.learn_skills).toBe(true);

    // The cleaned config.yaml should have other cap but not learn_skills
    const cfg = YAML.load(
      fs.readFileSync(path.join(agentsDir, "agent-1", "config.yaml"), "utf-8")
    );
    expect(cfg.capabilities?.learn_skills).toBeUndefined();
    expect(cfg.capabilities?.other).toBe("keep");
    // agent-scoped field must still be in config.yaml
    expect(cfg.name).toBe("Alice");
  });
});
