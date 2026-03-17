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
 *   3. POST /api/auth/oauth/import   → 导入官方工具的认证文件
 *   4. GET  /api/auth/oauth/poll/:id → 轮询登录状态（设备码流程）
 */
import crypto from "crypto";
import { createModuleLogger } from "../../lib/debug-log.js";
import { loadGlobalProviders, saveGlobalProviders } from "../../lib/memory/config-loader.js";
import { importOpenAICodexAuthFile } from "../../lib/oauth/openai-codex.js";

const log = createModuleLogger("auth");

export default async function authRoute(app, { engine }) {

  /** 进行中的 OAuth 流程 */
  const pendingFlows = new Map();

  async function hydrateOAuthProviderCatalog(provider) {
    if (!provider) return 0;

    if (typeof engine.refreshAvailableModels === "function") {
      await engine.refreshAvailableModels();
    }

    const availableModels = Array.isArray(engine.availableModels) ? engine.availableModels : [];
    const providerModels = availableModels.filter((model) => model.provider === provider);
    if (providerModels.length === 0) return 0;

    const currentProvider = loadGlobalProviders().providers?.[provider] || {};
    const mergedModels = [...new Set([
      ...(Array.isArray(currentProvider.models) ? currentProvider.models : []),
      ...providerModels.map((model) => model.id).filter(Boolean),
    ])];
    const firstModel = providerModels.find((model) => model?.baseUrl || model?.api) || providerModels[0];

    // OAuth 登录成功后，需要把 registry 里的 provider 目录同步到配置层，
    // 否则设置页虽然已有登录态，模型选择器仍可能因为 providers.yaml 缺少声明而显示为空。
    saveGlobalProviders({
      providers: {
        [provider]: {
          ...(firstModel?.baseUrl ? { base_url: firstModel.baseUrl } : {}),
          ...(firstModel?.api ? { api: firstModel.api } : {}),
          models: mergedModels,
        },
      },
    });

    return mergedModels.length;
  }

  async function finalizeOAuthSuccess(provider, stage) {
    let hydratedCount = 0;

    try {
      hydratedCount = await hydrateOAuthProviderCatalog(provider);
      if (provider && hydratedCount > 0) {
        log.log(`oauth ${stage} provider catalog synced provider=${provider} models=${hydratedCount}`);
      }
    } catch (err) {
      log.warn(`oauth ${stage} provider catalog sync failed${provider ? ` provider=${provider}` : ""}: ${err.message}`);
    }

    try {
      await engine.syncModelsAndRefresh();
    } catch (err) {
      log.warn(`post-${stage} model sync failed${provider ? ` provider=${provider}` : ""}: ${err.message}`);
    }

    return hydratedCount;
  }

  /**
   * 启动 OAuth 登录
   * body: { provider }
   * → { sessionId, url, instructions?, polling?, manualInput? }
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
    log.log(`oauth start provider=${provider} callbackServer=${usesCallbackServer}`);

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
      // callback-server 模式下，把前端粘贴的回调地址也接进 SDK 的手动输入通道，
      // 这样本地端口被占用或回调丢失时，前端仍然可以完成授权。
      onManualCodeInput: usesCallbackServer ? () => codePromise : undefined,
      onPrompt: () => codePromise,
    }).catch(err => {
      log.error(`oauth login failed provider=${provider}: ${err.message}`);
      rejectUrl(err);
      throw err;
    });

    // 追踪 loginPromise 的结果（供 poll 端点使用）
    const flow = { provider, resolveCode, rejectCode, loginPromise, result: null };
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
      if (usesCallbackServer) resp.manualInput = true;
      return resp;
    } catch (err) {
      log.error(`oauth start failed provider=${provider}: ${err.message}`);
      reply.code(500);
      return { error: err.message };
    }
  });

  /**
   * 提交授权码（授权码流程 / callback-server 手动兜底）
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
    log.log(`oauth callback received session=${sessionId} pasted=${typeof code === "string" && code.length > 0}`);

    try {
      await flow.loginPromise;
      pendingFlows.delete(sessionId);
      log.log(`oauth callback login completed session=${sessionId}`);
      await finalizeOAuthSuccess(flow.provider, "callback");

      return { ok: true };
    } catch (err) {
      pendingFlows.delete(sessionId);
      log.error(`oauth callback failed session=${sessionId}: ${err.message}`);
      reply.code(500);
      return { error: err.message };
    }
  });

  /**
   * 导入官方 Codex CLI 的认证文件
   * body: { provider, filePath? }
   */
  app.post("/api/auth/oauth/import", async (req, reply) => {
    const { provider, filePath } = req.body || {};
    if (!provider) {
      reply.code(400);
      return { error: "provider is required" };
    }
    if (provider !== "openai-codex") {
      reply.code(400);
      return { error: "Import is only supported for openai-codex" };
    }

    try {
      const credentials = await importOpenAICodexAuthFile(filePath);
      const { sourcePath, ...oauthCredentials } = credentials;
      engine.authStorage.set(provider, { type: "oauth", ...oauthCredentials });
      log.log(`oauth import completed provider=${provider} source=${sourcePath}`);
      await finalizeOAuthSuccess(provider, "import");

      return { ok: true, sourcePath };
    } catch (err) {
      log.error(`oauth import failed provider=${provider}: ${err.message}`);
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
      await finalizeOAuthSuccess(flow.provider, "poll");
      log.log(`oauth poll completed session=${req.params.sessionId}`);
      return { status: "done" };
    }

    log.warn(`oauth poll failed session=${req.params.sessionId}: ${flow.result.error}`);
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
