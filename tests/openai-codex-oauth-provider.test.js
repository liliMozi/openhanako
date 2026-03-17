import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

describe("openai codex oauth provider override", () => {
  let nativeFetch;

  beforeEach(() => {
    nativeFetch = globalThis.fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps login working when the token omits chatgpt_account_id", async () => {
    const { openaiCodexOAuthProvider } = await import("../lib/oauth/openai-codex.js");
    let authInfo;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const url = String(input);
        if (url === "https://auth.openai.com/oauth/token") {
          return new Response(
            JSON.stringify({
              access_token: createJwt({ sub: "user-1" }),
              refresh_token: "refresh-token",
              expires_in: 3600,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return nativeFetch(input, init);
      }),
    );

    const creds = await openaiCodexOAuthProvider.login({
      onAuth: (info) => {
        authInfo = info;
      },
      onPrompt: async () => {
        throw new Error("prompt should not be used for callback-server login");
      },
      onManualCodeInput: async () => {
        const state = new URL(authInfo.url).searchParams.get("state");
        return `http://localhost:1455/auth/callback?code=test-code&state=${state}`;
      },
    });

    expect(creds.access).toMatch(/\./);
    expect(creds.refresh).toBe("refresh-token");
    expect(typeof creds.expires).toBe("number");
    expect(creds.accountId).toBeUndefined();
  });

  it("preserves the previous accountId during refresh when the new token omits it", async () => {
    const { openaiCodexOAuthProvider } = await import("../lib/oauth/openai-codex.js");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            access_token: createJwt({ sub: "user-1" }),
            refresh_token: "next-refresh-token",
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const nextCreds = await openaiCodexOAuthProvider.refreshToken({
      access: "old-access-token",
      refresh: "refresh-token",
      expires: Date.now() - 1000,
      accountId: "acct-123",
    });

    expect(nextCreds.refresh).toBe("next-refresh-token");
    expect(nextCreds.accountId).toBe("acct-123");
  });

  it("parses the official Codex auth.json format into Hanako OAuth credentials", async () => {
    const { parseOpenAICodexAuthFileContent } = await import("../lib/oauth/openai-codex.js");
    const accessToken = createJwt({
      exp: 1774591619,
      [OPENAI_AUTH_CLAIM]: {
        chatgpt_account_id: "acct-789",
      },
    });

    const imported = parseOpenAICodexAuthFileContent(JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: accessToken,
        refresh_token: "refresh-token",
      },
    }));

    expect(imported).toEqual({
      access: accessToken,
      refresh: "refresh-token",
      expires: 1774591619 * 1000,
      accountId: "acct-789",
    });
  });
});
