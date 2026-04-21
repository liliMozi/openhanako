/**
 * hana-root.js — 项目根目录解析
 *
 * esbuild bundle 后 import.meta.url 指向 bundle 文件，
 * 不能再用来推算源码相对路径。统一用此模块获取项目根。
 *
 * 优先级：HANA_ROOT 环境变量 > 自动推算
 */
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录（包含 package.json 的目录） */
export const HANA_ROOT = process.env.HANA_ROOT || path.resolve(__dirname, "..");

/**
 * 从项目根解析路径
 * @param {...string} segments - 路径片段
 * @returns {string} 绝对路径
 */
export function fromRoot(...segments) {
  return path.join(HANA_ROOT, ...segments);
}
