/**
 * fs.js — 文件系统 API（Web 客户端用）
 *
 * Electron 环境下这些操作走 IPC（preload.cjs），
 * Web / 云部署环境下前端通过这些 HTTP 端点读取文件。
 *
 * 安全：路径限定在 ~/.hanako/ 和 desk 工作空间内。
 */

import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { safeReadFile } from "../../shared/safe-fs.js";

/** 安全路径校验：resolved 必须在 allowedRoots 之一内部 */
function isSafePath(filePath, allowedRoots) {
  const resolved = path.resolve(filePath);
  return allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );
}

export function createFsRoute(engine) {
  const route = new Hono();
  const hanakoHome = path.resolve(engine.hanakoHome);

  // 收集允许的根目录
  function getAllowedRoots() {
    const roots = [hanakoHome];
    // desk 工作空间目录（用户可能配在 ~/.hanako 外面）
    const deskHome = engine.agent?.deskManager?.homePath;
    if (deskHome) roots.push(path.resolve(deskHome));
    return roots;
  }

  // GET /fs/read?path=... → UTF-8 文本
  route.get("/fs/read", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "missing path" }, 400);
    if (!isSafePath(filePath, getAllowedRoots())) {
      return c.json({ error: "path not allowed" }, 403);
    }
    const content = safeReadFile(filePath, null);
    if (content === null) return c.json({ error: "file not found" }, 404);
    return c.text(content);
  });

  // GET /fs/read-base64?path=... → base64 编码
  route.get("/fs/read-base64", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "missing path" }, 400);
    if (!isSafePath(filePath, getAllowedRoots())) {
      return c.json({ error: "path not allowed" }, 403);
    }
    try {
      const buf = fs.readFileSync(filePath);
      return c.text(buf.toString("base64"));
    } catch {
      return c.json({ error: "file not found" }, 404);
    }
  });

  return route;
}
