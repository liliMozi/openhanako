import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

const saveGlobalProviders = vi.fn();
const loadGlobalProviders = vi.fn(() => ({ providers: {} }));

vi.mock("../lib/memory/config-loader.js", () => ({
  loadGlobalProviders,
  saveGlobalProviders,
}));

function createJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("oauth auth route", () => {
  it("hydrates oauth provider models into global provider config after import", async () => {
    const { default: authRoute } = await import("../server/routes/auth.js");
    const app = Fastify();
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hanako-codex-auth-"));
    const authFile = path.join(tempDir, "auth.json");
    const accessToken = createJwt({
      exp: 1774591619,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-123",
      },
    });

    writeFileSync(
      authFile,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-token",
        },
      }),
      "utf8",
    );

    saveGlobalProviders.mockReset();
    loadGlobalProviders.mockReset();
    loadGlobalProviders.mockReturnValue({ providers: {} });

    const engine = {
      availableModels: [],
      refreshAvailableModels: vi.fn(async () => {
        engine.availableModels = [
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            provider: "openai-codex",
            api: "openai-codex-responses",
            baseUrl: "https://chatgpt.com/backend-api",
          },
        ];
      }),
      authStorage: {
        getOAuthProviders: () => [
          { id: "openai-codex", name: "OpenAI Codex", usesCallbackServer: true },
        ],
        get: vi.fn(() => undefined),
        set: vi.fn(),
        logout: vi.fn(),
        login: vi.fn(),
      },
      syncModelsAndRefresh: vi.fn().mockResolvedValue(undefined),
    };

    await authRoute(app, { engine });

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/oauth/import",
      payload: {
        provider: "openai-codex",
        filePath: authFile,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(engine.refreshAvailableModels).toHaveBeenCalledTimes(1);
    expect(saveGlobalProviders).toHaveBeenCalledWith({
      providers: {
        "openai-codex": {
          base_url: "https://chatgpt.com/backend-api",
          api: "openai-codex-responses",
          models: ["gpt-5.4"],
        },
      },
    });

    rmSync(tempDir, { recursive: true, force: true });
    await app.close();
  });

  it("callback-server provider exposes manual fallback and accepts pasted callback data", async () => {
    const { default: authRoute } = await import("../server/routes/auth.js");
    const app = Fastify();

    const engine = {
      authStorage: {
        getOAuthProviders: () => [
          { id: "openai-codex", name: "OpenAI Codex", usesCallbackServer: true },
        ],
        get: vi.fn(() => undefined),
        logout: vi.fn(),
        login: vi.fn(async (_provider, callbacks) => {
          callbacks.onAuth({ url: "https://auth.openai.com/oauth/authorize" });
          const manual = callbacks.onManualCodeInput;
          expect(typeof manual).toBe("function");
          const code = await manual();
          expect(code).toBe("http://localhost:1455/auth/callback?code=test-code");
        }),
      },
      syncModelsAndRefresh: vi.fn().mockResolvedValue(undefined),
      availableModels: [],
    };

    await authRoute(app, { engine });

    const startRes = await app.inject({
      method: "POST",
      url: "/api/auth/oauth/start",
      payload: { provider: "openai-codex" },
    });

    expect(startRes.statusCode).toBe(200);
    const startData = startRes.json();
    expect(startData.polling).toBe(true);
    expect(startData.manualInput).toBe(true);

    const callbackRes = await app.inject({
      method: "POST",
      url: "/api/auth/oauth/callback",
      payload: {
        sessionId: startData.sessionId,
        code: "http://localhost:1455/auth/callback?code=test-code",
      },
    });

    expect(callbackRes.statusCode).toBe(200);
    expect(callbackRes.json()).toEqual({ ok: true });
    expect(engine.syncModelsAndRefresh).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("imports the official Codex auth file into Hanako auth storage", async () => {
    const { default: authRoute } = await import("../server/routes/auth.js");
    const app = Fastify();
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hanako-codex-auth-"));
    const authFile = path.join(tempDir, "auth.json");
    const accessToken = createJwt({
      exp: 1774591619,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-123",
      },
    });

    writeFileSync(
      authFile,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-token",
        },
      }),
      "utf8",
    );

    const engine = {
      authStorage: {
        getOAuthProviders: () => [
          { id: "openai-codex", name: "OpenAI Codex", usesCallbackServer: true },
        ],
        get: vi.fn(() => undefined),
        set: vi.fn(),
        logout: vi.fn(),
        login: vi.fn(),
      },
      syncModelsAndRefresh: vi.fn().mockResolvedValue(undefined),
      availableModels: [],
    };

    await authRoute(app, { engine });

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/oauth/import",
      payload: {
        provider: "openai-codex",
        filePath: authFile,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      sourcePath: authFile,
    });
    expect(engine.authStorage.set).toHaveBeenCalledWith(
      "openai-codex",
      expect.objectContaining({
        type: "oauth",
        access: accessToken,
        refresh: "refresh-token",
        expires: 1774591619 * 1000,
        accountId: "acct-123",
      }),
    );
    expect(engine.syncModelsAndRefresh).toHaveBeenCalledTimes(1);

    rmSync(tempDir, { recursive: true, force: true });
    await app.close();
  });
});
