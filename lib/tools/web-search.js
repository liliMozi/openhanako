/**
 * web-search.js — web_search 自定义工具
 *
 * 对外暴露一个统一的 web_search tool，只使用显式配置的 provider。
 *
 * 统一返回格式：[{ title, url, snippet }]
 */

import { Type } from "@sinclair/typebox";
import { loadConfig } from "../memory/config-loader.js";

let _configPath = null;
let _searchConfigResolver = null;

export function initWebSearch(configPath, opts = {}) {
  _configPath = configPath;
  if (opts.searchConfigResolver) _searchConfigResolver = opts.searchConfigResolver;
}

// ════════════════════════════════════════
// Provider: Tavily
// ════════════════════════════════════════

async function searchTavily(query, maxResults, apiKey) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: "basic",
    }),
  });

  if (!res.ok) throw new Error(`Tavily API ${res.status}`);
  const data = await res.json();

  return (data.results || []).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.content || "",
  }));
}

// ════════════════════════════════════════
// Provider: Serper (Google)
// ════════════════════════════════════════

async function searchSerper(query, maxResults, apiKey) {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify({ q: query, num: maxResults }),
  });

  if (!res.ok) throw new Error(`Serper API ${res.status}`);
  const data = await res.json();

  return (data.organic || []).slice(0, maxResults).map((r) => ({
    title: r.title || "",
    url: r.link || "",
    snippet: r.snippet || "",
  }));
}

// ════════════════════════════════════════
// Provider: Brave Search
// ════════════════════════════════════════

async function searchBrave(query, maxResults, apiKey) {
  const params = new URLSearchParams({ q: query, count: maxResults });
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!res.ok) throw new Error(`Brave API ${res.status}`);
  const data = await res.json();

  return (data.web?.results || []).slice(0, maxResults).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.description || "",
  }));
}

const PROVIDERS = {
  tavily: searchTavily,
  serper: searchSerper,
  brave: searchBrave,
};

/**
 * 验证搜索 API key 是否有效
 * @param {string} provider - tavily / serper / brave
 * @param {string} apiKey - 要验证的 key
 * @returns {Promise<boolean>}
 */
export async function verifySearchKey(provider, apiKey) {
  const fn = PROVIDERS[provider];
  if (!fn) throw new Error(`Unknown provider: ${provider}`);
  // 用一个简短查询测试 key 是否可用
  await fn("test", 1, apiKey);
  return true;
}

async function doSearch(query, maxResults) {
  // 优先从全局 resolver 获取搜索配置，否则从 agent config 读取
  let provider = "";
  let apiKey = "";
  if (_searchConfigResolver) {
    const resolved = _searchConfigResolver();
    provider = resolved.provider || "";
    apiKey = resolved.api_key || "";
  }
  if (!provider || !apiKey) {
    const cfg = loadConfig(_configPath);
    const searchCfg = cfg.search || {};
    if (!provider) provider = searchCfg.provider || "";
    if (!apiKey) apiKey = searchCfg.api_key || "";
  }

  if (!provider) {
    throw new Error("未配置搜索 provider");
  }
  if (!apiKey) {
    throw new Error(`搜索 provider "${provider}" 缺少 API Key`);
  }
  if (!PROVIDERS[provider]) {
    throw new Error(`未知搜索 provider: ${provider}`);
  }

  try {
    return {
      results: await PROVIDERS[provider](query, maxResults, apiKey),
      provider,
    };
  } catch (err) {
    throw new Error(`搜索失败: ${err.message}`);
  }
}

// ════════════════════════════════════════
// Tool 定义
// ════════════════════════════════════════

export function createWebSearchTool() {
  return {
    name: "web_search",
    label: "搜索网页",
    description:
      "搜索互联网获取实时信息。当你需要查找最新资讯、技术文档、" +
      "新闻事件、或任何记忆中没有的外部知识时使用。",
    parameters: Type.Object({
      query: Type.String({ description: "搜索关键词" }),
      maxResults: Type.Optional(
        Type.Number({ description: "返回结果数量，默认 5", default: 5 })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const query = params.query?.trim();
      if (!query) {
        return {
          content: [{ type: "text", text: "请提供搜索关键词。" }],
          details: {},
        };
      }

      try {
        const { results, provider } = await doSearch(query, params.maxResults ?? 5);

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `没有找到相关结果。(via ${provider})` }],
            details: {},
          };
        }

        const formatted = results
          .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
          .join("\n\n");

        return {
          content: [{ type: "text", text: `搜索结果 (via ${provider}):\n\n${formatted}` }],
          details: {},
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `搜索出错: ${err.message}` }],
          details: {},
        };
      }
    },
  };
}
