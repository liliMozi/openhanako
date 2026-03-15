/**
 * desk-manager.js — Desk 目录管理
 *
 * Desk（書桌）是 agent 的工作台，存放：
 * - cron-jobs.json：定时任务
 * - cron-runs/：执行历史
 * - jian-registry.json：笺指纹注册表
 */

import fs from "fs";
import path from "path";

/**
 * 创建 Desk 管理器
 * @param {string} deskDir - desk 目录路径（{agentDir}/desk/）
 */
export function createDeskManager(deskDir) {
  const runsDir = path.join(deskDir, "cron-runs");

  return {
    /** desk 目录路径 */
    deskDir,

    /**
     * 确保 desk 目录结构存在
     */
    ensureDir() {
      fs.mkdirSync(deskDir, { recursive: true });
      fs.mkdirSync(runsDir, { recursive: true });
    },
  };
}
