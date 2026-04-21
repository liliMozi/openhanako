/**
 * dirs.js — 关键目录存在性检查
 *
 * 确保 agent 运行所需的子目录都存在，缺失则创建。
 */

import fs from "fs";
import path from "path";
import { t } from "../../../server/i18n.js";

const REQUIRED_AGENT_DIRS = [
  "memory",
  "memory/summaries",
  "sessions",
  "desk",
  "heartbeat",
  "book",
  "activity",
  "avatars",
];

export function checkDirs({ agentDir }) {
  let created = 0;

  for (const dir of REQUIRED_AGENT_DIRS) {
    const full = path.join(agentDir, dir);
    if (!fs.existsSync(full)) {
      fs.mkdirSync(full, { recursive: true });
      created++;
    }
  }

  if (created > 0) {
    return { fixed: true, message: t("error.compatDirCreated", { count: created }) };
  }
}
