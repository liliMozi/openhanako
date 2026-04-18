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
import { parseSessionKey, collectKnownUsers, KNOWN_PLATFORMS } from "../../lib/bridge/session-key.js";
import { t } from "../i18n.js";
import { resolveAgent, resolveAgentStrict } from "../utils/resolve-agent.js";


export function createBridgeRoute(engine, bridgeManager) {
  const route = new Hono();

  /** 获取所有平台连接状态（从 agent.config.bridge 读取） */
  route.get("/bridge/status", async (c) => {
    const agent = resolveAgent(engine, c);
    const live = bridgeManager.getStatus(agent.id);
    const bridge = agent.config?.bridge || {};

    const platformStatus = (plat, cfg, extraFields) => {
      return {
        ...extraFields,
        enabled: !!cfg?.enabled,
        status: live[plat]?.status || "disconnected",
        error: live[plat]?.error || null,
        agentId: agent.id,
      };
    };

    const tgToken = bridge.telegram?.token || "";
    const fsAppId = bridge.feishu?.appId || "";
    const fsAppSecret = bridge.feishu?.appSecret || "";

    // Build per-platform owner dict from agent config
    const ownerDict = {};
    for (const plat of KNOWN_PLATFORMS) {
      const o = bridge[plat]?.owner;
      if (o) ownerDict[plat] = o;
    }

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
      readOnly: !!bridge.readOnly,
      knownUsers: collectKnownUsers(engine.getBridgeIndex(agent.id)),
      owner: ownerDict,
    });
  });

  /** 设置 owner（哪个账号是你）— 写入 agent.config.bridge */
  route.post("/bridge/owner", async (c) => {
    const body = await safeJson(c);
    const { platform, userId } = body;
    if (!platform || !KNOWN_PLATFORMS.includes(platform)) {
      return c.json({ ok: false, error: "invalid platform" });
    }
    const agent = resolveAgentStrict(engine, c);
    agent.updateConfig({ bridge: { [platform]: { owner: userId || null } } });
    debugLog()?.log("api", `POST /api/bridge/owner agent=${agent.id} platform=${platform} owner=${userId ? "[set]" : "[cleared]"}`);
    return c.json({ ok: true });
  });

  /** 保存凭证 + 启停平台（写入 agent.config.bridge） */
  route.post("/bridge/config", async (c) => {
    const body = await safeJson(c);
    const { platform, credentials, enabled } = body;
    if (!platform || !KNOWN_PLATFORMS.includes(platform)) {
      return c.json({ error: "invalid platform" }, 400);
    }

    const agent = resolveAgentStrict(engine, c);
    const agentId = agent.id;

    const bridgeCfg = agent.config?.bridge?.[platform] || {};
    const patch = { ...bridgeCfg };

    if (credentials) Object.assign(patch, credentials);
    if (typeof enabled === "boolean") patch.enabled = enabled;

    agent.updateConfig({ bridge: { [platform]: patch } });

    // Start/stop
    if (patch.enabled) {
      bridgeManager.startPlatformFromConfig(platform, patch, agentId);
    } else {
      bridgeManager.stopPlatform(platform, agentId);
    }

    debugLog()?.log("api", `POST /api/bridge/config agent=${agentId} platform=${platform} enabled=${!!patch.enabled}`);
    return c.json({ ok: true });
  });

  /** 更新 bridge 设置（readOnly 等）— per-agent */
  route.post("/bridge/settings", async (c) => {
    const body = await safeJson(c);
    const { readOnly } = body;
    const agent = resolveAgentStrict(engine, c);
    if (typeof readOnly === "boolean") {
      agent.updateConfig({ bridge: { readOnly } });
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
    bridgeManager.stopPlatform(platform, agent.id);
    agent.updateConfig({ bridge: { [platform]: { enabled: false } } });

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
    const agent = resolveAgent(engine, c);
    const index = engine.getBridgeIndex(agent.id);
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const agentBridge = agent.config?.bridge || {};
    const owner = {};
    for (const plat of KNOWN_PLATFORMS) {
      const o = agentBridge[plat]?.owner;
      if (o) owner[plat] = o;
    }
    const sessions = [];

    for (const [sessionKey, raw] of Object.entries(index)) {
      // 兼容旧格式（字符串）和新格式（对象）
      const entry = typeof raw === "string" ? { file: raw } : raw;
      const file = entry.file;
      if (!file) continue;

      // 解析 sessionKey → 平台 + 类型
      const { platform: plat, chatType, chatId } = parseSessionKey(sessionKey);

      // 按平台过滤
      if (platform && plat !== platform) continue;

      // 获取最后修改时间
      let lastActive = null;
      const fp = path.join(bridgeDir, file);
      try {
        const stat = fs.statSync(fp);
        lastActive = stat.mtimeMs;
      } catch {}

      // isOwner 运行时计算：per-agent owner dict
      const ownerUserId = owner[plat] || null;
      const isOwner = !!(entry.userId && ownerUserId && entry.userId === ownerUserId);

      sessions.push({
        sessionKey, platform: plat, chatType, chatId, file, lastActive,
        displayName: entry.name || null,
        avatarUrl: entry.avatarUrl || null,
        isOwner,
      });
    }

    // 按最后活跃时间排序
    sessions.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
    return c.json({ sessions });
  });

  /** 读取指定 bridge session 的消息 */
  route.get("/bridge/sessions/:sessionKey/messages", async (c) => {
    const sessionKey = c.req.param("sessionKey");
    const agent = resolveAgent(engine, c);
    const index = engine.getBridgeIndex(agent.id);
    const raw = index[sessionKey];
    const file = typeof raw === "string" ? raw : raw?.file;
    if (!file) return c.json({ error: "session not found", messages: [] });

    const bridgeDir = path.join(agent.sessionDir, "bridge");
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
        messages.push({
          role: msg.role,
          content: textContent || (hasMedia ? `[图片 x${mediaCount}]` : ""),
          hasMedia,
          mediaCount,
          ts: line.timestamp || null,
        });
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
