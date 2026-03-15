/**
 * script.js — 临时脚本 / profile 文件管理
 *
 * 把命令写进临时文件，避免 shell 字符串转义问题。
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

const PREFIX = ".hana-sandbox-";

function tempPath(ext) {
  const id = crypto.randomUUID().slice(0, 8);
  return path.join(os.tmpdir(), `${PREFIX}${id}${ext}`);
}

/**
 * 把 bash 命令写进临时脚本
 * @returns {{ scriptPath: string }}
 */
export function writeScript(command, cwd) {
  const scriptPath = tempPath(".sh");
  const content = `#!/bin/bash\ncd ${JSON.stringify(cwd)}\n${command}\n`;
  fs.writeFileSync(scriptPath, content, { mode: 0o700 });
  return { scriptPath };
}

/**
 * 把 Seatbelt profile 写进临时文件
 * @returns {{ profilePath: string }}
 */
export function writeProfile(profileContent) {
  const profilePath = tempPath(".sb");
  fs.writeFileSync(profilePath, profileContent, { mode: 0o600 });
  return { profilePath };
}

/**
 * 清理临时文件（静默忽略错误）
 */
export function cleanup(...paths) {
  for (const p of paths) {
    try { fs.unlinkSync(p); } catch {}
  }
}
