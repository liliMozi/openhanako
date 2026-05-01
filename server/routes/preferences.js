/**
 * 全局偏好设置路由（跨 agent 共享）
 *
 * GET  /api/preferences/models  — 读取全局模型 + 搜索配置
 * PUT  /api/preferences/models  — 更新全局模型 + 搜索配置
 * GET  /api/preferences/computer-use  — 读取 Computer Use provider/approval 状态
 * PUT  /api/preferences/computer-use  — 更新 Computer Use 全局设置
 * POST /api/preferences/computer-use/request-permissions — 请求系统权限
 * POST /api/preferences/computer-use/approvals  — 批准 app
 * DELETE /api/preferences/computer-use/approvals  — 撤销批准
 */

import { Hono } from "hono";
import { emitAppEvent } from "../app-events.js";
import { safeJson } from "../hono-helpers.js";
import { debugLog } from "../../lib/debug-log.js";
import {
  normalizeSharedModelsPatch,
  sharedModelsPatchRequiresModelSync,
} from "../../core/config-coordinator.js";
import { modelSupportsImage } from "../../core/message-sanitizer.js";

export function createPreferencesRoute(engine) {
  const route = new Hono();

  // 读取全局模型 + 搜索配置
  route.get("/preferences/models", async (c) => {
    try {
      const models = engine.getSharedModels();
      const search = engine.getSearchConfig();
      const utilityApi = engine.getUtilityApi();

      return c.json({
        models,
        search: {
          provider: search.provider || "",
          api_key: search.api_key || "",
        },
        utility_api: {
          provider: utilityApi.provider || "",
          base_url: utilityApi.base_url || "",
          api_key: utilityApi.api_key || "",
        },
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 更新全局模型 + 搜索配置
  route.put("/preferences/models", async (c) => {
    try {
      const body = await safeJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }

      const sections = [];
      let needsModelSync = false;
      // 共享模型与辅助视觉开关
      if (body.models) {
        let modelsPatch;
        try {
          modelsPatch = normalizeSharedModelsPatch(body.models);
        } catch (err) {
          return c.json({ error: err.message }, 400);
        }
        if (modelsPatch.vision) {
          let resolved;
          try {
            resolved = engine.resolveModelWithCredentials(modelsPatch.vision);
          } catch (err) {
            return c.json({ error: err.message }, 400);
          }
          if (!modelSupportsImage(resolved?.model)) {
            return c.json({ error: "vision model must support image input" }, 400);
          }
        }
        engine.setSharedModels(modelsPatch);
        sections.push("models");
        needsModelSync = sharedModelsPatchRequiresModelSync(modelsPatch);
      }

      // 搜索配置
      if (body.search) {
        engine.setSearchConfig(body.search);
        sections.push("search");
      }

      // utility API 配置
      if (body.utility_api) {
        engine.setUtilityApi(body.utility_api);
        sections.push("utility_api");
      }

      if (needsModelSync) {
        await engine.syncModelsAndRefresh();
      }

      debugLog()?.log("api", `PUT /api/preferences/models sections=[${sections.join(",")}]`);
      if (sections.length > 0) {
        emitAppEvent(engine, "models-changed", { agentId: engine.currentAgentId || null });
      }
      return c.json({ ok: true });
    } catch (err) {
      debugLog()?.error("api", `PUT /api/preferences/models failed: ${err.message}`);
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/preferences/computer-use", async (c) => {
    try {
      const settings = engine.getComputerUseSettings();
      const status = await engine.getComputerHost?.()?.getStatus?.({}) || null;
      return c.json({
        settings,
        status,
        selectedProviderId: status?.selectedProviderId || null,
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/preferences/computer-use", async (c) => {
    try {
      const body = await safeJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const settings = engine.setComputerUseSettings(body.settings && typeof body.settings === "object" ? body.settings : body);
      debugLog()?.log("api", "PUT /api/preferences/computer-use");
      emitAppEvent(engine, "computer-use-settings-changed", { selectedProviderId: settings.provider_by_platform?.[process.platform] || null });
      return c.json({ ok: true, settings });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/preferences/computer-use/request-permissions", async (c) => {
    try {
      const body = await safeJson(c);
      const providerId = body && typeof body === "object" ? body.providerId || null : null;
      const result = await engine.getComputerHost?.()?.requestPermissions?.({}, providerId);
      emitAppEvent(engine, "computer-use-permissions-requested", { providerId: providerId || result?.providerId || null });
      return c.json({ ok: true, result });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/preferences/computer-use/approvals", async (c) => {
    try {
      const body = await safeJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const settings = engine.approveComputerUseApp(body);
      emitAppEvent(engine, "computer-use-settings-changed", { providerId: body.providerId || null, appId: body.appId || null });
      return c.json({ ok: true, settings });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.delete("/preferences/computer-use/approvals", async (c) => {
    try {
      const body = await safeJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const settings = engine.revokeComputerUseApp(body);
      emitAppEvent(engine, "computer-use-settings-changed", { providerId: body.providerId || null, appId: body.appId || null });
      return c.json({ ok: true, settings });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  return route;
}
