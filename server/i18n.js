/**
 * Server-side i18n — 从 locale JSON 加载翻译
 */
import fs from "fs";
import path from "path";
import { fromRoot } from "../shared/hana-root.js";

const localesDir = fromRoot("desktop", "src", "locales");

let data = {};
let currentLocale = "zh";

/**
 * locale 字符串 → JSON 文件名 key
 */
function resolveKey(locale) {
  if (!locale) return "zh";
  if (locale === "zh-TW" || locale === "zh-Hant") return "zh-TW";
  if (locale.startsWith("zh")) return "zh";
  if (locale.startsWith("ja")) return "ja";
  if (locale.startsWith("ko")) return "ko";
  return "en";
}

/**
 * 加载语言包
 * @param {string} locale  config.yaml 里的 locale 值，如 "zh-CN" / "zh-TW" / "ja" / "ko" / "en"
 */
export function loadLocale(locale) {
  const key = resolveKey(locale);
  currentLocale = key;
  try {
    const file = path.join(localesDir, `${key}.json`);
    data = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    console.error(`[i18n] Failed to load locale "${key}":`, err.message);
    if (key !== "en") {
      try {
        data = JSON.parse(fs.readFileSync(path.join(localesDir, "en.json"), "utf-8"));
      } catch { data = {}; }
    } else {
      data = {};
    }
  }
}

/**
 * 按 dot path 取值
 */
function get(p) {
  return p.split(".").reduce((obj, k) => obj?.[k], data);
}

/**
 * 翻译
 * @param {string} path
 * @param {object} [vars]  占位符变量
 * @returns {string}
 */
export function t(path, vars) {
  let val = get(path);
  if (val === undefined || val === null) return path;
  if (typeof val !== "string") return val;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      val = val.replaceAll(`{${k}}`, String(v));
    }
  }
  return val;
}

export function getLocale() {
  return currentLocale;
}
