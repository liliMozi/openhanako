/**
 * 全局偏好设置路由（跨 agent 共享）
 *
 * GET  /api/preferences/models  — 读取全局模型 + 搜索配置
 * PUT  /api/preferences/models  — 更新全局模型 + 搜索配置
 */

import { debugLog } from "../../lib/debug-log.js";

export default async function preferencesRoute(app, { engine }) {

  const mask = (key) => {
    if (!key) return "";
    if (key.length < 8) return "****";
    return key.slice(0, 4) + "..." + key.slice(-4);
  };

  // 读取全局模型 + 搜索配置
  app.get("/api/preferences/models", async (req, reply) => {
    try {
      const models = engine.getSharedModels();
      const search = engine.getSearchConfig();
      const utilityApi = engine.getUtilityApi();

      return {
        models,
        search: {
          provider: search.provider || "",
          api_key: mask(search.api_key),
        },
        utility_api: {
          provider: utilityApi.provider || "",
          base_url: utilityApi.base_url || "",
          api_key: mask(utilityApi.api_key),
        },
      };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 更新全局模型 + 搜索配置
  app.put("/api/preferences/models", async (req, reply) => {
    try {
      const body = req.body;
      if (!body || typeof body !== "object") {
        reply.code(400);
        return { error: "invalid JSON body" };
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
      return { ok: true };
    } catch (err) {
      debugLog()?.error("api", `PUT /api/preferences/models failed: ${err.message}`);
      reply.code(500);
      return { error: err.message };
    }
  });
}
