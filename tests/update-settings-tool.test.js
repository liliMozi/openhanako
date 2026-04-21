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
  return {
    preferences: prefs,
    _prefs: prefs,
    agent: overrides.agent !== undefined ? overrides.agent : {
      memoryMasterEnabled: true,
      agentName: "TestAgent",
      userName: "TestUser",
      config: { models: { chat: "qwen-plus" } },
      updateConfig: vi.fn(),
    },
    availableModels: overrides.availableModels || [],
    getHomeFolder: () => overrides.homeFolder || "/home/test",
    setHomeFolder: vi.fn(),
    setSandbox: vi.fn(function (v) { prefs.setSandbox(v); }),
    setFileBackup: vi.fn(function (v) { prefs.setFileBackup(v); }),
    setLocale: vi.fn(function (v) { prefs.setLocale(v); }),
    setTimezone: vi.fn(function (v) { prefs.setTimezone(v); }),
    setThinkingLevel: vi.fn(function (v) { prefs.setThinkingLevel(v); }),
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
