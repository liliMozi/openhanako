/**
 * 全局偏好设置路由（跨 agent 共享）
 *
 * GET  /api/preferences/models  — 读取全局模型 + 搜索配置
 * PUT  /api/preferences/models  — 更新全局模型 + 搜索配置
 */

import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { debugLog } from "../../lib/debug-log.js";

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
      // 共享模型（utility / utility_large）
      if (body.models) {
        engine.setSharedModels(body.models);
        sections.push("models");
        needsModelSync = true;
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
        try { await engine.syncModelsAndRefresh(); } catch (e) {
          debugLog()?.warn("api", `syncModelsAndRefresh after preferences change: ${e.message}`);
        }
      }

      debugLog()?.log("api", `PUT /api/preferences/models sections=[${sections.join(",")}]`);
      return c.json({ ok: true });
    } catch (err) {
      debugLog()?.error("api", `PUT /api/preferences/models failed: ${err.message}`);
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}
