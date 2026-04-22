/**
 * bridge.js — 外部平台接入 REST API
 *
 * 管理 Telegram / 飞书 / QQ 等外部消息平台的连接。
 */

import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { getWechatQrcode, pollWechatQrcodeStatus } from "../../lib/bridge/wechat-login.js";
import { debugLog } from "../../lib/debug-log.js";
import { parseSessionKey, collectKnownUsers, KNOWN_PLATFORMS, getBasePlatform } from "../../lib/bridge/session-key.js";
import { t } from "../i18n.js";
import { resolveAgent, resolveAgentStrict } from "../utils/resolve-agent.js";


import WebSocket from "ws";

export function createBridgeRoute(engine, bridgeManager) {
  const route = new Hono();

  /** 获取所有平台连接状态（从 preferences.bridge 读取） */
  route.get("/bridge/status", async (c) => {
    const agent = resolveAgent(engine, c);
    const prefs = engine.getPreferences();
    const bridge = prefs.bridge || {};
    const live = bridgeManager.getStatus();

    // 将 instance 级状态映射到 platform 级（取最佳实例）
    const platformLive = {};
    for (const [instanceId, entry] of Object.entries(live)) {
      const base = getBasePlatform(instanceId);
      const cur = platformLive[base];
      if (!cur || (cur.status !== "connected" && entry.status === "connected") ||
          (cur.status === "error" && entry.status === "connected")) {
        platformLive[base] = entry;
      }
    }

    const platformStatus = (plat, cfg, extraFields) => {
      const liveEntry = platformLive[plat] || {};
      return {
        ...extraFields,
        enabled: !!cfg?.enabled,
        status: liveEntry.status || "disconnected",
        error: liveEntry.error || null,
      };
    };

    const tgToken = bridge.telegram?.token || "";
    const fsAppId = bridge.feishu?.appId || "";
    const fsAppSecret = bridge.feishu?.appSecret || "";

    // Build per-platform owner dict from preferences.bridge.owner
    const ownerDict = bridge.owner || {};

    return c.json({
      telegram: platformStatus("telegram", bridge.telegram, {
        configured: !!tgToken, token: tgToken,
      }),
      feishu: platformStatus("feishu", bridge.feishu, {
        configured: !!(fsAppId && fsAppSecret), appId: fsAppId, appSecret: fsAppSecret,
      }),
      qq: platformStatus("qq", bridge.qq, {
        configured: !!(bridge.qq?.appID && (bridge.qq?.appSecret || bridge.qq?.token)),
        appID: bridge.qq?.appID || "",
        appSecret: bridge.qq?.appSecret || bridge.qq?.token || "",
      }),
      wechat: platformStatus("wechat", bridge.wechat, {
        configured: !!bridge.wechat?.botToken,
        token: bridge.wechat?.botToken || "",
      }),
      workwechat: platformStatus("workwechat", bridge.workwechat, {
        configured: !!(bridge.workwechat?.botId && bridge.workwechat?.secret),
        botId: bridge.workwechat?.botId || "",
        userMap: bridge.workwechat?.userMap || {},
      }),
      readOnly: !!bridge.readOnly,
      knownUsers: collectKnownUsers(engine.getBridgeIndex(agent.id)),
      owner: ownerDict,
      instances: live,
    });
  });

  /** 设置 owner（哪个账号是你）— 写入 preferences.bridge.owner */
  route.post("/bridge/owner", async (c) => {
    const body = await safeJson(c);
    const { platform, userId } = body;
    if (!platform || !KNOWN_PLATFORMS.includes(platform)) {
      return c.json({ ok: false, error: "invalid platform" });
    }
    const agent = resolveAgentStrict(engine, c);
    const prefs = engine.getPreferences();
    const bridge = prefs.bridge || {};
    const owner = bridge.owner || {};
    owner[platform] = userId || null;
    bridge.owner = owner;
    prefs.bridge = bridge;
    engine.savePreferences(prefs);
    debugLog()?.log("api", `POST /api/bridge/owner agent=${agent.id} platform=${platform} owner=${userId ? "[set]" : "[cleared]"}`);
    return c.json({ ok: true });
  });

  /** 保存凭证 + 启停平台（写入 preferences.bridge） */
  route.post("/bridge/config", async (c) => {
    const body = await safeJson(c);
    const { platform, credentials, enabled, userMap, label, role } = body;
    if (!platform || !KNOWN_PLATFORMS.includes(platform)) {
      return c.json({ error: "invalid platform" }, 400);
    }

    const agent = resolveAgent(engine, c);

    const prefs = engine.getPreferences();
    const bridge = prefs.bridge || {};
    const bridgeCfg = bridge[platform] || {};
    const patch = { ...bridgeCfg };

    if (credentials) Object.assign(patch, credentials);
    if (typeof enabled === "boolean") patch.enabled = enabled;
    if (userMap && typeof userMap === "object") patch.userMap = userMap;
    if (typeof label === "string") patch.label = label;
    if (typeof role === "string") patch.role = role;

    bridge[platform] = patch;
    prefs.bridge = bridge;
    engine.savePreferences(prefs);

    // Start/stop only if enabled was explicitly provided
    if (typeof enabled === "boolean") {
      if (patch.enabled) {
        bridgeManager.startPlatformFromConfig(platform, patch);
      } else {
        bridgeManager.stopPlatform(platform);
      }
    }

    debugLog()?.log("api", `POST /api/bridge/config agent=${agent.id} platform=${platform} enabled=${!!patch.enabled}`);
    return c.json({ ok: true });
  });

  /** 更新 bridge 设置（readOnly 等）— 全局 */
  route.post("/bridge/settings", async (c) => {
    const body = await safeJson(c);
    const { readOnly } = body;
    const agent = resolveAgentStrict(engine, c);
    const prefs = engine.getPreferences();
    if (typeof readOnly === "boolean") {
      const bridge = prefs.bridge || {};
      bridge.readOnly = readOnly;
      prefs.bridge = bridge;
      engine.savePreferences(prefs);
    }
    debugLog()?.log("api", `POST /api/bridge/settings agent=${agent.id} readOnly=${readOnly}`);
    return c.json({ ok: true });
  });

  /** 停止指定平台 */
  route.post("/bridge/stop", async (c) => {
    const body = await safeJson(c);
    const { platform } = body;
    if (!platform) {
      return c.json({ error: "platform required" }, 400);
    }

    const agent = resolveAgentStrict(engine, c);
    bridgeManager.stopPlatform(platform);
    const prefs = engine.getPreferences();
    const bridge = prefs.bridge || {};
    if (bridge[platform]) bridge[platform].enabled = false;
    prefs.bridge = bridge;
    engine.savePreferences(prefs);

    debugLog()?.log("api", `POST /api/bridge/stop agent=${agent.id} platform=${platform}`);
    return c.json({ ok: true });
  });

  /** 获取最近消息日志（实时内存缓冲） */
  route.get("/bridge/messages", async (c) => {
    const limit = parseInt(c.req.query("limit"), 10) || 50;
    const agent = resolveAgent(engine, c);
    return c.json({ messages: bridgeManager.getMessages(limit, agent.id) });
  });

  /** 获取 bridge session 列表 */
  route.get("/bridge/sessions", async (c) => {
    const platform = c.req.query("platform"); // optional filter
    const sessions = [];
    const seenKeys = new Set();
    const agents = engine.listAgents();
    const prefs = engine.getPreferences();
    const bridge = prefs.bridge || {};
    const ownerDict = bridge.owner || {};

    for (const ag of agents) {
      const index = engine.getBridgeIndex(ag.id);
      const bridgeDir = path.join(ag.sessionDir, "bridge");

      for (const [sessionKey, raw] of Object.entries(index)) {
        if (seenKeys.has(sessionKey)) continue;
        seenKeys.add(sessionKey);

        const entry = typeof raw === "string" ? { file: raw } : raw;
        const file = entry.file;
        if (!file) continue;

        const { platform: plat, chatType, chatId } = parseSessionKey(sessionKey);
        if (platform && plat !== platform) continue;

        let lastActive = null;
        const fp = path.join(bridgeDir, file);
        try {
          const stat = fs.statSync(fp);
          lastActive = stat.mtimeMs;
        } catch {}

        const ownerUserId = ownerDict[plat] || null;
        const isOwner = !!(entry.userId && ownerUserId && entry.userId === ownerUserId);

        // userMap 昵称映射：用 preferences.bridge 里的昵称替换 displayName
        const userMap = bridge[plat]?.userMap || {};
        const mappedName = chatId && userMap[chatId];
        const displayName = mappedName || entry.name || null;

        sessions.push({
          sessionKey, platform: plat, chatType, chatId, file, lastActive,
          displayName,
          avatarUrl: entry.avatarUrl || null,
          isOwner,
        });
      }
    }

    sessions.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
    return c.json({ sessions });
  });

  /** 读取指定 bridge session 的消息 */
  route.get("/bridge/sessions/:sessionKey/messages", async (c) => {
    const sessionKey = c.req.param("sessionKey");

    // 在所有 agents 中查找该 sessionKey 的消息文件
    let file = null;
    let bridgeDir = null;
    let agentPlatform = null;
    let sessionAgent = null;
    const agents = engine.listAgents();
    const prefs = engine.getPreferences();
    for (const ag of agents) {
      const agBridgeDir = path.join(engine.agentsDir, ag.id, "sessions", "bridge");
      const indexPath = path.join(agBridgeDir, "bridge-sessions.json");
      try {
        const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
        const raw = index[sessionKey];
        const f = typeof raw === "string" ? raw : raw?.file;
        if (f) { file = f; bridgeDir = agBridgeDir; agentPlatform = parseSessionKey(sessionKey).platform; sessionAgent = ag; break; }
      } catch { continue; }
    }

    if (!file || !bridgeDir) return c.json({ error: "session not found", messages: [] });

    const fp = path.resolve(bridgeDir, file);

    // 防止 path traversal
    if (!fp.startsWith(path.resolve(bridgeDir) + path.sep)) {
      return c.json({ error: "invalid session path", messages: [] });
    }

    try {
      const rawContent = fs.readFileSync(fp, "utf-8");
      const lines = rawContent.trim().split("\n").map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);

      const messages = [];
      for (const line of lines) {
        if (line.type !== "message") continue;
        const msg = line.message;
        if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;

        let textContent = "";
        let mediaCount = 0;
        if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b.type === "text" && b.text) textContent += b.text;
            if (b.type === "image") mediaCount++;
          }
        } else if (typeof msg.content === "string") {
          textContent = msg.content;
        }

        const hasMedia = mediaCount > 0;
        if (!textContent && !hasMedia) continue;

        // Strip redundant prefixes from user messages (accumulated from
        // bridge-manager timeTag, guest-handler "[来自...]", senderName prefix)
        if (msg.role === "user") {
          let prev = "";
          while (textContent !== prev) {
            prev = textContent;
            textContent = textContent
              .replace(/^\[\d{2}-\d{2} \d{2}:\d{2}\]\s*/, "")       // [04-21 16:59]
              .replace(/^\[来自 [^\]]+\]\s*/, "")                    // [来自 blankguan]
              .replace(/^\[[^\]]+\]\s*/, "");                        // [any tag]
          }
        }

        // 从 JSONL 的 userId 字段 + userMap 提取 senderName
        let senderName = null;
        const msgUserId = msg.userId || null;
        if (msgUserId) {
          const userMap = prefs.bridge?.[agentPlatform]?.userMap || {};
          senderName = userMap[msgUserId] || null;
        }

        messages.push({
          role: msg.role,
          content: textContent || (hasMedia ? `[图片 x${mediaCount}]` : ""),
          hasMedia,
          mediaCount,
          ts: line.timestamp || null,
          senderName,
          userId: msgUserId,
        });
      }

      // 合并内存中的消息（bridgeManager._messageLog 里有尚未写入 JSONL 的消息，
      // 比如刚收到的用户消息，要等 LLM 回复后才持久化。这里补齐，让前端立即看到。）
      try {
        const memMessages = bridgeManager.getMessages(200);
        for (const mem of memMessages) {
          if (mem.sessionKey !== sessionKey) continue;
          // 去重：如果 ts 和 content 都匹配已有消息，跳过
          const already = messages.find(m => m.ts === mem.ts && m.content === mem.text);
          if (already) continue;
          messages.push({
            role: mem.direction === 'out' ? 'assistant' : 'user',
            content: mem.text || '',
            hasMedia: false,
            mediaCount: 0,
            ts: mem.ts || null,
            senderName: mem.direction === 'out' ? null : (mem.sender || null),
            userId: null,
          });
        }
        // 按 ts 排序
        messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      } catch (e) {
        console.warn('[bridge] merge in-memory messages failed:', e.message);
      }

      return c.json({ messages });
    } catch (err) {
      return c.json({ error: err.message, messages: [] });
    }
  });

  /** 重置 bridge session（清除上下文，下次消息新建 session） */
  route.post("/bridge/sessions/:sessionKey/reset", async (c) => {
    const sessionKey = c.req.param("sessionKey");
    const agent = resolveAgentStrict(engine, c);
    const agentId = agent.id;
    const index = engine.getBridgeIndex(agentId);
    const raw = index[sessionKey];
    if (!raw) return c.json({ ok: false, error: "session not found" });

    // 保留元数据（name, avatarUrl），只删 file 引用
    const entry = typeof raw === "string" ? {} : { ...raw };
    delete entry.file;
    index[sessionKey] = entry;
    engine.saveBridgeIndex(index, agentId);

    return c.json({ ok: true });
  });

  /** 发送媒体到 bridge 平台（桌面端推送文件） */
  route.post("/bridge/send-media", async (c) => {
    const body = await safeJson(c);
    const { platform, chatId, filePath } = body;
    if (!platform || !chatId || !filePath) {
      return c.json({ error: "platform, chatId, filePath required" }, 400);
    }

    const agent = resolveAgentStrict(engine, c);

    // 路径安全检查（对齐 fs.js 的 getAllowedRoots 逻辑）
    const hanaHome = path.resolve(engine.hanakoHome);
    const allowedRoots = [hanaHome];
    const deskHome = agent.deskManager?.homePath;
    if (deskHome) allowedRoots.push(path.resolve(deskHome));

    // 先检查文件是否存在
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      return c.json({ error: "file not found" }, 404);
    }

    // 用 realpathSync 解析 symlink，防止 symlink 绕过白名单
    let realPath;
    try { realPath = fs.realpathSync(resolved); }
    catch { return c.json({ error: "file not found" }, 404); }

    const isSafe = allowedRoots.some(root =>
      realPath === root || realPath.startsWith(root + path.sep)
    );
    if (!isSafe) {
      return c.json({ error: "path outside allowed roots" }, 403);
    }

    // Fix 3: 文件大小保护（50MB 上限，避免同步读大文件卡事件循环）
    const MAX_MEDIA_SIZE = 50 * 1024 * 1024;
    try {
      const stat = fs.statSync(realPath);
      if (stat.size > MAX_MEDIA_SIZE) {
        return c.json({ error: `file too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 50MB)` }, 413);
      }
    } catch { return c.json({ error: "file not found" }, 404); }

    try {
      await bridgeManager.sendMediaFile(platform, chatId, realPath, agent.id);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  /** 测试凭证（不启动轮询） */
  route.post("/bridge/test", async (c) => {
    const body = await safeJson(c);
    const { platform, credentials } = body;
    if (!platform || !credentials) {
      return c.json({ error: "platform and credentials required" }, 400);
    }

    if (!KNOWN_PLATFORMS.includes(platform)) {
      return c.json({ error: "unknown platform" }, 400);
    }

    try {
      if (platform === "telegram") {
        const TelegramBot = (await import("node-telegram-bot-api")).default;
        const bot = new TelegramBot(credentials.token);
        const me = await bot.getMe();
        return c.json({ ok: true, info: { username: me.username, name: me.first_name } });
      } else if (platform === "feishu") {
        const resp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            app_id: credentials.appId,
            app_secret: credentials.appSecret,
          }),
        });
        const data = await resp.json();
        if (data.code === 0) {
          return c.json({ ok: true, info: { msg: t("error.tokenSuccess") } });
        }
        return c.json({ ok: false, error: data.msg || t("error.verifyFailed") });
      } else if (platform === "qq") {
        // v2 鉴权：appID + appSecret → access_token → /users/@me
        const tokenRes = await fetch("https://bots.qq.com/app/getAppAccessToken", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appId: credentials.appID, clientSecret: credentials.appSecret }),
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
          return c.json({ ok: false, error: tokenData.message || t("error.tokenFetchFailed") });
        }
        const meRes = await fetch("https://api.sgroup.qq.com/users/@me", {
          headers: { Authorization: `QQBot ${tokenData.access_token}` },
        });
        const me = await meRes.json();
        if (me.id) {
          return c.json({ ok: true, info: { username: me.username, name: me.username } });
        }
        return c.json({ ok: false, error: me.message || t("error.botInfoFailed") });
      }
      if (platform === "wechat") {
        // 用 getconfig 验证 token（不污染 cursor）
        const crypto = await import("node:crypto");
        const uin = Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
        const res = await fetch("https://ilinkai.weixin.qq.com/ilink/bot/getconfig", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "AuthorizationType": "ilink_bot_token",
            "Authorization": `Bearer ${credentials.botToken}`,
            "X-WECHAT-UIN": uin,
          },
          body: JSON.stringify({ base_info: { channel_version: "1.0.0" } }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json();
        if (data.ret && data.ret !== 0) {
          return c.json({ ok: false, error: data.errmsg || `errcode ${data.ret}` });
        }
        return c.json({ ok: true, info: { msg: "微信 iLink 连接成功" } });
      }
      if (platform === "workwechat") {
        if (!credentials.botId || !credentials.secret) {
          return c.json({ ok: false, error: "botId 和 secret 不能为空" });
        }
        try {
          const result = await new Promise((resolve) => {
            const reqId = `test_${Date.now()}`;
            const ws = new WebSocket("wss://openws.work.weixin.qq.com", [], { handshakeTimeout: 10_000 });
            let resolved = false;
            const done = (val) => {
              if (resolved) return;
              resolved = true;
              clearTimeout(timer);
              try { ws.terminate(); } catch {}
              resolve(val);
            };
            const timer = setTimeout(() => {
              done({ ok: false, error: "连接超时（10s）" });
            }, 10_000);
            ws.on("open", () => {
              const frame = JSON.stringify({
                cmd: "aibot_subscribe",
                headers: { req_id: reqId },
                body: { bot_id: credentials.botId, secret: credentials.secret },
              });
              ws.send(frame);
            });
            ws.on("message", (data) => {
              try {
                const msg = JSON.parse(data.toString());
                if (msg?.headers?.req_id === reqId) {
                  if (msg.errcode === 0) {
                    done({ ok: true, info: { msg: "订阅成功" } });
                  } else {
                    done({ ok: false, error: `errcode=${msg.errcode} ${msg.errmsg || ""}` });
                  }
                }
              } catch {
                done({ ok: false, error: `解析响应失败` });
              }
            });
            ws.on("error", (err) => {
              done({ ok: false, error: err.message });
            });
            ws.on("close", (code) => {
              if (!resolved) done({ ok: false, error: `连接关闭 code=${code}` });
            });
          });
          return c.json(result);
        } catch (err) {
          return c.json({ ok: false, error: err.message });
        }
      }
      return c.json({ ok: false, error: t("error.platformTestUnsupported") });
    } catch (err) {
      return c.json({ ok: false, error: err.message });
    }
  });

  /** 获取微信扫码登录二维码 */
  route.post("/bridge/wechat/qrcode", async (c) => {
    return c.json(await getWechatQrcode());
  });

  /** 轮询微信扫码状态 */
  route.post("/bridge/wechat/qrcode-status", async (c) => {
    const body = await safeJson(c);
    const { qrcodeId } = body;
    return c.json(await pollWechatQrcodeStatus(qrcodeId));
  });

  return route;
}
