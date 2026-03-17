/**
 * OpenAI Codex OAuth provider override
 *
 * Hanako only needs a usable OAuth access token for `openai-codex-responses`.
 * Recent OpenAI tokens can complete OAuth successfully but omit the historical
 * `chatgpt_account_id` JWT claim. The upstream provider treats that as fatal,
 * which blocks login even though the token itself is valid for model access.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createModuleLogger } from "../debug-log.js";

const log = createModuleLogger("oauth-codex");

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authentication successful</title>
</head>
<body>
  <p>Authentication successful. Return to your terminal to continue.</p>
</body>
</html>`;

function base64urlEncode(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function generatePKCE() {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64urlEncode(verifierBytes);
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64urlEncode(new Uint8Array(hashBuffer));
  return { verifier, challenge };
}

function createState() {
  return randomBytes(16).toString("hex");
}

function parseAuthorizationInput(input) {
  const value = String(input || "").trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Not a URL, continue with fallback parsing.
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
}

function decodeJwt(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function getAccountId(accessToken) {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH];
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function getTokenExpiry(token) {
  const payload = decodeJwt(token);
  return typeof payload?.exp === "number" ? payload.exp * 1000 : null;
}

function resolveImportedAccountId(tokens) {
  const explicitAccountId = typeof tokens?.account_id === "string" ? tokens.account_id.trim() : "";
  return explicitAccountId || getAccountId(tokens?.access_token) || getAccountId(tokens?.id_token) || null;
}

async function exchangeAuthorizationCode(code, verifier) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token exchange failed: HTTP ${response.status}${text ? ` ${text}` : ""}`);
  }

  const json = await response.json();
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("Token exchange failed: response missing required OAuth fields");
  }

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

async function refreshAccessToken(refreshToken) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token refresh failed: HTTP ${response.status}${text ? ` ${text}` : ""}`);
  }

  const json = await response.json();
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("Token refresh failed: response missing required OAuth fields");
  }

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

async function createAuthorizationFlow(originator = "pi") {
  const { verifier, challenge } = await generatePKCE();
  const state = createState();

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", originator);

  return { verifier, state, url: url.toString() };
}

function startLocalOAuthServer(state) {
  let lastCode = null;
  let cancelled = false;
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || "", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.statusCode = 400;
        res.end("State mismatch");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.statusCode = 400;
        res.end("Missing authorization code");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(SUCCESS_HTML);
      lastCode = code;
    } catch {
      res.statusCode = 500;
      res.end("Internal error");
    }
  });

  return new Promise((resolve) => {
    server
      .listen(1455, "127.0.0.1", () => {
        resolve({
          close: () => server.close(),
          cancelWait: () => {
            cancelled = true;
          },
          waitForCode: async () => {
            const sleep = () => new Promise((r) => setTimeout(r, 100));
            for (let i = 0; i < 600; i += 1) {
              if (lastCode) return { code: lastCode };
              if (cancelled) return null;
              await sleep();
            }
            return null;
          },
        });
      })
      .on("error", (err) => {
        log.warn(
          `failed to bind http://127.0.0.1:1455 (${err?.code || "unknown"}), falling back to manual paste`,
        );
        resolve({
          close: () => {
            try {
              server.close();
            } catch {
              // Ignore close errors on fallback path.
            }
          },
          cancelWait: () => {},
          waitForCode: async () => null,
        });
      });
  });
}

function buildCredentials(tokenResult, previousAccountId) {
  const accountId = getAccountId(tokenResult.access) || previousAccountId || undefined;

  if (!accountId) {
    // Keep login alive: Hanako only needs the access token to talk to Codex.
    log.warn("OpenAI Codex token is missing chatgpt_account_id; continuing with token-only credentials");
  }

  return {
    access: tokenResult.access,
    refresh: tokenResult.refresh,
    expires: tokenResult.expires,
    ...(accountId ? { accountId } : {}),
  };
}

export function getDefaultOpenAICodexAuthFilePath() {
  return path.join(os.homedir(), ".codex", "auth.json");
}

export function parseOpenAICodexAuthFileContent(content) {
  let parsed;
  try {
    parsed = JSON.parse(String(content || ""));
  } catch {
    throw new Error("认证文件不是有效的 JSON");
  }

  if (parsed?.auth_mode && parsed.auth_mode !== "chatgpt") {
    throw new Error(`暂不支持 auth_mode=${parsed.auth_mode} 的 Codex 认证文件`);
  }

  const tokens = parsed?.tokens;
  if (!tokens || typeof tokens !== "object") {
    throw new Error("认证文件缺少 tokens 字段");
  }

  const access = typeof tokens.access_token === "string" ? tokens.access_token.trim() : "";
  const refresh = typeof tokens.refresh_token === "string" ? tokens.refresh_token.trim() : "";
  if (!access || !refresh) {
    throw new Error("认证文件缺少 access_token 或 refresh_token");
  }

  // 官方 auth.json 只保存原始 token，这里直接用 JWT 的 exp 还原过期时间；
  // 如果上游以后改掉 exp 声明，就让 Hanako 在首次使用时走 refresh 兜底。
  const expires = getTokenExpiry(access) ?? 0;
  const accountId = resolveImportedAccountId(tokens) || undefined;

  return {
    access,
    refresh,
    expires,
    ...(accountId ? { accountId } : {}),
  };
}

export async function importOpenAICodexAuthFile(filePath = getDefaultOpenAICodexAuthFilePath()) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new Error(`未找到官方 Codex 认证文件：${filePath}`);
    }
    throw err;
  }

  return {
    ...parseOpenAICodexAuthFileContent(content),
    sourcePath: filePath,
  };
}

export async function loginOpenAICodex(options) {
  const { verifier, state, url } = await createAuthorizationFlow(options.originator);
  const server = await startLocalOAuthServer(state);

  options.onAuth({ url, instructions: "A browser window should open. Complete login to finish." });

  let code;
  try {
    if (options.onManualCodeInput) {
      let manualCode;
      let manualError;
      const manualPromise = options.onManualCodeInput()
        .then((input) => {
          manualCode = input;
          server.cancelWait();
        })
        .catch((err) => {
          manualError = err instanceof Error ? err : new Error(String(err));
          server.cancelWait();
        });

      const result = await server.waitForCode();
      if (manualError) throw manualError;

      if (result?.code) {
        code = result.code;
      } else if (manualCode) {
        const parsed = parseAuthorizationInput(manualCode);
        if (parsed.state && parsed.state !== state) {
          throw new Error("State mismatch");
        }
        code = parsed.code;
      }

      if (!code) {
        await manualPromise;
        if (manualError) throw manualError;
        if (manualCode) {
          const parsed = parseAuthorizationInput(manualCode);
          if (parsed.state && parsed.state !== state) {
            throw new Error("State mismatch");
          }
          code = parsed.code;
        }
      }
    } else {
      const result = await server.waitForCode();
      if (result?.code) {
        code = result.code;
      }
    }

    if (!code) {
      const input = await options.onPrompt({
        message: "Paste the authorization code (or full redirect URL):",
      });
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== state) {
        throw new Error("State mismatch");
      }
      code = parsed.code;
    }

    if (!code) {
      throw new Error("Missing authorization code");
    }

    const tokenResult = await exchangeAuthorizationCode(code, verifier);
    return buildCredentials(tokenResult);
  } finally {
    server.close();
  }
}

export async function refreshOpenAICodexToken(credentials) {
  const tokenResult = await refreshAccessToken(credentials.refresh);
  return buildCredentials(tokenResult, credentials.accountId);
}

export const openaiCodexOAuthProvider = {
  id: "openai-codex",
  name: "ChatGPT Plus/Pro (Codex Subscription)",
  usesCallbackServer: true,

  async login(callbacks) {
    return loginOpenAICodex({
      onAuth: callbacks.onAuth,
      onPrompt: callbacks.onPrompt,
      onProgress: callbacks.onProgress,
      onManualCodeInput: callbacks.onManualCodeInput,
    });
  },

  async refreshToken(credentials) {
    return refreshOpenAICodexToken(credentials);
  },

  getApiKey(credentials) {
    return credentials.access;
  },
};
