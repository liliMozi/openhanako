/**
 * Session model isolation — 验证 per-session 模型隔离
 *
 * 核心规则：
 * 1. session 模型创建时确定，不可变
 * 2. 新 session 默认用 agent 默认模型
 * 3. _pendingModel 只影响下次 createSession
 * 4. switchSession 只切指针，不做模型恢复
 */
import { describe, it, expect, vi } from "vitest";
import { findModel } from "../shared/model-ref.js";

// ── Mock 工厂 ──

const MODEL_A = { id: "minimax", name: "MiniMax", provider: "minimax" };
const MODEL_B = { id: "mimo", name: "Mimo", provider: "minimax" };
const MODEL_DEFAULT = MODEL_A;

function makeMockModels() {
  return {
    _defaultModel: MODEL_DEFAULT,
    get currentModel() { return this._defaultModel; },
    get availableModels() { return [MODEL_A, MODEL_B]; },
    setDefaultModel(id, provider) {
      const m = findModel(this.availableModels, id, provider);
      if (!m) throw new Error("not found");
      this._defaultModel = m;
      return m;
    },
    resolveThinkingLevel: () => "medium",
  };
}

function makeMockSessionCoordinator(models) {
  const sessions = new Map();
  let currentSession = null;
  let pendingModel = null;

  return {
    _sessions: sessions,
    get session() { return currentSession; },
    get pendingModel() { return pendingModel; },
    setPendingModel(m) { pendingModel = m; },
    get currentSessionPath() {
      if (!currentSession) return null;
      for (const [k, v] of sessions) { if (v.session === currentSession) return k; }
      return null;
    },
    createSession(mgr, cwd, memEnabled, model) {
      const effectiveModel = model || pendingModel || models.currentModel;
      pendingModel = null;
      const session = { model: effectiveModel, setModel: vi.fn() };
      const path = `/sessions/${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      sessions.set(path, {
        session,
        modelId: effectiveModel?.id || null,
        modelProvider: effectiveModel?.provider || null,
      });
      currentSession = session;
      return { session, sessionPath: path, agentId: null };
    },
    switchSession(path) {
      const entry = sessions.get(path);
      if (!entry) throw new Error("session not found");
      currentSession = entry.session;
      return entry.session;
    },
    switchSessionModel(sessionPath, newModel) {
      const entry = sessions.get(sessionPath);
      if (!entry) throw new Error("session not found");
      entry.session.model = newModel;
      entry.modelId = newModel.id;
      entry.modelProvider = newModel.provider;
      return { adaptations: [] };
    },
    getCurrentSessionModelRef() {
      if (!currentSession) return null;
      return { id: currentSession.model?.id, provider: currentSession.model?.provider };
    },
  };
}

describe("Session model isolation", () => {
  it("新 session 无指定模型时用 agent 默认", () => {
    const models = makeMockModels();
    const coord = makeMockSessionCoordinator(models);
    coord.createSession(null, null, true);
    expect(coord.session.model).toBe(MODEL_DEFAULT);
  });

  it("新 session 指定模型时用指定的", () => {
    const models = makeMockModels();
    const coord = makeMockSessionCoordinator(models);
    coord.createSession(null, null, true, MODEL_B);
    expect(coord.session.model).toBe(MODEL_B);
  });

  it("pendingModel 被 createSession 消费后清空", () => {
    const models = makeMockModels();
    const coord = makeMockSessionCoordinator(models);
    coord.setPendingModel(MODEL_B);
    expect(coord.pendingModel).toBe(MODEL_B);
    coord.createSession(null, null, true);
    expect(coord.session.model).toBe(MODEL_B);
    expect(coord.pendingModel).toBeNull();
  });

  it("切 session 不改模型 — 两个 session 各自保持", () => {
    const models = makeMockModels();
    const coord = makeMockSessionCoordinator(models);

    const { session: sessionA } = coord.createSession(null, null, true, MODEL_A);
    const pathA = coord.currentSessionPath;

    const { session: sessionB } = coord.createSession(null, null, true, MODEL_B);
    const pathB = coord.currentSessionPath;

    expect(sessionB.model).toBe(MODEL_B);

    coord.switchSession(pathA);
    expect(coord.session.model).toBe(MODEL_A);

    coord.switchSession(pathB);
    expect(coord.session.model).toBe(MODEL_B);
  });

  it("switchSession 不调用 setDefaultModel 或 session.setModel", () => {
    const models = makeMockModels();
    models.setDefaultModel = vi.fn(models.setDefaultModel);
    const coord = makeMockSessionCoordinator(models);

    const { session: sessionA } = coord.createSession(null, null, true, MODEL_A);
    const pathA = coord.currentSessionPath;
    coord.createSession(null, null, true, MODEL_B);

    coord.switchSession(pathA);
    expect(models.setDefaultModel).not.toHaveBeenCalled();
    expect(sessionA.setModel).not.toHaveBeenCalled();
  });

  it("setDefaultModel 不改活跃 session", () => {
    const models = makeMockModels();
    const coord = makeMockSessionCoordinator(models);
    coord.createSession(null, null, true, MODEL_A);

    models.setDefaultModel("mimo", "minimax");
    expect(models.currentModel).toBe(MODEL_B);
    expect(coord.session.model).toBe(MODEL_A);
  });

  it("pendingModel 不影响已有 session", () => {
    const models = makeMockModels();
    const coord = makeMockSessionCoordinator(models);
    coord.createSession(null, null, true, MODEL_A);

    coord.setPendingModel(MODEL_B);
    expect(coord.session.model).toBe(MODEL_A);
  });

  it("冷启动 legacy session 无 model 时用 agent 默认", () => {
    const models = makeMockModels();
    const coord = makeMockSessionCoordinator(models);
    coord.createSession(null, null, true, null);
    expect(coord.session.model).toBe(MODEL_DEFAULT);
  });

  it("engine.currentModel 优先级: pendingModel > defaultModel（不含 session.model）", () => {
    const models = makeMockModels();
    const coord = makeMockSessionCoordinator(models);

    // currentModel = UI 选择器绑定，不受活跃 session 影响
    const getCurrent = () => coord.pendingModel ?? models.currentModel;
    // activeSessionModel = 当前 session 实际使用的模型
    const getActiveSession = () => coord.session?.model ?? null;

    // 无 session 无 pending → defaultModel
    expect(getCurrent()).toBe(MODEL_DEFAULT);
    expect(getActiveSession()).toBe(null);

    // 设 pending → pendingModel
    coord.setPendingModel(MODEL_B);
    expect(getCurrent()).toBe(MODEL_B);

    // 创建 session → currentModel 回到 defaultModel，session 用自己的模型
    coord.createSession(null, null, true, MODEL_A);
    expect(getCurrent()).toBe(MODEL_DEFAULT);
    expect(getActiveSession()).toBe(MODEL_A);
  });

  it("多 session 并行运行各自用创建时的模型", () => {
    const models = makeMockModels();
    const coord = makeMockSessionCoordinator(models);

    const { session: sessionA } = coord.createSession(null, null, true, MODEL_A);
    const { session: sessionB } = coord.createSession(null, null, true, MODEL_B);

    // 两个 session 对象各自持有自己的 model
    expect(sessionA.model).toBe(MODEL_A);
    expect(sessionB.model).toBe(MODEL_B);

    // 改默认模型不影响任何已有 session
    models.setDefaultModel("mimo", "minimax");
    expect(sessionA.model).toBe(MODEL_A);
    expect(sessionB.model).toBe(MODEL_B);
  });

  describe("switchSessionModel", () => {
    it("switches model on existing session without creating new session", () => {
      const models = makeMockModels();
      const coord = makeMockSessionCoordinator(models);

      const { sessionPath } = coord.createSession(null, null, true, MODEL_A);
      const sessionsBefore = coord._sessions.size;

      coord.switchSessionModel(sessionPath, MODEL_B);

      expect(coord._sessions.size).toBe(sessionsBefore);
      expect(coord.session.model).toBe(MODEL_B);
    });

    it("does not affect pendingModel or defaultModel", () => {
      const models = makeMockModels();
      const coord = makeMockSessionCoordinator(models);

      coord.setPendingModel(MODEL_A);
      const { sessionPath } = coord.createSession(null, null, true, MODEL_A);

      // pendingModel was consumed by createSession
      expect(coord.pendingModel).toBeNull();

      coord.switchSessionModel(sessionPath, MODEL_B);

      // pendingModel stays null, defaultModel stays unchanged
      expect(coord.pendingModel).toBeNull();
      expect(models.currentModel).toBe(MODEL_DEFAULT);
    });

    it("throws for unknown sessionPath", () => {
      const models = makeMockModels();
      const coord = makeMockSessionCoordinator(models);

      expect(() => coord.switchSessionModel("/nonexistent/path", MODEL_B))
        .toThrow("session not found");
    });

    it("updates entry modelId and modelProvider", () => {
      const models = makeMockModels();
      const coord = makeMockSessionCoordinator(models);

      const { sessionPath } = coord.createSession(null, null, true, MODEL_A);
      const entry = coord._sessions.get(sessionPath);

      expect(entry.modelId).toBe(MODEL_A.id);
      expect(entry.modelProvider).toBe(MODEL_A.provider);

      coord.switchSessionModel(sessionPath, MODEL_B);

      expect(entry.modelId).toBe(MODEL_B.id);
      expect(entry.modelProvider).toBe(MODEL_B.provider);
    });
  });
});
