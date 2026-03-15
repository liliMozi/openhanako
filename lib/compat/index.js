/**
 * compat/index.js — 启动兼容性检查 & 数据迁移
 *
 * 可扩展架构：每个检查项是一个函数，注册到 checks 数组。
 * agent.init() 时调用 runCompatChecks()，按序执行所有检查。
 *
 * 添加新检查：
 *   1. 在 checks/ 目录新建文件，导出 { name, run(ctx) }
 *   2. 在下方 checks 数组中 import 并注册
 *
 * 每个检查函数接收 ctx 对象：
 *   { agentDir, hanakoHome, log }
 * 返回值无要求，抛异常会被捕获并记录（不影响启动）。
 */

import { checkDirs } from "./checks/dirs.js";
import { checkFactsDb } from "./checks/facts-db.js";
import { checkConfigYaml } from "./checks/config-yaml.js";
const checks = [
  { name: "dirs", run: checkDirs },
  { name: "facts-db", run: checkFactsDb },
  { name: "config-yaml", run: checkConfigYaml },
];

/**
 * 执行所有兼容性检查
 *
 * @param {object} ctx
 * @param {string} ctx.agentDir    当前 agent 目录
 * @param {string} ctx.hanakoHome  ~/.hanako 根目录
 * @param {(msg: string) => void} [ctx.log]  日志函数
 */
export async function runCompatChecks(ctx) {
  const log = ctx.log || (() => {});
  let passed = 0;
  let fixed = 0;

  for (const check of checks) {
    try {
      const result = await check.run(ctx);
      if (result?.fixed) {
        fixed++;
        log(`  [compat] ${check.name}: ${result.message || "已修复"}`);
      }
      passed++;
    } catch (err) {
      console.error(`[compat] ${check.name} 检查失败（不影响启动）: ${err.message}`);
    }
  }

  if (fixed > 0) {
    log(`  [compat] ${passed} 项检查完成，${fixed} 项已修复`);
  }
}
