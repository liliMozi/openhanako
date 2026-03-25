/**
 * 模型选择无 fallback 测试
 *
 * 验证所有模型选择路径在找不到指定模型时抛错，而非静默 fallback。
 */

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Pi SDK ──

const { createAgentSessionMock, sessionManagerCreateMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: createAgentSessionMock,
  SessionManager: {
    create: sessionManagerCreateMock,
    open: vi.fn(),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionCoordinator } from "../core/session-coordinator.js";

// ── Helpers ──

function makeModels(list = []) {
  return {
    authStorage: {},
    modelRegistry: {},
    defaultModel: list[0] || null,
    availableModels: list,
    resolveExecutionModel: (m) => m,
    resolveThinkingLevel: () => "medium",
    inferModelProvider: () => null,
  };
}

function makeCoordinator(tempDir, { agentConfig = {}, models = makeModels() } = {}) {
  sessionManagerCreateMock.mockReturnValue({ getCwd: () => tempDir });
  createAgentSessionMock.mockResolvedValue({
    session: {
      sessionManager: { getSessionFile: () => path.join(tempDir, "s.jsonl") },
      subscribe: vi.fn(() => vi.fn()),
      abort: vi.fn(),
    },
  });

  return new SessionCoordinator({
    agentsDir: tempDir,
    getAgent: () => ({
      agentDir: tempDir,
      sessionDir: tempDir,
      agentName: "test-agent",
      config: agentConfig,
      tools: [],
    }),
    getActiveAgentId: () => "test",
    getModels: () => models,
    getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
    getSkills: () => ({ getSkillsForAgent: () => [] }),
    buildTools: () => ({ tools: [], customTools: [] }),
    emitEvent: () => {},
    getHomeCwd: () => tempDir,
    agentIdFromSessionPath: () => null,
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    getAgents: () => new Map(),
    getActivityStore: () => null,
    getAgentById: (id) => ({
      agentDir: tempDir,
      sessionDir: tempDir,
      agentName: id,
      config: agentConfig,
      tools: [],
    }),
    listAgents: () => [],
  });
}

// ── Tests ──

describe("模型选择无 fallback", () => {
  let tempDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-model-nofallback-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ────── resolveModel (createSessionContext) ──────

  describe("resolveModel", () => {
    it("找到指定模型时正常返回", () => {
      const models = makeModels([
        { id: "qwen3.5-plus", provider: "dashscope" },
        { id: "gpt-5", provider: "openai" },
      ]);
      const coord = makeCoordinator(tempDir, {
        agentConfig: { models: { chat: "qwen3.5-plus" } },
        models,
      });
      const ctx = coord.createSessionContext();
      const result = ctx.resolveModel({ models: { chat: "qwen3.5-plus" } });
      expect(result).toEqual({ id: "qwen3.5-plus", provider: "dashscope" });
    });

    it("models.chat 未配置、有 defaultModel 时回退到默认模型", () => {
      const coord = makeCoordinator(tempDir, {
        agentConfig: {},
        models: makeModels([{ id: "some-model", provider: "x" }]),
      });
      const ctx = coord.createSessionContext();
      expect(ctx.resolveModel({})).toEqual({ id: "some-model", provider: "x" });
      expect(ctx.resolveModel({ models: {} })).toEqual({ id: "some-model", provider: "x" });
    });

    it("models.chat 未配置、无 defaultModel 时抛错", () => {
      const coord = makeCoordinator(tempDir, {
        agentConfig: {},
        models: makeModels([]),
      });
      const ctx = coord.createSessionContext();
      expect(() => ctx.resolveModel({})).toThrow("error.resolveModelNoChatModel");
    });

    it("指定的模型不在 availableModels 中、有 defaultModel 时回退", () => {
      const models = makeModels([
        { id: "gpt-5", provider: "openai" },
        { id: "MiniMax-M2", provider: "minimax" },
      ]);
      const coord = makeCoordinator(tempDir, { models });
      const ctx = coord.createSessionContext();
      // 有 defaultModel，回退而非抛错
      expect(ctx.resolveModel({ models: { chat: "qwen3.5-plus" } }))
        .toEqual({ id: "gpt-5", provider: "openai" });
    });

    it("指定的模型不在 availableModels 中、无 defaultModel 时抛错", () => {
      const models = { ...makeModels([]), defaultModel: null };
      const coord = makeCoordinator(tempDir, { models });
      const ctx = coord.createSessionContext();
      expect(() => ctx.resolveModel({ models: { chat: "qwen3.5-plus" } }))
        .toThrow('error.resolveModelNotAvailable');
    });

    it("availableModels 为空时抛错", () => {
      const coord = makeCoordinator(tempDir, { models: makeModels([]) });
      const ctx = coord.createSessionContext();
      expect(() => ctx.resolveModel({ models: { chat: "qwen3.5-plus" } }))
        .toThrow('error.resolveModelNotAvailable');
    });
  });

  // ────── executeIsolated ──────

  describe("executeIsolated", () => {
    it("agent 未配置 models.chat、无 defaultModel 时抛错", async () => {
      const coord = makeCoordinator(tempDir, {
        agentConfig: {},
        models: makeModels([]),
      });
      const result = await coord.executeIsolated("hello");
      expect(result.error).toContain("error.executeIsolatedNoModel");
    });

    it("配置的模型不在可用列表中、无 defaultModel 时抛错", async () => {
      const coord = makeCoordinator(tempDir, {
        agentConfig: { models: { chat: "nonexistent-model" } },
        models: { ...makeModels([]), defaultModel: null },
      });
      const result = await coord.executeIsolated("hello");
      expect(result.error).toContain("error.executeIsolatedNoModel");
    });

    it("模型匹配成功时正常执行", async () => {
      const coord = makeCoordinator(tempDir, {
        agentConfig: { models: { chat: "qwen3.5-plus" } },
        models: makeModels([{ id: "qwen3.5-plus", provider: "dashscope" }]),
      });

      createAgentSessionMock.mockResolvedValue({
        session: {
          sessionManager: { getSessionFile: () => path.join(tempDir, "s.jsonl") },
          subscribe: vi.fn(() => vi.fn()),
          prompt: vi.fn(),
        },
      });

      const result = await coord.executeIsolated("hello");
      expect(result.error).toBeFalsy();
      expect(createAgentSessionMock).toHaveBeenCalledOnce();
      expect(createAgentSessionMock.mock.calls[0][0].model).toEqual({
        id: "qwen3.5-plus",
        provider: "dashscope",
      });
    });

    it("通过 opts.model 显式传入模型时跳过 config 查找", async () => {
      const explicitModel = { id: "explicit", provider: "test" };
      const coord = makeCoordinator(tempDir, {
        agentConfig: {},  // 没有 models.chat
        models: makeModels([explicitModel]),
      });

      createAgentSessionMock.mockResolvedValue({
        session: {
          sessionManager: { getSessionFile: () => path.join(tempDir, "s.jsonl") },
          subscribe: vi.fn(() => vi.fn()),
          prompt: vi.fn(),
        },
      });

      const result = await coord.executeIsolated("hello", { model: explicitModel });
      expect(result.error).toBeFalsy();
    });
  });

  // ────── resolveUtilityConfig ──────

  describe("resolveUtilityConfig", () => {
    // 直接测试 ModelManager 的 resolveUtilityConfig 方法（委托 ExecutionRouter）
    let ModelManager, ExecutionRouter;

    beforeEach(async () => {
      const mod = await import("../core/model-manager.js");
      ModelManager = mod.ModelManager;
      const routerMod = await import("../core/execution-router.js");
      ExecutionRouter = routerMod.ExecutionRouter;
    });

    /** 给 ModelManager 注入 executionRouter（跳过 init） */
    function setupRouter(mm) {
      mm.executionRouter = new ExecutionRouter(
        (ref) => mm._availableModels.find((m) => m.id === ref),
        { get: (provider) => {
          // 从 _availableModels 的 provider 对应的凭证中查找
          const model = mm._availableModels.find((m) => m.provider === provider);
          if (!model?._cred) return null;
          return model._cred;
        } },
      );
    }

    it("utility 未配置时抛错", () => {
      const mm = new ModelManager({ hanakoHome: tempDir });
      setupRouter(mm);
      expect(() => mm.resolveUtilityConfig({}, {}, {}))
        .toThrow("error.noUtilityModel");
    });

    it("utility_large 未配置时抛错", () => {
      const mm = new ModelManager({ hanakoHome: tempDir });
      setupRouter(mm);
      mm._availableModels = [{ id: "some-model", provider: "x" }];
      expect(() => mm.resolveUtilityConfig({}, { utility: "some-model" }, {}))
        .toThrow("error.noUtilityLargeModel");
    });

    it("utility 和 utility_large 都配置时正常返回", () => {
      const mm = new ModelManager({ hanakoHome: tempDir });
      mm._availableModels = [
        { id: "util-model", provider: "test-provider", _cred: { api: "openai-completions", apiKey: "sk-test", baseUrl: "https://test.example.com/v1" } },
        { id: "large-model", provider: "test-provider", _cred: { api: "openai-completions", apiKey: "sk-test", baseUrl: "https://test.example.com/v1" } },
      ];
      setupRouter(mm);
      const result = mm.resolveUtilityConfig(
        {},
        { utility: "util-model", utility_large: "large-model" },
        {},
      );
      expect(result.utility).toBe("util-model");
      expect(result.utility_large).toBe("large-model");
      expect(result.api_key).toBe("sk-test");
      expect(result.api).toBe("openai-completions");
    });

    it("utility_api 与模型 provider 不一致时直接报错", () => {
      const mm = new ModelManager({ hanakoHome: tempDir });
      mm._availableModels = [
        { id: "util-model", provider: "test-provider", _cred: { api: "openai-completions", apiKey: "sk-test", baseUrl: "https://test.example.com/v1" } },
        { id: "large-model", provider: "test-provider", _cred: { api: "openai-completions", apiKey: "sk-test", baseUrl: "https://test.example.com/v1" } },
      ];
      setupRouter(mm);
      expect(() => mm.resolveUtilityConfig(
        {},
        { utility: "util-model", utility_large: "large-model" },
        { provider: "openai", api_key: "sk-test", base_url: "https://api.openai.com/v1" },
      )).toThrow('error.utilityApiProviderMismatch');
    });

    it("不再接受 hardcoded fallback 模型名", () => {
      const mm = new ModelManager({ hanakoHome: tempDir });
      // 以前会 fallback 到 "doubao-seed-2-0-mini-260215"，现在应该抛错
      expect(() => mm.resolveUtilityConfig({}, {}, {}))
        .toThrow("error.noUtilityModel");
    });
  });
});
