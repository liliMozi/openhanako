/**
 * 头像管理 REST 路由
 *
 * GET    /api/avatar/:role  → 返回头像图片（role = agent | user）
 * POST   /api/avatar/:role  → 上传头像（base64）
 * DELETE /api/avatar/:role  → 删除自定义头像，恢复默认
 *
 * agent 头像存在 agentDir/avatars/，user 头像存在 userDir/avatars/
 */
import fs from "fs/promises";
import path from "path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { safeJson } from "../hono-helpers.js";

const VALID_ROLES = new Set(["agent", "user"]);

export function createAvatarRoute(engine) {
  const route = new Hono();

  // 根据 role 选择存储目录
  function avatarDirFor(role) {
    const base = role === "user" ? engine.userDir : engine.agentDir;
    return path.join(base, "avatars");
  }

  // 确保两个目录都存在（立即执行）
  (async () => {
    await fs.mkdir(avatarDirFor("agent"), { recursive: true });
    await fs.mkdir(avatarDirFor("user"), { recursive: true });
  })();

  /** 查找 role 对应的头像文件（支持 png/jpg/webp） */
  async function findAvatar(role) {
    const dir = avatarDirFor(role);
    for (const ext of ["png", "jpg", "jpeg", "webp"]) {
      const p = path.join(dir, `${role}.${ext}`);
      try {
        await fs.access(p);
        return { path: p, ext };
      } catch {}
    }
    return null;
  }

  // ── 获取头像 ──
  route.get("/avatar/:role", async (c) => {
    const role = c.req.param("role");
    if (!VALID_ROLES.has(role)) {
      return c.json({ error: "role must be agent or user" }, 400);
    }

    const found = await findAvatar(role);
    if (!found) {
      return c.json({ error: "no custom avatar" }, 404);
    }

    const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
    const buf = await fs.readFile(found.path);
    c.header("Content-Type", mimeMap[found.ext] || "image/png");
    c.header("Cache-Control", "no-cache");
    return c.body(buf);
  });

  // ── 上传头像（base64） ──
  route.post("/avatar/:role", bodyLimit({ maxSize: 15 * 1024 * 1024 }), async (c) => {
    const role = c.req.param("role");
    if (!VALID_ROLES.has(role)) {
      return c.json({ error: "role must be agent or user" }, 400);
    }

    const body = await safeJson(c);
    const { data } = body;
    if (!data || typeof data !== "string") {
      return c.json({ error: "data (base64) is required" }, 400);
    }

    const match = data.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
    if (!match) {
      return c.json({ error: "invalid data URL format" }, 400);
    }

    const ext = match[1] === "jpeg" ? "jpg" : match[1];
    const buf = Buffer.from(match[2], "base64");
    const dir = avatarDirFor(role);

    // 删除旧头像（可能是不同格式）
    for (const oldExt of ["png", "jpg", "jpeg", "webp"]) {
      try { await fs.unlink(path.join(dir, `${role}.${oldExt}`)); } catch {}
    }

    // 写入新头像
    await fs.writeFile(path.join(dir, `${role}.${ext}`), buf);
    return c.json({ ok: true, ext });
  });

  // ── 删除头像（恢复默认） ──
  route.delete("/avatar/:role", async (c) => {
    const role = c.req.param("role");
    if (!VALID_ROLES.has(role)) {
      return c.json({ error: "role must be agent or user" }, 400);
    }

    const dir = avatarDirFor(role);
    for (const ext of ["png", "jpg", "jpeg", "webp"]) {
      try { await fs.unlink(path.join(dir, `${role}.${ext}`)); } catch {}
    }
    return c.json({ ok: true });
  });

  return route;
}
