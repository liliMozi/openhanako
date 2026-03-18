/**
 * bridge.js — 外部平台接入 REST API
 *
 * 管理 Telegram / 飞书 / QQ 等外部消息平台的连接。
 */

import fs from "fs";
import path from "path";
import { debugLog } from "../../lib/debug-log.js";
import { parseSessionKey, collectKnownUsers, KNOWN_PLATFORMS } from "../../lib/bridge/session-key.js";

export default async function bridgeRoute(app, { engine, bridgeManager }) {

  /** 获取所有平台连接状态 */
  app.get("/api/bridge/status", async () => {
    const prefs = engine.getPreferences();
    const bridge = prefs.bridge || {};
    const live = bridgeManager.getStatus();

    // 凭证做遮掩后返回，供前端回显
    const tgToken = bridge.telegram?.token || "";
    const fsAppId = bridge.feishu?.appId || "";
    const fsAppSecret = bridge.feishu?.appSecret || "";
    const mask = (s) => s.length <= 8 ? "••••" : s.slice(0, 4) + "••••" + s.slice(-4);

    return {
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
      readOnly: !!bridge.readOnly,
      knownUsers: collectKnownUsers(engine.getBridgeIndex()),
      owner: bridge.owner || {},
    };
  });

  /** 设置 owner（哪个账号是你） */
  app.post("/api/bridge/owner", async (req) => {
    const { platform, userId } = req.body || {};
    if (!platform || !KNOWN_PLATFORMS.includes(platform)) {
      return { ok: false, error: "invalid platform" };
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
    return { ok: true };
  });

  /** 保存凭证 + 启停平台 */
  app.post("/api/bridge/config", async (req, reply) => {
    const { platform, credentials, enabled } = req.body || {};
    if (!platform || !KNOWN_PLATFORMS.includes(platform)) {
      reply.code(400);
      return { error: "invalid platform" };
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
    return { ok: true };
  });

  /** 更新 bridge 全局设置（readOnly 等） */
  app.post("/api/bridge/settings", async (req) => {
    const { readOnly } = req.body || {};
    const prefs = engine.getPreferences();
    if (!prefs.bridge) prefs.bridge = {};
    if (typeof readOnly === "boolean") prefs.bridge.readOnly = readOnly;
    engine.savePreferences(prefs);
    debugLog()?.log("api", `POST /api/bridge/settings readOnly=${prefs.bridge.readOnly}`);
    return { ok: true };
  });

  /** 停止指定平台 */
  app.post("/api/bridge/stop", async (req, reply) => {
    const { platform } = req.body || {};
    if (!platform) {
      reply.code(400);
      return { error: "platform required" };
    }

    bridgeManager.stopPlatform(platform);

    // 同步更新 preferences
    const prefs = engine.getPreferences();
    if (prefs.bridge?.[platform]) {
      prefs.bridge[platform].enabled = false;
      engine.savePreferences(prefs);
    }

    debugLog()?.log("api", `POST /api/bridge/stop platform=${platform}`);
    return { ok: true };
  });

  /** 获取最近消息日志（实时内存缓冲） */
  app.get("/api/bridge/messages", async (req) => {
    const limit = parseInt(req.query?.limit) || 50;
    return { messages: bridgeManager.getMessages(limit) };
  });

  /** 获取 bridge session 列表 */
  app.get("/api/bridge/sessions", async (req) => {
    const platform = req.query?.platform; // optional filter
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
    return { sessions };
  });

  /** 读取指定 bridge session 的消息 */
  app.get("/api/bridge/sessions/:sessionKey/messages", async (req) => {
    const { sessionKey } = req.params;
    const index = engine.getBridgeIndex();
    const raw = index[sessionKey];
    const file = typeof raw === "string" ? raw : raw?.file;
    if (!file) return { error: "session not found", messages: [] };

    const bridgeDir = path.join(engine.agent.sessionDir, "bridge");
    const fp = path.resolve(bridgeDir, file);

    // 防止 path traversal
    if (!fp.startsWith(path.resolve(bridgeDir) + path.sep)) {
      return { error: "invalid session path", messages: [] };
    }

    try {
      const raw = fs.readFileSync(fp, "utf-8");
      const lines = raw.trim().split("\n").map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);

      const messages = [];
      for (const line of lines) {
        if (line.type !== "message") continue;
        const msg = line.message;
        if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;

        const content = Array.isArray(msg.content)
          ? msg.content.filter(b => b.type === "text" && b.text).map(b => b.text).join("")
          : (typeof msg.content === "string" ? msg.content : "");

        if (!content) continue;
        messages.push({ role: msg.role, content });
      }

      return { messages };
    } catch (err) {
      return { error: err.message, messages: [] };
    }
  });

  /** 重置 bridge session（清除上下文，下次消息新建 session） */
  app.post("/api/bridge/sessions/:sessionKey/reset", async (req) => {
    const { sessionKey } = req.params;
    const index = engine.getBridgeIndex();
    const raw = index[sessionKey];
    if (!raw) return { ok: false, error: "session not found" };

    // 保留元数据（name, avatarUrl），只删 file 引用
    const entry = typeof raw === "string" ? {} : { ...raw };
    delete entry.file;
    index[sessionKey] = entry;
    engine.saveBridgeIndex(index);

    return { ok: true };
  });

  /** 测试凭证（不启动轮询） */
  app.post("/api/bridge/test", async (req, reply) => {
    const { platform, credentials } = req.body || {};
    if (!platform || !credentials) {
      reply.code(400);
      return { error: "platform and credentials required" };
    }

    if (!KNOWN_PLATFORMS.includes(platform)) {
      reply.code(400);
      return { error: "unknown platform" };
    }

    try {
      if (platform === "telegram") {
        const TelegramBot = (await import("node-telegram-bot-api")).default;
        const bot = new TelegramBot(credentials.token);
        const me = await bot.getMe();
        return { ok: true, info: { username: me.username, name: me.first_name } };
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
          return { ok: true, info: { msg: "token 获取成功" } };
        }
        return { ok: false, error: data.msg || "验证失败" };
      } else if (platform === "qq") {
        // v2 鉴权：appID + appSecret → access_token → /users/@me
        const tokenRes = await fetch("https://bots.qq.com/app/getAppAccessToken", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appId: credentials.appID, clientSecret: credentials.appSecret }),
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
          return { ok: false, error: tokenData.message || "获取 access_token 失败" };
        }
        const meRes = await fetch("https://api.sgroup.qq.com/users/@me", {
          headers: { Authorization: `QQBot ${tokenData.access_token}` },
        });
        const me = await meRes.json();
        if (me.id) {
          return { ok: true, info: { username: me.username, name: me.username } };
        }
        return { ok: false, error: me.message || "获取机器人信息失败" };
      }
      return { ok: false, error: "该平台暂不支持测试" };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}
