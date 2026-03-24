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

export function createBridgeRoute(engine, bridgeManager) {
  const route = new Hono();

  /** 获取所有平台连接状态 */
  route.get("/bridge/status", async (c) => {
    const prefs = engine.getPreferences();
    const bridge = prefs.bridge || {};
    const live = bridgeManager.getStatus();

    // 凭证做遮掩后返回，供前端回显
    const tgToken = bridge.telegram?.token || "";
    const fsAppId = bridge.feishu?.appId || "";
    const fsAppSecret = bridge.feishu?.appSecret || "";
    const mask = (s) => s.length <= 8 ? "••••" : s.slice(0, 4) + "••••" + s.slice(-4);

    return c.json({
      telegram: {
        configured: !!tgToken,
        enabled: !!bridge.telegram?.enabled,
        status: live.telegram?.status || "disconnected",
        error: live.telegram?.error || null,
        tokenMasked: tgToken ? mask(tgToken) : "",
      },
      feishu: {
        configured: !!(fsAppId && fsAppSecret),
        enabled: !!bridge.feishu?.enabled,
        status: live.feishu?.status || "disconnected",
        error: live.feishu?.error || null,
        appId: fsAppId,
        appSecretMasked: fsAppSecret ? mask(fsAppSecret) : "",
      },
      qq: {
        configured: !!(bridge.qq?.appID && (bridge.qq?.appSecret || bridge.qq?.token)),
        enabled: !!bridge.qq?.enabled,
        status: live.qq?.status || "disconnected",
        error: live.qq?.error || null,
        appID: bridge.qq?.appID || "",
        appSecretMasked: (bridge.qq?.appSecret || bridge.qq?.token) ? mask(bridge.qq.appSecret || bridge.qq.token) : "",
      },
      wechat: {
        configured: !!bridge.wechat?.botToken,
        enabled: !!bridge.wechat?.enabled,
        status: live.wechat?.status || "disconnected",
        error: live.wechat?.error || null,
        tokenMasked: bridge.wechat?.botToken ? mask(bridge.wechat.botToken) : "",
      },
      readOnly: !!bridge.readOnly,
      knownUsers: collectKnownUsers(engine.getBridgeIndex()),
      owner: bridge.owner || {},
    });
  });

  /** 设置 owner（哪个账号是你） */
  route.post("/bridge/owner", async (c) => {
    const body = await safeJson(c);
    const { platform, userId } = body;
    if (!platform || !KNOWN_PLATFORMS.includes(platform)) {
      return c.json({ ok: false, error: "invalid platform" });
    }
    const prefs = engine.getPreferences();
    if (!prefs.bridge) prefs.bridge = {};
    if (!prefs.bridge.owner) prefs.bridge.owner = {};
    if (userId) {
      prefs.bridge.owner[platform] = userId;
    } else {
      delete prefs.bridge.owner[platform];
    }
    engine.savePreferences(prefs);
    debugLog()?.log("api", `POST /api/bridge/owner platform=${platform} owner=${userId ? "[set]" : "[cleared]"}`);
    return c.json({ ok: true });
  });

  /** 保存凭证 + 启停平台 */
  route.post("/bridge/config", async (c) => {
    const body = await safeJson(c);
    const { platform, credentials, enabled } = body;
    if (!platform || !KNOWN_PLATFORMS.includes(platform)) {
      return c.json({ error: "invalid platform" }, 400);
    }

    const prefs = engine.getPreferences();
    if (!prefs.bridge) prefs.bridge = {};
    if (!prefs.bridge[platform]) prefs.bridge[platform] = {};

    // 更新凭证
    if (credentials) {
      Object.assign(prefs.bridge[platform], credentials);
    }

    // 更新启用状态
    if (typeof enabled === "boolean") {
      prefs.bridge[platform].enabled = enabled;
    }

    engine.savePreferences(prefs);

    // 启停（委托给 bridgeManager，由 ADAPTER_REGISTRY 决定凭证提取逻辑）
    const cfg = prefs.bridge[platform];
    if (cfg.enabled) {
      bridgeManager.startPlatformFromConfig(platform, cfg);
    } else {
      bridgeManager.stopPlatform(platform);
    }

    debugLog()?.log("api", `POST /api/bridge/config platform=${platform} enabled=${!!cfg.enabled}`);
    return c.json({ ok: true });
  });

  /** 更新 bridge 全局设置（readOnly 等） */
  route.post("/bridge/settings", async (c) => {
    const body = await safeJson(c);
    const { readOnly } = body;
    const prefs = engine.getPreferences();
    if (!prefs.bridge) prefs.bridge = {};
    if (typeof readOnly === "boolean") prefs.bridge.readOnly = readOnly;
    engine.savePreferences(prefs);
    debugLog()?.log("api", `POST /api/bridge/settings readOnly=${prefs.bridge.readOnly}`);
    return c.json({ ok: true });
  });

  /** 停止指定平台 */
  route.post("/bridge/stop", async (c) => {
    const body = await safeJson(c);
    const { platform } = body;
    if (!platform) {
      return c.json({ error: "platform required" }, 400);
    }

    bridgeManager.stopPlatform(platform);

    // 同步更新 preferences
    const prefs = engine.getPreferences();
    if (prefs.bridge?.[platform]) {
      prefs.bridge[platform].enabled = false;
      engine.savePreferences(prefs);
    }

    debugLog()?.log("api", `POST /api/bridge/stop platform=${platform}`);
    return c.json({ ok: true });
  });

  /** 获取最近消息日志（实时内存缓冲） */
  route.get("/bridge/messages", async (c) => {
    const limit = parseInt(c.req.query("limit")) || 50;
    return c.json({ messages: bridgeManager.getMessages(limit) });
  });

  /** 获取 bridge session 列表 */
  route.get("/bridge/sessions", async (c) => {
    const platform = c.req.query("platform"); // optional filter
    const index = engine.getBridgeIndex();
    const bridgeDir = path.join(engine.agent.sessionDir, "bridge");
    const prefs = engine.getPreferences();
    const owner = prefs.bridge?.owner || {};
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

      // isOwner 运行时计算：entry.userId 匹配 prefs.bridge.owner[platform]
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
    const index = engine.getBridgeIndex();
    const raw = index[sessionKey];
    const file = typeof raw === "string" ? raw : raw?.file;
    if (!file) return c.json({ error: "session not found", messages: [] });

    const bridgeDir = path.join(engine.agent.sessionDir, "bridge");
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
    const index = engine.getBridgeIndex();
    const raw = index[sessionKey];
    if (!raw) return c.json({ ok: false, error: "session not found" });

    // 保留元数据（name, avatarUrl），只删 file 引用
    const entry = typeof raw === "string" ? {} : { ...raw };
    delete entry.file;
    index[sessionKey] = entry;
    engine.saveBridgeIndex(index);

    return c.json({ ok: true });
  });

  /** 发送媒体到 bridge 平台（桌面端推送文件） */
  route.post("/bridge/send-media", async (c) => {
    const body = await safeJson(c);
    const { platform, chatId, filePath } = body;
    if (!platform || !chatId || !filePath) {
      return c.json({ error: "platform, chatId, filePath required" }, 400);
    }

    // 路径安全检查（对齐 fs.js 的 getAllowedRoots 逻辑）
    const hanaHome = path.resolve(engine.hanakoHome);
    const allowedRoots = [hanaHome];
    const deskHome = engine.agent?.deskManager?.homePath;
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
      await bridgeManager.sendMediaFile(platform, chatId, realPath);
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
