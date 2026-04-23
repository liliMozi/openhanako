/**
 * update-settings-tool.js 注册表单元测试
 *
 * 覆盖：apply 签名、toggle boolean 转换、agent null guard
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadLocale } from "../server/i18n.js";

// ── Mock 工厂 ──

function makeMockPrefs(initial = {}) {
  const store = { ...initial };
  return {
    getPreferences: () => ({ ...store }),
    getSandbox: () => store.sandbox !== false,
    setSandbox(v) { store.sandbox = typeof v === "string" ? v === "true" : !!v; },
    getLocale: () => store.locale || "",
    setLocale(v) { store.locale = v; },
    getTimezone: () => store.timezone || "",
    setTimezone(v) { store.timezone = v; },
    getThinkingLevel: () => store.thinking_level || "auto",
    setThinkingLevel(v) { store.thinking_level = v; },
    getFileBackup: () => store.file_backup || { enabled: false, retention_days: 1, max_file_size_kb: 1024 },
    setFileBackup(v) { store.file_backup = { ...(store.file_backup || {}), ...v }; },
    _store: store,
  };
}

function makeMockEngine(overrides = {}) {
  const prefs = makeMockPrefs(overrides.prefsData || {});
  const focusAgentId = overrides.currentAgentId || "focus";
  return {
    preferences: prefs,
    _prefs: prefs,
    currentAgentId: focusAgentId,
    agent: overrides.agent !== undefined ? overrides.agent : {
      id: overrides.agentId || "agent-test",
      memoryMasterEnabled: true,
      agentName: "TestAgent",
      userName: "TestUser",
      config: { models: { chat: "qwen-plus" } },
      updateConfig: vi.fn(),
    },
    availableModels: overrides.availableModels || [],
    getAgent: vi.fn((agentId) => {
      if (overrides.getAgent) return overrides.getAgent(agentId);
      if (agentId === focusAgentId) return { id: focusAgentId };
      return null;
    }),
    getHomeFolder: vi.fn(() => overrides.homeFolder || "/home/test"),
    setHomeFolder: vi.fn(),
    setSandbox: vi.fn(function (v) { prefs.setSandbox(v); }),
    setFileBackup: vi.fn(function (v) { prefs.setFileBackup(v); }),
    setLocale: vi.fn(function (v) { prefs.setLocale(v); }),
    setTimezone: vi.fn(function (v) { prefs.setTimezone(v); }),
    setThinkingLevel: vi.fn(function (v) { prefs.setThinkingLevel(v); }),
    setDefaultModel: vi.fn(),
    currentSessionPath: "/sessions/test",
    emitSessionEvent: vi.fn(),
  };
}

function makeMockConfirmStore(action = "confirmed", value = undefined) {
  return {
    create: vi.fn(() => ({
      confirmId: "test-confirm-id",
      promise: Promise.resolve({ action, value }),
    })),
  };
}

function makeDeferredConfirmStore() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return {
    store: {
      create: vi.fn(() => ({
        confirmId: "test-confirm-id",
        promise,
      })),
    },
    resolve(result) {
      resolve(result);
    },
  };
}

describe("update-settings-tool", () => {
  let createUpdateSettingsTool;

  beforeEach(async () => {
    loadLocale("en");
    const mod = await import("../lib/tools/update-settings-tool.js");
    createUpdateSettingsTool = mod.createUpdateSettingsTool;
  });

  function buildTool(engineOpts = {}, confirmAction = "confirmed") {
    const engine = makeMockEngine(engineOpts);
    const confirmStore = makeMockConfirmStore(confirmAction);
    const tool = createUpdateSettingsTool({
      getEngine: () => engine,
      getAgent: () => engine.agent,
      getConfirmStore: () => confirmStore,
      getSessionPath: () => "/sessions/test",
      emitEvent: vi.fn(),
    });
    return { tool, engine, confirmStore };
  }

  describe("sandbox toggle — this 绑定 + boolean 转换", () => {
    it("apply sandbox=false 实际关闭沙盒", async () => {
      const { tool, engine } = buildTool({ prefsData: { sandbox: true } });
      await tool.execute("c1", { action: "apply", key: "sandbox", value: "false" });

      expect(engine.setSandbox).toHaveBeenCalled();
      // 传入的是 boolean false（调度侧 toggle parse）
      expect(engine.setSandbox.mock.calls[0][0]).toBe(false);
      // preferences 存的也是 boolean false
      expect(engine._prefs._store.sandbox).toBe(false);
    });

    it("apply sandbox=true 存入 boolean true", async () => {
      const { tool, engine } = buildTool({ prefsData: { sandbox: false } });
      await tool.execute("c2", { action: "apply", key: "sandbox", value: "true" });

      expect(engine.setSandbox.mock.calls[0][0]).toBe(true);
      expect(engine._prefs._store.sandbox).toBe(true);
    });
  });

  describe("file_backup toggle", () => {
    it("enables file backup", async () => {
      const { tool, engine } = buildTool({ prefsData: {} });
      await tool.execute("c3", { action: "apply", key: "file_backup", value: "true" });

      expect(engine.setFileBackup).toHaveBeenCalled();
      expect(engine.setFileBackup.mock.calls[0][0]).toEqual({ enabled: true });
    });
  });

  describe("locale — 非 toggle 类型不受 parse 影响", () => {
    it("apply locale=en 传入字符串", async () => {
      const { tool, engine } = buildTool({ prefsData: { locale: "zh-CN" } });
      await tool.execute("c3", { action: "apply", key: "locale", value: "en" });

      expect(engine.setLocale).toHaveBeenCalledWith("en");
    });
  });

  describe("models.chat — 复合键写路径", () => {
    it("apply models.chat 使用 provider/id 调 engine.setDefaultModel", async () => {
      const { tool, engine } = buildTool({
        agentId: "owner",
        getAgent: (agentId) => (agentId === "owner" ? { id: "owner" } : null),
        availableModels: [
          { id: "gpt-4o", provider: "openai", name: "GPT-4o" },
        ],
      });

      await tool.execute("c-model", { action: "apply", key: "models.chat", value: "openai/gpt-4o" });

      expect(engine.setDefaultModel).toHaveBeenCalledWith("gpt-4o", "openai", { agentId: "owner" });
      expect(engine.agent.updateConfig).not.toHaveBeenCalled();
    });

    it("确认期间切焦点后，models.chat 仍写回工具所属 agent", async () => {
      const deferred = makeDeferredConfirmStore();
      const ownerAgent = {
        id: "owner",
        memoryMasterEnabled: true,
        agentName: "Owner",
        userName: "User",
        config: { models: { chat: "openai/gpt-4o" } },
        updateConfig: vi.fn(),
      };
      const engine = makeMockEngine({
        agent: ownerAgent,
        currentAgentId: "focus",
        getAgent: (agentId) => (agentId === "owner" ? ownerAgent : { id: agentId }),
        availableModels: [{ id: "gpt-4o", provider: "openai", name: "GPT-4o" }],
      });
      const tool = createUpdateSettingsTool({
        getEngine: () => engine,
        getAgent: () => ownerAgent,
        getConfirmStore: () => deferred.store,
        getSessionPath: () => "/sessions/test",
        emitEvent: vi.fn(),
      });

      const run = tool.execute("c-model-switch", { action: "apply", key: "models.chat", value: "openai/gpt-4o" });
      engine.currentAgentId = "other";
      deferred.resolve({ action: "confirmed" });
      await run;

      expect(engine.setDefaultModel).toHaveBeenCalledWith("gpt-4o", "openai", { agentId: "owner" });
    });
  });

  describe("agent-scoped routing", () => {
    it("home_folder apply 使用工具所属 agent，而不是当前 focus agent", async () => {
      const deferred = makeDeferredConfirmStore();
      const ownerAgent = {
        id: "owner",
        memoryMasterEnabled: true,
        agentName: "Owner",
        userName: "User",
        config: { models: { chat: "openai/gpt-4o" } },
        updateConfig: vi.fn(),
      };
      const engine = makeMockEngine({
        agent: ownerAgent,
        currentAgentId: "focus",
        getAgent: (agentId) => (agentId === "owner" ? ownerAgent : { id: agentId }),
      });
      const tool = createUpdateSettingsTool({
        getEngine: () => engine,
        getAgent: () => ownerAgent,
        getConfirmStore: () => deferred.store,
        getSessionPath: () => "/sessions/test",
        emitEvent: vi.fn(),
      });

      const run = tool.execute("c-home-folder", { action: "apply", key: "home_folder", value: "/tmp/owner-home" });
      engine.currentAgentId = "other";
      deferred.resolve({ action: "confirmed" });
      await run;

      expect(engine.setHomeFolder).toHaveBeenCalledWith("owner", "/tmp/owner-home");
    });

    it("home_folder 在 agent=null 时返回错误", async () => {
      const { tool } = buildTool({ agent: null });
      const result = await tool.execute("c-home-null", { action: "apply", key: "home_folder", value: "/tmp/x" });
      const text = result.content[0].text;
      expect(text).not.toContain("已将");
    });
  });

  describe("agent-scoped null guard", () => {
    it("get memory.enabled 在 agent=null 时不返回 true", async () => {
      const { tool } = buildTool({ agent: null });
      const result = await tool.execute("c4", { action: "search", query: "memory" });
      const text = result.content[0].text;
      expect(text).not.toContain("→ true");
      expect(text).toContain("N/A");
    });

    it("apply memory.enabled 在 agent=null 时返回错误", async () => {
      const { tool } = buildTool({ agent: null });
      const result = await tool.execute("c5", { action: "apply", key: "memory.enabled", value: "true" });
      const text = result.content[0].text;
      expect(text).not.toContain("已将");
    });

    it("get agent.name 在 agent=null 时返回 N/A", async () => {
      const { tool } = buildTool({ agent: null });
      const result = await tool.execute("c6", { action: "search", query: "agent.name" });
      const text = result.content[0].text;
      expect(text).toContain("N/A");
    });
  });

  describe("theme options 包含 claude-design（此前遗漏，本次补齐）", () => {
    it("search 'theme' 结果中 options 包含 claude-design", async () => {
      const { tool } = buildTool();
      const result = await tool.execute("c9", { action: "search", query: "theme" });
      const text = result.content[0].text;
      expect(text).toContain("claude-design");
    });

    it("search 'theme' 结果中 options 包含全部 10 个选项（9 主题 + auto）", async () => {
      const { tool } = buildTool();
      const result = await tool.execute("c10", { action: "search", query: "theme" });
      const text = result.content[0].text;
      // 验证原有 8 个主题 + 新增 claude-design + auto 均存在
      for (const id of ["warm-paper", "midnight", "high-contrast", "grass-aroma", "contemplation", "absolutely", "delve", "deep-think", "claude-design", "auto"]) {
        expect(text).toContain(id);
      }
    });
  });

  describe("confirmation rejected/aborted", () => {
    it("rejected 返回取消消息", async () => {
      const { tool } = buildTool({}, "rejected");
      const result = await tool.execute("c7", { action: "apply", key: "locale", value: "en" });
      const text = result.content[0].text;
      expect(text).not.toContain("已将");
    });

    it("aborted（session 关闭）不返回成功消息", async () => {
      const { tool } = buildTool({}, "aborted");
      const result = await tool.execute("c8", { action: "apply", key: "locale", value: "en" });
      const text = result.content[0].text;
      expect(text).not.toContain("已将");
    });
  });
});
