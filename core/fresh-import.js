/**
 * ESM cache-busting import.
 * 每次调用都用唯一 timestamp query 绕过 Node.js 的模块缓存。
 * Windows 上必须先转为 file:// URL，否则 `C:\` 会被当作 protocol。
 * @param {string} filePath 绝对路径
 * @returns {Promise<any>} module namespace
 */
import { pathToFileURL } from "node:url";

let _counter = 0;
export async function freshImport(filePath) {
  const url = pathToFileURL(filePath);
  url.searchParams.set("t", `${Date.now()}-${_counter++}`);
  return import(url.href);
}
