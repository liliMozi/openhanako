/**
 * MiniMax OAuth Provider (Device Code Flow)
 *
 * 实现 Pi SDK 的 OAuthProviderInterface，注册后可通过
 * AuthStorage.login("minimax", callbacks) 触发登录。
 *
 * 流程：
 *   1. POST /oauth/code → 拿到 user_code + verification_uri
 *   2. 用户在浏览器打开 verification_uri 并输入 user_code
 *   3. 轮询 POST /oauth/token 直到授权完成
 */
import crypto from "crypto";

const MINIMAX_CONFIG = {
  cn: {
    baseUrl: "https://api.minimaxi.com",
    clientId: "78257093-7e40-4613-99e0-527b14b39113",
  },
  global: {
    baseUrl: "https://api.minimax.io",
    clientId: "78257093-7e40-4613-99e0-527b14b39113",
  },
};

const SCOPE = "group_id profile model.completion";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:user_code";

// ── helpers ──

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function getEndpoints(region = "cn") {
  const cfg = MINIMAX_CONFIG[region];
  return {
    codeEndpoint: `${cfg.baseUrl}/oauth/code`,
    tokenEndpoint: `${cfg.baseUrl}/oauth/token`,
    clientId: cfg.clientId,
  };
}

async function requestDeviceCode({ challenge, state, region }) {
  const ep = getEndpoints(region);
  const res = await fetch(ep.codeEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "x-request-id": crypto.randomUUID(),
    },
    body: new URLSearchParams({
      response_type: "code",
      client_id: ep.clientId,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    }),
  });

  if (!res.ok) {
    throw new Error(`MiniMax OAuth code request failed: ${await res.text()}`);
  }

  const data = await res.json();
  if (!data.user_code || !data.verification_uri) {
    throw new Error(data.error || "MiniMax OAuth: incomplete code response");
  }
  if (data.state !== state) {
    throw new Error("MiniMax OAuth: state mismatch");
  }
  return data;
}

async function pollForToken({ userCode, verifier, region }) {
  const ep = getEndpoints(region);
  const res = await fetch(ep.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: DEVICE_CODE_GRANT,
      client_id: ep.clientId,
      user_code: userCode,
      code_verifier: verifier,
    }),
  });

  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = null; }

  if (!res.ok) {
    return { status: "error", message: payload?.base_resp?.status_msg || text };
  }
  if (!payload) {
    return { status: "error", message: "Failed to parse token response" };
  }
  if (payload.status === "error") {
    return { status: "error", message: "Authorization error" };
  }
  if (payload.status !== "success") {
    return { status: "pending" };
  }
  if (!payload.access_token || !payload.refresh_token || !payload.expired_in) {
    return { status: "error", message: "Incomplete token response" };
  }

  return {
    status: "success",
    token: {
      access: payload.access_token,
      refresh: payload.refresh_token,
      expires: payload.expired_in, // unix timestamp ms
      resourceUrl: payload.resource_url,
    },
  };
}

// ── OAuthProviderInterface ──

export const minimaxOAuthProvider = {
  id: "minimax",
  name: "MiniMax",

  async login(callbacks) {
    const region = "cn";
    const { verifier, challenge } = generatePKCE();
    const state = crypto.randomBytes(16).toString("base64url");

    const oauth = await requestDeviceCode({ challenge, state, region });

    // 通知前端：打开浏览器 + 显示 user_code
    callbacks.onAuth({
      url: oauth.verification_uri,
      instructions: oauth.user_code,
    });

    if (callbacks.onProgress) {
      callbacks.onProgress("Waiting for MiniMax authorization...");
    }

    // 轮询直到用户授权或超时
    let interval = oauth.interval || 2000;
    const expireTime = oauth.expired_in;

    while (Date.now() < expireTime) {
      if (callbacks.signal?.aborted) {
        throw new Error("MiniMax OAuth aborted");
      }

      const result = await pollForToken({ userCode: oauth.user_code, verifier, region });

      if (result.status === "success") {
        return {
          refresh: result.token.refresh,
          access: result.token.access,
          expires: result.token.expires,
          resourceUrl: result.token.resourceUrl,
        };
      }

      if (result.status === "error") {
        throw new Error(`MiniMax OAuth failed: ${result.message}`);
      }

      // pending — 退避
      interval = Math.min(interval * 1.5, 10000);
      await new Promise(r => setTimeout(r, interval));
    }

    throw new Error("MiniMax OAuth timed out");
  },

  async refreshToken(credentials) {
    const ep = getEndpoints("cn");
    const res = await fetch(ep.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: ep.clientId,
        refresh_token: credentials.refresh,
      }),
    });

    if (!res.ok) {
      throw new Error(`MiniMax token refresh failed: ${await res.text()}`);
    }

    const data = await res.json();
    if (!data.access_token) {
      throw new Error("MiniMax refresh: no access token returned");
    }

    return {
      refresh: data.refresh_token || credentials.refresh,
      access: data.access_token,
      expires: data.expired_in || (Date.now() + 3600_000),
    };
  },

  getApiKey(credentials) {
    return credentials.access;
  },

  /**
   * 用 auth.json 里的 resourceUrl 覆盖内置模型的 baseUrl
   * 解决中国版（minimaxi.com）和国际版（minimax.io）域名不一致的问题
   */
  modifyModels(models, credentials) {
    if (!credentials?.resourceUrl) return models;
    return models.map(m => {
      if (m.provider !== "minimax") return m;
      return { ...m, baseUrl: credentials.resourceUrl };
    });
  },
};
