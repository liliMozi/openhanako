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

const VALID_ROLES = new Set(["agent", "user"]);

export default async function avatarRoute(app, { engine }) {
  // 根据 role 选择存储目录
  function avatarDirFor(role) {
    const base = role === "user" ? engine.userDir : engine.agentDir;
    return path.join(base, "avatars");
  }

  // 确保两个目录都存在
  await fs.mkdir(avatarDirFor("agent"), { recursive: true });
  await fs.mkdir(avatarDirFor("user"), { recursive: true });

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
  app.get("/api/avatar/:role", async (req, reply) => {
    const { role } = req.params;
    if (!VALID_ROLES.has(role)) {
      reply.code(400);
      return { error: "role must be agent or user" };
    }

    const found = await findAvatar(role);
    if (!found) {
      reply.code(404);
      return { error: "no custom avatar" };
    }

    const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
    const buf = await fs.readFile(found.path);
    reply.header("Content-Type", mimeMap[found.ext] || "image/png");
    reply.header("Cache-Control", "no-cache");
    return reply.send(buf);
  });

  // ── 上传头像（base64） ──
  app.post("/api/avatar/:role", { bodyLimit: 15 * 1024 * 1024 }, async (req, reply) => {
    const { role } = req.params;
    if (!VALID_ROLES.has(role)) {
      reply.code(400);
      return { error: "role must be agent or user" };
    }

    const { data } = req.body || {};
    if (!data || typeof data !== "string") {
      reply.code(400);
      return { error: "data (base64) is required" };
    }

    const match = data.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
    if (!match) {
      reply.code(400);
      return { error: "invalid data URL format" };
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
    return { ok: true, ext };
  });

  // ── 删除头像（恢复默认） ──
  app.delete("/api/avatar/:role", async (req, reply) => {
    const { role } = req.params;
    if (!VALID_ROLES.has(role)) {
      reply.code(400);
      return { error: "role must be agent or user" };
    }

    const dir = avatarDirFor(role);
    for (const ext of ["png", "jpg", "jpeg", "webp"]) {
      try { await fs.unlink(path.join(dir, `${role}.${ext}`)); } catch {}
    }
    return { ok: true };
  });
}
