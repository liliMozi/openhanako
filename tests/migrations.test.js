/**
 * core/migrations.js 单元测试
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { runMigrations } from "../core/migrations.js";

// ── 测试工具 ────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-migrations-"));
}

/** 最小化 PreferencesManager stub */
function makePrefs(userDir) {
  const p = path.join(userDir, "preferences.json");
  fs.mkdirSync(userDir, { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, "{}", "utf-8");
  return {
    getPreferences() { return JSON.parse(fs.readFileSync(p, "utf-8")); },
    savePreferences(data) {
      fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
    },
  };
}

/** 最小化 ProviderRegistry stub — 只需 get() 返回是否存在 */
function makeRegistry(existingProviders) {
  const set = new Set(existingProviders);
  return { get(id) { return set.has(id) ? { id } : null; } };
}

function writeAgentConfig(agentsDir, agentId, config) {
  const dir = path.join(agentsDir, agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.yaml"),
    YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }),
    "utf-8",
  );
}

function readAgentConfig(agentsDir, agentId) {
  return YAML.load(fs.readFileSync(path.join(agentsDir, agentId, "config.yaml"), "utf-8"));
}

function writeSessionJsonl(filePath, messages) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = messages.map((message, index) => JSON.stringify({
    type: "message",
    id: `m-${index + 1}`,
    timestamp: "2026-04-15T00:00:00.000Z",
    message,
  }));
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

function readSessionJsonl(filePath) {
  return fs.readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ── runner 行为 ──────────────────────────────────────────────────────────────

describe("runMigrations runner", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("首次运行：_dataVersion 从 0 升到最新", () => {
    const prefs = makePrefs(userDir);
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    expect(prefs.getPreferences()._dataVersion).toBeGreaterThan(0);
  });

  it("已迁移过：不重复执行", () => {
    const prefs = makePrefs(userDir);
    // 设置一个很大的 _dataVersion，所有迁移都应跳过
    prefs.savePreferences({ _dataVersion: 9999 });

    writeAgentConfig(agentsDir, "hana", { api: { provider: "ghost-provider" } });

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    // config 不应被修改（ghost-provider 应原样保留）
    const config = readAgentConfig(agentsDir, "hana");
    expect(config.api.provider).toBe("ghost-provider");
  });
});

// ── 迁移 #1：清理悬空 provider 引用 ─────────────────────────────────────────

describe("migration #1: cleanDanglingProviderRefs", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("清空指向不存在 provider 的 api.provider", () => {
    writeAgentConfig(agentsDir, "hana", {
      api: { provider: "dead-provider" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.api.provider).toBe("");
  });

  it("保留指向存在 provider 的引用", () => {
    writeAgentConfig(agentsDir, "hana", {
      api: { provider: "openai" },
      models: { chat: "openai/gpt-4o" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.api.provider).toBe("openai");
    expect(config.models.chat).toBe("openai/gpt-4o");
  });

  it("清空 models.chat 中 provider/model 格式的悬空引用", () => {
    writeAgentConfig(agentsDir, "hana", {
      models: { chat: "minimax-token_plan/minimax-large", utility: "openai/gpt-4o-mini" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.models.chat).toBe("");
    expect(config.models.utility).toBe("openai/gpt-4o-mini");
  });

  it("清空 models.chat 中 {id, provider} 对象格式的悬空引用", () => {
    writeAgentConfig(agentsDir, "hana", {
      models: { chat: { id: "some-model", provider: "dead-provider" } },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.models.chat).toBe("");
  });

  it("清空 embedding_api.provider 的悬空引用", () => {
    writeAgentConfig(agentsDir, "hana", {
      embedding_api: { provider: "dead" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.embedding_api.provider).toBe("");
  });

  it("清空 preferences 中悬空的共享模型引用", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      utility_large_model: { id: "some-model", provider: "dead" },
      utility_api_provider: "also-dead",
    });
    fs.mkdirSync(agentsDir, { recursive: true });

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const p = prefs.getPreferences();
    expect(p.utility_large_model).toBeNull();
    expect(p.utility_api_provider).toBeNull();
  });

  it("preferences 中字符串格式的悬空共享模型也被清空", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      summarizer_model: "dead-provider/fast-model",
    });
    fs.mkdirSync(agentsDir, { recursive: true });

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const p = prefs.getPreferences();
    expect(p.summarizer_model).toBeNull();
  });

  it("多个 agent 同时修复", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "dead" } });
    writeAgentConfig(agentsDir, "butter", { api: { provider: "openai" } });
    writeAgentConfig(agentsDir, "xiaohua", {
      api: { provider: "dead" },
      models: { chat: "dead/model" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    expect(readAgentConfig(agentsDir, "hana").api.provider).toBe("");
    expect(readAgentConfig(agentsDir, "butter").api.provider).toBe("openai");
    expect(readAgentConfig(agentsDir, "xiaohua").api.provider).toBe("");
    expect(readAgentConfig(agentsDir, "xiaohua").models.chat).toBe("");
  });
});

// ── 迁移 #2：bridge 配置从全局 prefs 迁移到 per-agent config.yaml ──────────

describe("migration #2: migrateBridgeToPerAgent", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  /** 跳过 migration #1 直接测 #2：把 _dataVersion 设为 1 */
  function runMigration2(prefs) {
    const p = prefs.getPreferences();
    p._dataVersion = 1;
    prefs.savePreferences(p);

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
  }

  it("基本迁移：单 agent，telegram + owner → config.yaml bridge 区块", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      bridge: {
        telegram: { token: "tok123", webhook: true },
        owner: { telegram: "user-001" },
        readOnly: false,
      },
    });

    runMigration2(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.bridge.telegram.token).toBe("tok123");
    expect(config.bridge.telegram.webhook).toBe(true);
    expect(config.bridge.telegram.owner).toBe("user-001");

    // prefs.bridge should be deleted
    const p = prefs.getPreferences();
    expect(p.bridge).toBeUndefined();
  });

  it("多 agent 分组：telegram→agent-a，feishu→agent-b", () => {
    writeAgentConfig(agentsDir, "agent-a", { api: { provider: "" } });
    writeAgentConfig(agentsDir, "agent-b", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "agent-a",
      bridge: {
        telegram: { token: "tg-tok", agentId: "agent-a" },
        feishu: { appId: "fs-app", agentId: "agent-b" },
        owner: {},
        readOnly: false,
      },
    });

    runMigration2(prefs);

    const cfgA = readAgentConfig(agentsDir, "agent-a");
    const cfgB = readAgentConfig(agentsDir, "agent-b");

    expect(cfgA.bridge.telegram.token).toBe("tg-tok");
    expect(cfgA.bridge.telegram.agentId).toBeUndefined(); // agentId stripped
    expect(cfgA.bridge.feishu).toBeUndefined();

    expect(cfgB.bridge.feishu.appId).toBe("fs-app");
    expect(cfgB.bridge.feishu.agentId).toBeUndefined();
    expect(cfgB.bridge.telegram).toBeUndefined();
  });

  it("legacy owner key：owner.telegram（无 composite）→ 归入 primary agent", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      bridge: {
        telegram: { token: "tok" },
        owner: { telegram: "legacy-owner" },
      },
    });

    runMigration2(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.bridge.telegram.owner).toBe("legacy-owner");
  });

  it("composite owner key：owner['telegram:agent-a'] → 归入 agent-a", () => {
    writeAgentConfig(agentsDir, "agent-a", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "agent-a",
      bridge: {
        telegram: { token: "tok", agentId: "agent-a" },
        owner: {
          telegram: "legacy-owner",
          "telegram:agent-a": "composite-owner",
        },
      },
    });

    runMigration2(prefs);

    const config = readAgentConfig(agentsDir, "agent-a");
    // composite key takes priority over legacy key
    expect(config.bridge.telegram.owner).toBe("composite-owner");
  });

  it("无 bridge 配置 → no-op", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ primaryAgent: "hana" });

    runMigration2(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.bridge).toBeUndefined();

    const p = prefs.getPreferences();
    expect(p.bridge).toBeUndefined();
  });

  it("agentId 指向已删除 agent → 回退到 primaryAgent", () => {
    // agent-a does NOT exist, only hana exists
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      bridge: {
        telegram: { token: "tok", agentId: "deleted-agent" },
        owner: {},
      },
    });

    runMigration2(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.bridge.telegram.token).toBe("tok");
    expect(config.bridge.telegram.agentId).toBeUndefined();
  });

  it("readOnly 只写入 primaryAgent", () => {
    writeAgentConfig(agentsDir, "primary", { api: { provider: "" } });
    writeAgentConfig(agentsDir, "secondary", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "primary",
      bridge: {
        telegram: { token: "tg", agentId: "primary" },
        feishu: { appId: "fs", agentId: "secondary" },
        owner: {},
        readOnly: true,
      },
    });

    runMigration2(prefs);

    const cfgPrimary = readAgentConfig(agentsDir, "primary");
    const cfgSecondary = readAgentConfig(agentsDir, "secondary");

    expect(cfgPrimary.bridge.readOnly).toBe(true);
    expect(cfgSecondary.bridge.readOnly).toBeUndefined();
  });
});

// ── 迁移 #3：workspace (home_folder) 从全局 prefs 迁移到 per-agent config ───

describe("migration #3 — migrateWorkspaceToPerAgent", () => {
  let tmpDir, userDir, agentsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = path.join(tmpDir, "user");
    agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runMigration3(prefs) {
    const p = prefs.getPreferences();
    p._dataVersion = 2;
    prefs.savePreferences(p);
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
  }

  it("migrates home_folder to primary agent config.yaml", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/Users/test/Desktop",
      _dataVersion: 2,
    });

    runMigration3(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.desk.home_folder).toBe("/Users/test/Desktop");

    const p = prefs.getPreferences();
    expect(p.home_folder).toBeUndefined();
    expect(p._dataVersion).toBe(4);
  });

  it("skips when home_folder is empty", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ primaryAgent: "hana", _dataVersion: 2 });

    runMigration3(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.desk).toBeUndefined();
    expect(prefs.getPreferences()._dataVersion).toBe(4);
  });

  it("falls back to first agent when primaryAgent not found", () => {
    writeAgentConfig(agentsDir, "alpha", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "deleted-agent",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    runMigration3(prefs);

    const config = readAgentConfig(agentsDir, "alpha");
    expect(config.desk.home_folder).toBe("/workspace");
    expect(prefs.getPreferences().home_folder).toBeUndefined();
  });

  it("does not write home_folder to non-primary agents, but disables their heartbeat", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    writeAgentConfig(agentsDir, "assistant", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    runMigration3(prefs);

    const hanaConfig = readAgentConfig(agentsDir, "hana");
    const assistantConfig = readAgentConfig(agentsDir, "assistant");
    expect(hanaConfig.desk.home_folder).toBe("/workspace");
    expect(assistantConfig.desk.home_folder).toBeUndefined();
    expect(assistantConfig.desk.heartbeat_enabled).toBe(false);
  });

  it("preserves data when no agent config.yaml exists (version stays at 2)", () => {
    fs.mkdirSync(path.join(agentsDir, "hana"), { recursive: true });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    // migration #3 throws internally; runner catches it and breaks without bumping version
    runMigration3(prefs);

    const p = prefs.getPreferences();
    expect(p.home_folder).toBe("/workspace");
    expect(p._dataVersion).toBe(2);
  });

  it("is idempotent — rerun after success is a no-op", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    runMigration3(prefs);
    expect(prefs.getPreferences()._dataVersion).toBe(4);

    // Manually reset _dataVersion to 2 to simulate forced rerun
    const p2 = prefs.getPreferences();
    p2._dataVersion = 2;
    prefs.savePreferences(p2);
    runMigration3(prefs);

    // home_folder is gone from prefs, so migration skips cleanly
    expect(prefs.getPreferences()._dataVersion).toBe(4);
    const config = readAgentConfig(agentsDir, "hana");
    expect(config.desk.home_folder).toBe("/workspace");
  });

  it("preserves existing desk fields when merging home_folder", () => {
    writeAgentConfig(agentsDir, "hana", {
      api: { provider: "" },
      desk: { heartbeat_enabled: false, heartbeat_interval: 30 },
    });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    runMigration3(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.desk.home_folder).toBe("/workspace");
    expect(config.desk.heartbeat_enabled).toBe(false);
    expect(config.desk.heartbeat_interval).toBe(30);
  });

  it("disables heartbeat for non-primary agents", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    writeAgentConfig(agentsDir, "assistant", { api: { provider: "" } });
    writeAgentConfig(agentsDir, "research", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    runMigration3(prefs);

    // Primary agent keeps heartbeat on (default)
    const hanaConfig = readAgentConfig(agentsDir, "hana");
    expect(hanaConfig.desk.heartbeat_enabled).toBeUndefined();

    // Non-primary agents get heartbeat disabled
    const assistantConfig = readAgentConfig(agentsDir, "assistant");
    expect(assistantConfig.desk.heartbeat_enabled).toBe(false);

    const researchConfig = readAgentConfig(agentsDir, "research");
    expect(researchConfig.desk.heartbeat_enabled).toBe(false);
  });

  it("respects existing heartbeat_enabled on non-primary agents", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    writeAgentConfig(agentsDir, "assistant", {
      api: { provider: "" },
      desk: { heartbeat_enabled: true },
    });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    runMigration3(prefs);

    // User explicitly set heartbeat_enabled=true → migration respects it
    const assistantConfig = readAgentConfig(agentsDir, "assistant");
    expect(assistantConfig.desk.heartbeat_enabled).toBe(true);
  });
});

describe("migration #4 — migrateSubagentExecutorMetadata", () => {
  let tmpDir, userDir, agentsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = path.join(tmpDir, "user");
    agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runMigration4(prefs) {
    const p = prefs.getPreferences();
    p._dataVersion = 3;
    prefs.savePreferences(p);
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
  }

  it("migrates explicit delegated executor metadata into parent session history and child sidecar", () => {
    writeAgentConfig(agentsDir, "hanako", { agent: { name: "Hanako" }, api: { provider: "" } });
    writeAgentConfig(agentsDir, "butter", { agent: { name: "butter" }, api: { provider: "" } });
    const prefs = makePrefs(userDir);
    const parentSessionPath = path.join(agentsDir, "hanako", "sessions", "parent.jsonl");
    const childSessionPath = path.join(agentsDir, "hanako", "subagent-sessions", "child.jsonl");

    writeSessionJsonl(parentSessionPath, [
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "delegate to butter",
          agentId: "butter",
          agentName: "butter",
          sessionPath: childSessionPath,
          streamStatus: "done",
        },
      },
    ]);
    fs.mkdirSync(path.dirname(childSessionPath), { recursive: true });
    fs.writeFileSync(childSessionPath, "", "utf-8");

    runMigration4(prefs);

    const entries = readSessionJsonl(parentSessionPath);
    const details = entries[1].message.details;
    expect(details.executorAgentId).toBe("butter");
    expect(details.executorAgentNameSnapshot).toBe("butter");
    expect(details.executorMetaVersion).toBe(1);

    const sidecar = JSON.parse(fs.readFileSync(path.join(path.dirname(childSessionPath), "session-meta.json"), "utf-8"));
    expect(sidecar["child.jsonl"]).toMatchObject({
      executorAgentId: "butter",
      executorAgentNameSnapshot: "butter",
      executorMetaVersion: 1,
    });
  });

  it("backfills legacy self-dispatch records from the owning agent directory when executor metadata is missing", () => {
    writeAgentConfig(agentsDir, "hanako", { agent: { name: "Hanako" }, api: { provider: "" } });
    const prefs = makePrefs(userDir);
    const parentSessionPath = path.join(agentsDir, "hanako", "sessions", "parent.jsonl");
    const childSessionPath = path.join(agentsDir, "hanako", "subagent-sessions", "child.jsonl");

    writeSessionJsonl(parentSessionPath, [
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "self-dispatch legacy task",
          sessionPath: childSessionPath,
          streamStatus: "done",
        },
      },
    ]);
    fs.mkdirSync(path.dirname(childSessionPath), { recursive: true });
    fs.writeFileSync(childSessionPath, "", "utf-8");

    runMigration4(prefs);

    const entries = readSessionJsonl(parentSessionPath);
    const details = entries[1].message.details;
    expect(details.executorAgentId).toBe("hanako");
    expect(details.executorAgentNameSnapshot).toBe("Hanako");
    expect(details.agentId).toBe("hanako");
    expect(details.agentName).toBe("Hanako");

    const sidecar = JSON.parse(fs.readFileSync(path.join(path.dirname(childSessionPath), "session-meta.json"), "utf-8"));
    expect(sidecar["child.jsonl"]).toMatchObject({
      executorAgentId: "hanako",
      executorAgentNameSnapshot: "Hanako",
      executorMetaVersion: 1,
    });
  });
});
