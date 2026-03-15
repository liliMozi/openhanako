/**
 * OAuth 认证路由
 *
 * 支持两种 OAuth 流程：
 *   - 授权码流程 (Anthropic)：用户粘贴授权码
 *   - 设备码流程 (MiniMax)：服务端轮询，用户在浏览器授权
 *
 * 交互：
 *   1. POST /api/auth/oauth/start    → { sessionId, url, instructions? }
 *   2. POST /api/auth/oauth/callback → 提交授权码（授权码流程）
 *   3. GET  /api/auth/oauth/poll/:id → 轮询登录状态（设备码流程）
 */
import crypto from "crypto";

export default async function authRoute(app, { engine }) {

  /** 进行中的 OAuth 流程 */
  const pendingFlows = new Map();

  /**
   * 启动 OAuth 登录
   * body: { provider }
   * → { sessionId, url, instructions? }
   *   instructions 存在时为设备码流程（值为 user_code）
   */
  app.post("/api/auth/oauth/start", async (req, reply) => {
    const { provider } = req.body || {};
    if (!provider) {
      reply.code(400);
      return { error: "provider is required" };
    }

    const sessionId = crypto.randomUUID();

    // onAuth 回调会把 URL 和 instructions 交给我们
    let resolveUrl, rejectUrl;
    const urlPromise = new Promise((resolve, reject) => {
      resolveUrl = resolve;
      rejectUrl = reject;
    });

    // onPrompt 回调等待用户粘贴授权码（仅授权码流程使用）
    let resolveCode, rejectCode;
    const codePromise = new Promise((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    let authInstructions = null;
    let usesCallbackServer = false;

    // 检查 provider 是否使用本地回调服务器（如 OpenAI Codex）
    const providerObj = engine.authStorage.getOAuthProviders().find(p => p.id === provider);
    if (providerObj?.usesCallbackServer) usesCallbackServer = true;

    // 启动 OAuth（不 await，loginPromise 会异步 resolve）
    const loginPromise = engine.authStorage.login(provider, {
      onAuth: (info) => {
        // callback server 流程不需要给前端显示 instructions（那只是提示文本，不是 user_code）
        // 只有设备码流程才需要（instructions 是 user_code）
        if (usesCallbackServer) {
          authInstructions = null;
        } else {
          authInstructions = info.instructions || null;
        }
        resolveUrl(info.url);
      },
      onPrompt: () => codePromise,
    }).catch(err => {
      rejectUrl(err);
      throw err;
    });

    // 追踪 loginPromise 的结果（供 poll 端点使用）
    const flow = { resolveCode, rejectCode, loginPromise, result: null };
    loginPromise.then(() => {
      flow.result = { ok: true };
    }).catch(err => {
      flow.result = { ok: false, error: err.message };
    });

    try {
      const url = await urlPromise;
      pendingFlows.set(sessionId, flow);

      // 5 分钟超时
      const timer = setTimeout(() => {
        const f = pendingFlows.get(sessionId);
        if (f) {
          f.rejectCode(new Error("OAuth flow timed out"));
          pendingFlows.delete(sessionId);
        }
      }, 5 * 60 * 1000);
      timer.unref();

      const resp = { sessionId, url };
      if (authInstructions) resp.instructions = authInstructions;
      if (usesCallbackServer) resp.polling = true;
      return resp;
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  /**
   * 提交授权码（授权码流程）
   * body: { sessionId, code }
   */
  app.post("/api/auth/oauth/callback", async (req, reply) => {
    const { sessionId, code } = req.body || {};
    const flow = pendingFlows.get(sessionId);
    if (!flow) {
      reply.code(400);
      return { error: "No pending login flow" };
    }

    flow.resolveCode(code);

    try {
      await flow.loginPromise;
      pendingFlows.delete(sessionId);

      try {
        await engine.syncModelsAndRefresh();
      } catch (err) {
        console.error("[auth] post-login model sync failed:", err.message);
      }

      return { ok: true };
    } catch (err) {
      pendingFlows.delete(sessionId);
      reply.code(500);
      return { error: err.message };
    }
  });

  /**
   * 轮询登录状态（设备码流程）
   * → { status: "pending" | "done" | "error", error? }
   */
  app.get("/api/auth/oauth/poll/:sessionId", async (req, reply) => {
    const flow = pendingFlows.get(req.params.sessionId);
    if (!flow) {
      reply.code(400);
      return { status: "error", error: "No pending login flow" };
    }

    if (!flow.result) {
      return { status: "pending" };
    }

    pendingFlows.delete(req.params.sessionId);

    if (flow.result.ok) {
      try {
        await engine.syncModelsAndRefresh();
      } catch (err) {
        console.error("[auth] post-login model sync failed:", err.message);
      }
      return { status: "done" };
    }

    return { status: "error", error: flow.result.error };
  });

  /**
   * 查询 OAuth 状态
   * → { anthropic: { name, loggedIn }, minimax: { name, loggedIn }, ... }
   */
  app.get("/api/auth/oauth/status", async () => {
    const providers = engine.authStorage.getOAuthProviders();
    const status = {};
    for (const p of providers) {
      const cred = engine.authStorage.get(p.id);
      const modelCount = cred?.type === "oauth"
        ? engine.availableModels.filter(m => m.provider === p.id).length
        : 0;
      status[p.id] = {
        name: p.name,
        loggedIn: cred?.type === "oauth",
        modelCount,
      };
    }
    return status;
  });

  /**
   * 登出
   * body: { provider }
   */
  app.post("/api/auth/oauth/logout", async (req, reply) => {
    const { provider } = req.body || {};
    if (!provider) {
      reply.code(400);
      return { error: "provider is required" };
    }
    engine.authStorage.logout(provider);
    return { ok: true };
  });
}
