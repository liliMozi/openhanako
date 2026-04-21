/**
 * web-fetch.js — web_fetch 自定义工具
 *
 * 让 agent 能抓取指定 URL 的内容并提取文本。
 * 流程：fetch → HTML → 提取正文文本（去标签）→ 截断返回
 *
 * 支持：HTML 页面、JSON API、纯文本
 */

import { Type } from "@sinclair/typebox";
import { lookup } from "dns/promises";
import { isIP } from "net";
import { t } from "../../server/i18n.js";

const MAX_CONTENT_LENGTH = 12000;  // 返回最大字符数
const FETCH_TIMEOUT = 15000;       // 15 秒超时
const MAX_REDIRECTS = 5;

const PRIVATE_IP_RANGES = [
  /^127\./, /^::1$/, /^0\.0\.0\.0$/, /^0:0:0:0:0:0:0:1$/,    // loopback
  /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,        // RFC 1918
  /^169\.254\./, /^fe80:/i,                                      // link-local
  /^fc00:/i, /^fd[0-9a-f]{2}:/i,                                // IPv6 ULA
];

async function isPrivateHost(hostname) {
  if (isIP(hostname)) return PRIVATE_IP_RANGES.some(r => r.test(hostname));
  try {
    // 检查所有解析到的 IP（防止部分 A/AAAA 记录指向内网）
    const results = await lookup(hostname, { all: true });
    if (results.length === 0) return true;
    return results.some(r => PRIVATE_IP_RANGES.some(pat => pat.test(r.address)));
  } catch { return true; }
}

/**
 * 简易 HTML → 文本：去标签、合并空白
 */
function htmlToText(html) {
  // 移除 script / style / head 内容
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "");

  // 块级标签换行
  text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote|section|article|header)[^>]*>/gi, "\n");

  // 保留链接文本和 href
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)");

  // 去掉剩余标签
  text = text.replace(/<[^>]+>/g, "");

  // HTML 实体
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

  // 合并空白
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

export function createWebFetchTool() {
  return {
    name: "web_fetch",
    label: t("toolDef.webFetch.label"),
    description: t("toolDef.webFetch.description"),
    parameters: Type.Object({
      url: Type.String({ description: t("toolDef.webFetch.urlDesc") }),
      maxLength: Type.Optional(
        Type.Number({ description: t("toolDef.webFetch.maxLenDesc", { max: MAX_CONTENT_LENGTH }), default: MAX_CONTENT_LENGTH })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const url = params.url?.trim();
      if (!url) {
        return {
          content: [{ type: "text", text: t("error.fetchEmptyUrl") }],
          details: {},
        };
      }

      // 基本 URL 校验
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          return {
            content: [{ type: "text", text: t("error.fetchHttpOnly") }],
            details: {},
          };
        }
      } catch {
        return {
          content: [{ type: "text", text: t("error.fetchInvalidUrl", { url }) }],
          details: {},
        };
      }

      try {
        // SSRF 防护：逐跳校验 hostname
        let currentUrl = url;
        let res;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          const hopParsed = new URL(currentUrl);
          if (await isPrivateHost(hopParsed.hostname)) {
            return {
              content: [{ type: "text", text: t("error.fetchSsrf", { host: hopParsed.hostname }) }],
              details: {},
            };
          }

          res = await fetch(currentUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; HanakoBot/1.0)",
              "Accept": "text/html,application/xhtml+xml,application/json,text/plain,*/*",
              "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            },
            redirect: "manual",
            signal: AbortSignal.timeout(FETCH_TIMEOUT),
          });

          if ([301, 302, 307, 308].includes(res.status)) {
            const location = res.headers.get("location");
            if (!location) break;
            currentUrl = new URL(location, currentUrl).href;
            continue;
          }
          break;
        }

        if (!res || [301, 302, 307, 308].includes(res.status)) {
          return {
            content: [{ type: "text", text: t("error.fetchRedirectLimit", { max: MAX_REDIRECTS }) }],
            details: {},
          };
        }

        if (!res.ok) {
          return {
            content: [{ type: "text", text: t("error.fetchHttpError", { status: res.status, statusText: res.statusText }) }],
            details: {},
          };
        }

        const contentType = res.headers.get("content-type") || "";
        const raw = await res.text();
        const maxLen = params.maxLength ?? MAX_CONTENT_LENGTH;

        let text;
        let format;

        if (contentType.includes("application/json")) {
          try {
            const obj = JSON.parse(raw);
            text = JSON.stringify(obj, null, 2);
          } catch {
            text = raw;
          }
          format = "json";
        } else if (contentType.includes("text/html")) {
          text = htmlToText(raw);
          format = "html→text";
        } else {
          text = raw;
          format = "text";
        }

        const truncated = text.length > maxLen;
        if (truncated) {
          text = text.slice(0, maxLen) + t("error.fetchTruncated", { len: text.length });
        }

        const finalUrl = new URL(currentUrl);
        const header = t("error.fetchSource", { host: finalUrl.hostname, path: finalUrl.pathname, format });

        return {
          content: [{ type: "text", text: header + text }],
          details: {},
        };
      } catch (err) {
        const msg = err.name === "TimeoutError"
          ? t("error.fetchTimeout", { sec: FETCH_TIMEOUT / 1000, url })
          : t("error.fetchError", { msg: err.message });
        return {
          content: [{ type: "text", text: msg }],
          details: {},
        };
      }
    },
  };
}
