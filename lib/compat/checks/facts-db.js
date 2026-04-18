/**
 * facts-db.js — facts.db 健康检查
 *
 * 尝试打开 facts.db 并执行简单查询。
 * 如果打不开或表结构损坏，备份原文件并让 FactStore 重建空库。
 */

import fs from "fs";
import path from "path";
import { t } from "../../../server/i18n.js";

export async function checkFactsDb({ agentDir, log }) {
  const dbPath = path.join(agentDir, "memory", "facts.db");
  if (!fs.existsSync(dbPath)) return; // 新 agent，没有 db 很正常

  let Database;
  try {
    Database = (await import("better-sqlite3")).default;
  } catch {
    return; // Electron 环境外可能加载不了 native module，跳过
  }

  try {
    const db = new Database(dbPath, { readonly: true });
    // 验证核心表存在且可查询
    db.prepare("SELECT COUNT(*) FROM facts").get();
    db.close();
  } catch (err) {
    // 数据库损坏，备份后让 FactStore 重建
    const backupPath = dbPath + `.bak-${Date.now()}`;
    try {
      fs.renameSync(dbPath, backupPath);
      // 同时备份 WAL/SHM 文件
      for (const ext of ["-wal", "-shm"]) {
        const walPath = dbPath + ext;
        if (fs.existsSync(walPath)) {
          fs.renameSync(walPath, backupPath + ext);
        }
      }
    } catch {}

    (log || console.log)(`  [compat] facts.db 损坏 (${err.message})，已备份到 ${path.basename(backupPath)}`);
    return { fixed: true, message: t("error.compatFactsCorrupted") };
  }
}
