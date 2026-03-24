/**
 * OAuth 认证路由
 *
 * 支持两种 OAuth 流程：
 *   - 授权码流程 (Anthropic)：用户粘贴授权码
 *   - 设备码流程 (MiniMax)：服务端轮询，用户在浏览器授权
 *
 * 交互：
 *   1. POST /auth/oauth/start    → { sessionId, url, instructions? }
 *   2. POST /auth/oauth/callback → 提交授权码（授权码流程）
 *   3. GET  /auth/oauth/poll/:id → 轮询登录状态（设备码流程）
 */
import crypto from "crypto";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";

export function createAuthRoute(engine) {
  const route = new Hono();

  /** 进行中的 OAuth 流程 */
  const pendingFlows = new Map();

  /**
   * 启动 OAuth 登录
   * body: { provider }
   * → { sessionId, url, instructions? }
   *   instructions 存在时为设备码流程（值为 user_code）
   */
  route.post("/auth/oauth/start", async (c) => {
    const body = await safeJson(c);
    const { provider } = body;
    if (!provider) {
      return c.json({ error: "provider is required" }, 400);
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
      return c.json(resp);
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  /**
   * 提交授权码（授权码流程）
   * body: { sessionId, code }
   */
  route.post("/auth/oauth/callback", async (c) => {
    const body = await safeJson(c);
    const { sessionId, code } = body;
    const flow = pendingFlows.get(sessionId);
    if (!flow) {
      return c.json({ error: "No pending login flow" }, 400);
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

      return c.json({ ok: true });
    } catch (err) {
      pendingFlows.delete(sessionId);
      return c.json({ error: err.message }, 500);
    }
  });

  /**
   * 轮询登录状态（设备码流程）
   * → { status: "pending" | "done" | "error", error? }
   */
  route.get("/auth/oauth/poll/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const flow = pendingFlows.get(sessionId);
    if (!flow) {
      return c.json({ status: "error", error: "No pending login flow" }, 400);
    }

    if (!flow.result) {
      return c.json({ status: "pending" });
    }

    pendingFlows.delete(sessionId);

    if (flow.result.ok) {
      try {
        await engine.syncModelsAndRefresh();
      } catch (err) {
        console.error("[auth] post-login model sync failed:", err.message);
      }
      return c.json({ status: "done" });
    }

    return c.json({ status: "error", error: flow.result.error });
  });

  /**
   * 查询 OAuth 状态
   * → { anthropic: { name, loggedIn }, minimax: { name, loggedIn }, ... }
   */
  route.get("/auth/oauth/status", async (c) => {
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
    return c.json(status);
  });

  /**
   * 登出
   * body: { provider }
   */
  route.post("/auth/oauth/logout", async (c) => {
    const body = await safeJson(c);
    const { provider } = body;
    if (!provider) {
      return c.json({ error: "provider is required" }, 400);
    }
    engine.authStorage.logout(provider);
    return c.json({ ok: true });
  });

  // ── OAuth 自定义模型 ──

  /** 获取某个 OAuth provider 的自定义模型列表 */
  route.get("/auth/oauth/:provider/custom-models", async (c) => {
    const provider = c.req.param("provider");
    const custom = engine.preferences.getOAuthCustomModels();
    return c.json({ models: custom[provider] || [] });
  });

  /** 添加自定义模型到 OAuth provider */
  route.post("/auth/oauth/:provider/custom-models", async (c) => {
    const provider = c.req.param("provider");
    const body = await safeJson(c);
    const { modelId } = body;
    if (!modelId || typeof modelId !== "string" || !modelId.trim()) {
      return c.json({ error: "modelId is required" }, 400);
    }
    const id = modelId.trim();
    const custom = engine.preferences.getOAuthCustomModels();
    const list = custom[provider] || [];
    if (list.includes(id)) return c.json({ ok: true, models: list });
    list.push(id);
    engine.preferences.setOAuthCustomModels(provider, list);
    await engine.refreshModels();
    return c.json({ ok: true, models: list });
  });

  /** 删除 OAuth provider 的某个自定义模型 */
  route.delete("/auth/oauth/:provider/custom-models/:modelId", async (c) => {
    const provider = c.req.param("provider");
    const modelId = c.req.param("modelId");
    const custom = engine.preferences.getOAuthCustomModels();
    const list = (custom[provider] || []).filter(id => id !== modelId);
    engine.preferences.setOAuthCustomModels(provider, list);
    await engine.refreshModels();
    return c.json({ ok: true, models: list });
  });

  return route;
}
