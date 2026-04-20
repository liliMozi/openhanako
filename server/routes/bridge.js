/**
 * bridge.js — 外部平台接入 REST API
 *
 * 管理 Telegram / 飞书 / QQ 等外部消息平台的连接。
 */

import fs from "fs";
import path from "path";
import WebSocket from "ws";
import { debugLog } from "../../lib/debug-log.js";
import { parseSessionKey, collectKnownUsers, KNOWN_PLATFORMS, isValidInstanceId, getBasePlatform } from "../../lib/bridge/session-key.js";

export default async function bridgeRoute(app, { engine, bridgeManager }) {

  /** 获取所有平台连接状态（支持多实例） */
  app.get("/api/bridge/status", async () => {
    const prefs = engine.getPreferences();
    const bridge = prefs.bridge || {};
    const live = bridgeManager.getStatus();

    // 凭证做遮掩后返回，供前端回显
    const mask = (s) => s.length <= 8 ? "••••" : s.slice(0, 4) + "••••" + s.slice(-4);

    // 收集所有实例（从 preferences 和 live 状态合并）
    const instanceIds = new Set();
    for (const key of Object.keys(bridge)) {
      if (key === "owner" || key === "readOnly") continue;
      if (isValidInstanceId(key)) instanceIds.add(key);
    }
    for (const key of Object.keys(live)) {
      instanceIds.add(key);
    }

    // 构建实例状态数组
    const instances = {};
    for (const id of instanceIds) {
      const cfg = bridge[id] || {};
      const base = getBasePlatform(id);
      const liveEntry = live[id] || {};

      if (base === "telegram") {
        const token = cfg.token || "";
        instances[id] = {
          basePlatform: base,
          configured: !!token,
          enabled: !!cfg.enabled,
          status: liveEntry.status || "disconnected",
          error: liveEntry.error || null,
          tokenMasked: token ? mask(token) : "",
          label: cfg.label || null,
        };
      } else if (base === "feishu") {
        const appId = cfg.appId || "";
        const appSecret = cfg.appSecret || "";
        instances[id] = {
          basePlatform: base,
          configured: !!(appId && appSecret),
          enabled: !!cfg.enabled,
          status: liveEntry.status || "disconnected",
          error: liveEntry.error || null,
          appId,
          appSecretMasked: appSecret ? mask(appSecret) : "",
          label: cfg.label || null,
          role: cfg.role || "ai",
        };
      } else if (base === "qq") {
        const secret = cfg.appSecret || cfg.token;
        instances[id] = {
          basePlatform: base,
          configured: !!(cfg.appID && secret),
          enabled: !!cfg.enabled,
          status: liveEntry.status || "disconnected",
          error: liveEntry.error || null,
          appID: cfg.appID || "",
          appSecretMasked: secret ? mask(secret) : "",
          label: cfg.label || null,
        };
      } else if (base === "wechat") {
        const token = cfg.token || "";
        instances[id] = {
          basePlatform: base,
          configured: !!token,
          enabled: !!cfg.enabled,
          status: liveEntry.status || "disconnected",
          error: liveEntry.error || null,
          tokenMasked: token ? mask(token) : "",
          baseUrl: cfg.baseUrl || "",
          label: cfg.label || null,
        };
      } else if (base === "workwechat") {
        const botId = cfg.botId || "";
        const secret = cfg.secret || "";
        instances[id] = {
          basePlatform: base,
          configured: !!(botId && secret),
          enabled: !!cfg.enabled,
          status: liveEntry.status || "disconnected",
          error: liveEntry.error || null,
          botId,
          secretMasked: secret ? mask(secret) : "",
          label: cfg.label || null,
          userMap: cfg.userMap || {},
        };
      }
    }

    // 兼容旧格式：保留顶层 telegram/feishu/qq 快捷引用（指向默认实例）
    const tgDef = instances["telegram"] || {};
    const fsDef = instances["feishu"] || {};
    const qqDef = instances["qq"] || {};
    const wxDef = instances["wechat"] || {};
    const wcDef = instances["workwechat"] || {};

    return {
      telegram: tgDef,
      feishu: fsDef,
      qq: qqDef,
      wechat: wxDef,
      workwechat: wcDef,
      instances,
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

  /** 保存凭证 + 启停平台（支持多实例 ID，如 "feishu:2"） */
  app.post("/api/bridge/config", async (req, reply) => {
    const { platform, credentials, enabled, label } = req.body || {};
    if (!platform || !isValidInstanceId(platform)) {
      reply.code(400);
      return { error: "invalid platform or instance id" };
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

    // 更新标签（用于 UI 显示，如"Hanako 飞书"、"Owner 飞书"）
    if (typeof label === "string") {
      prefs.bridge[platform].label = label;
    }

    // 更新角色（"ai" = Hanako AI 自动回复, "owner" = 桌面端 Owner 转发通道）
    if (typeof req.body?.role === "string" && ["ai", "owner"].includes(req.body.role)) {
      prefs.bridge[platform].role = req.body.role;
    }

    // 更新用户昵称映射（企业微信等）
    if (typeof req.body?.userMap === "object" && req.body.userMap !== null) {
      prefs.bridge[platform].userMap = req.body.userMap;
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

  /** 停止指定平台实例 */
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

  /** 获取 bridge session 列表（跨所有 agents） */
  app.get("/api/bridge/sessions", async (req) => {
    const platform = req.query?.platform; // optional filter
    const prefs = engine.getPreferences();
    const owner = prefs.bridge?.owner || {};
    const sessions = [];
    const seenKeys = new Set();

    const agents = engine.listAgents();
    for (const ag of agents) {
      const bridgeDir = path.join(engine.agentsDir, ag.id, "sessions", "bridge");
      const indexPath = path.join(bridgeDir, "bridge-sessions.json");
      let index;
      try { index = JSON.parse(fs.readFileSync(indexPath, "utf-8")); } catch { continue; }

      for (const [sessionKey, raw] of Object.entries(index)) {
        if (seenKeys.has(sessionKey)) continue;
        seenKeys.add(sessionKey);

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
    }

    // 按最后活跃时间排序
    sessions.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
    return { sessions };
  });

  /** 读取指定 bridge session 的消息（跨所有 agents 查找） */
  app.get("/api/bridge/sessions/:sessionKey/messages", async (req) => {
    const { sessionKey } = req.params;

    // 在所有 agents 中查找该 sessionKey 的消息文件
    let file = null;
    let bridgeDir = null;
    const agents = engine.listAgents();
    for (const ag of agents) {
      const agBridgeDir = path.join(engine.agentsDir, ag.id, "sessions", "bridge");
      const indexPath = path.join(agBridgeDir, "bridge-sessions.json");
      try {
        const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
        const raw = index[sessionKey];
        const f = typeof raw === "string" ? raw : raw?.file;
        if (f) { file = f; bridgeDir = agBridgeDir; break; }
      } catch { continue; }
    }

    if (!file || !bridgeDir) return { error: "session not found", messages: [] };

    const fp = path.resolve(bridgeDir, file);

    // 防止 path traversal
    if (!fp.startsWith(path.resolve(bridgeDir) + path.sep)) {
      return { error: "invalid session path", messages: [] };
    }

    // 获取 userMap（用于 senderName 映射）
    const prefs = engine.getPreferences();
    const { platform: rawPlatform } = parseSessionKey(sessionKey);
    const userMap = prefs.bridge?.[rawPlatform]?.userMap || {};

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

        // 从 JSONL 的 userId 字段 + userMap 提取 senderName
        const msgUserId = msg.userId || null;
        let senderName = null;
        if (msgUserId) {
          senderName = userMap[msgUserId] || null;
        }
        // 回退：没有 userId/userMap 时，从内容前缀解析
        if (!senderName) {
          const laiPrefix = content.match(/^\[来自\s+([^\]]+)\]\s*/);
          if (laiPrefix) {
            senderName = laiPrefix[1];
          }
        }

        messages.push({ role: msg.role, content, senderName, timestamp: line.timestamp || null, userId: msgUserId });
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

  /** 从桌面端发送消息到 bridge session（接管模式） */
  app.post("/api/bridge/sessions/:sessionKey/send", async (req, reply) => {
    const { sessionKey } = req.params;
    const { text } = req.body || {};
    if (!text) {
      reply.code(400);
      return { error: "text required" };
    }

    const result = await bridgeManager.sendToSession(sessionKey, text);
    if (!result.ok) {
      reply.code(500);
    }
    return result;
  });

  /** 删除飞书等多实例配置 */
  app.post("/api/bridge/delete-instance", async (req, reply) => {
    const { instanceId } = req.body || {};
    if (!instanceId || !isValidInstanceId(instanceId)) {
      reply.code(400);
      return { error: "invalid instance id" };
    }
    // 不允许删除基础平台的默认实例（如 "feishu"），只能删多实例后缀的
    if (!instanceId.includes(":")) {
      reply.code(400);
      return { error: "cannot delete default instance, use disable instead" };
    }

    // 先停止
    bridgeManager.stopPlatform(instanceId);

    // 从 preferences 中删除
    const prefs = engine.getPreferences();
    if (prefs.bridge?.[instanceId]) {
      delete prefs.bridge[instanceId];
      engine.savePreferences(prefs);
    }

    debugLog()?.log("api", `POST /api/bridge/delete-instance instanceId=${instanceId}`);
    return { ok: true };
  });

  /** 测试凭证（不启动轮询） */
  app.post("/api/bridge/test", async (req, reply) => {
    const { platform, credentials } = req.body || {};
    if (!platform || !credentials) {
      reply.code(400);
      return { error: "platform and credentials required" };
    }

    // 支持实例 ID（如 "feishu:2"），提取基础平台名用于测试
    const basePlatform = getBasePlatform(platform);
    if (!KNOWN_PLATFORMS.includes(basePlatform)) {
      reply.code(400);
      return { error: "unknown platform" };
    }

    try {
      if (basePlatform === "telegram") {
        const TelegramBot = (await import("node-telegram-bot-api")).default;
        const bot = new TelegramBot(credentials.token);
        const me = await bot.getMe();
        return { ok: true, info: { username: me.username, name: me.first_name } };
      } else if (basePlatform === "feishu") {
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
      } else if (basePlatform === "qq") {
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
      } else if (basePlatform === "workwechat") {
        if (!credentials.botId || !credentials.secret) {
          return { ok: false, error: "botId 和 secret 不能为空" };
        }
        console.log(`[bridge test] workwechat testing botId=${credentials.botId}`);
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
              console.log(`[bridge test] workwechat resolved:`, val);
              resolve(val);
            };
            const timer = setTimeout(() => {
              console.log(`[bridge test] workwechat timeout after 10s`);
              done({ ok: false, error: "连接超时（10s）" });
            }, 10_000);

            ws.on("open", () => {
              console.log(`[bridge test] workwechat WS open, sending subscribe...`);
              const frame = JSON.stringify({
                cmd: "aibot_subscribe",
                headers: { req_id: reqId },
                body: { bot_id: credentials.botId, secret: credentials.secret },
              });
              console.log(`[bridge test] workwechat sending frame: ${frame.slice(0, 120)}...`);
              ws.send(frame);
            });

            ws.on("message", (data) => {
              try {
                const msg = JSON.parse(data.toString());
                console.log(`[bridge test] workwechat received:`, data.toString().slice(0, 120));
                if (msg?.headers?.req_id === reqId) {
                  if (msg.errcode === 0) {
                    done({ ok: true, info: { msg: "订阅成功" } });
                  } else {
                    done({ ok: false, error: `errcode=${msg.errcode} ${msg.errmsg || ""}` });
                  }
                }
              } catch (err) {
                console.error(`[bridge test] workwechat parse error:`, err.message);
                done({ ok: false, error: `解析响应失败: ${err.message}` });
              }
            });

            ws.on("error", (err) => {
              console.error(`[bridge test] workwechat WS error:`, err.message);
              done({ ok: false, error: err.message });
            });
            ws.on("close", (code, reason) => {
              console.log(`[bridge test] workwechat WS closed: code=${code} reason=${reason || ""}`);
              if (!resolved) done({ ok: false, error: `连接关闭 code=${code}` });
            });
          });
          return result;
        } catch (err) {
          console.error(`[bridge test] workwechat error:`, err.message);
          return { ok: false, error: err.message };
        }
      }
      return { ok: false, error: "该平台暂不支持测试" };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── 微信 ClawBot 扫码登录 API ─────────────────────────────

  /** 发起微信扫码登录：获取二维码 */
  app.post("/api/bridge/wechat-login-start", async () => {
    const { startWechatLogin } = await import("../../lib/bridge/wechat-adapter.js");
    const result = await startWechatLogin();
    return result;
  });

  /** 轮询微信扫码结果（长轮询） */
  app.post("/api/bridge/wechat-login-poll", async (req) => {
    const { qrcode, timeoutMs } = req.body || {};
    if (!qrcode) {
      return { connected: false, message: "qrcode required" };
    }
    const { pollWechatLogin } = await import("../../lib/bridge/wechat-adapter.js");
    const result = await pollWechatLogin({ qrcode, timeoutMs: timeoutMs || 120_000 });

    // 登录成功：自动保存凭证并启动适配器
    if (result.connected && result.botToken) {
      const prefs = engine.getPreferences();
      if (!prefs.bridge) prefs.bridge = {};
      if (!prefs.bridge.wechat) prefs.bridge.wechat = {};
      prefs.bridge.wechat.token = result.botToken;
      if (result.baseUrl) prefs.bridge.wechat.baseUrl = result.baseUrl;
      prefs.bridge.wechat.enabled = true;
      prefs.bridge.wechat.accountId = result.accountId || null;
      prefs.bridge.wechat.userId = result.userId || null;
      engine.savePreferences(prefs);

      // 自动启动
      bridgeManager.startPlatformFromConfig("wechat", prefs.bridge.wechat);
      debugLog()?.log("api", `wechat login success, adapter started`);
    }

    return result;
  });
}
