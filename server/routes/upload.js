/**
 * upload.js — 文件上传路由
 *
 * POST /api/upload
 * Body: { paths: ["/absolute/path/to/file_or_dir", ...] }
 *
 * 纯粹的"搬运"操作：把文件或文件夹复制到统一的 uploads 目录。
 * 不做任何业务判断（PDF 解析、图片识别等由 skill 层处理）。
 *
 * 存储位置：
 * - 无 sessionPath：{hanakoHome}/uploads/，按 24 小时清理旧临时文件
 * - 有 sessionPath：{hanakoHome}/session-files/<session-hash>/，跟随 session 冷却清理
 */
import fsSync from "fs";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { t } from "../i18n.js";
import { isSensitivePath } from "../utils/path-security.js";
import {
  MAX_CHAT_IMAGE_BASE64_CHARS,
  extensionFromChatImageMime,
  isAllowedChatImageMime,
  isChatImageBase64WithinLimit,
} from "../../shared/image-mime.js";
import { registerSessionFileFromRequest } from "../../lib/session-files/session-file-response.js";
import { sessionFilesCacheDir } from "../../lib/session-files/session-file-registry.js";

const MAX_FILES = 9;

function extFromMime(mimeType) {
  return extensionFromChatImageMime(mimeType);
}

function sanitizeBlobName(name, mimeType) {
  const fallback = `pasted${extFromMime(mimeType) || ".png"}`;
  if (!name || typeof name !== "string") return fallback;
  // 去掉路径分隔符、控制字符；只保留 basename
  const base = path.basename(name).replace(/[\x00-\x1f/\\]/g, "").trim();
  if (!base) return fallback;
  // 强制扩展名匹配 mimeType（防止 .exe 假装 image/png）
  const want = extFromMime(mimeType);
  if (want && path.extname(base).toLowerCase() !== want) {
    return path.basename(base, path.extname(base)) + want;
  }
  return base;
}

class UploadPathError extends Error {
  constructor(message) {
    super(message);
    this.name = "UploadPathError";
  }
}

/** 递归统计路径中的文件数量（异步） */
export async function countFiles(p, { limit = Infinity, seen = new Set() } = {}) {
  const stat = await fs.lstat(p);
  if (stat.isSymbolicLink()) {
    throw new UploadPathError("symlink not allowed");
  }
  if (!stat.isDirectory()) return 1;

  let realDir;
  try {
    realDir = await fs.realpath(p);
  } catch {
    realDir = path.resolve(p);
  }
  if (seen.has(realDir)) return 0;
  seen.add(realDir);

  let count = 0;
  const entries = await fs.readdir(p);
  for (const entry of entries) {
    const remaining = limit - count;
    if (remaining <= 0) return limit + 1;
    count += await countFiles(path.join(p, entry), { limit: remaining, seen });
    if (count > limit) return limit + 1;
  }
  return count;
}

/** 清理超过 24 小时的上传临时文件（异步，后台执行） */
async function cleanOldUploads(uploadsDir) {
  try {
    const entries = await fs.readdir(uploadsDir, { withFileTypes: true });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      const fullPath = path.join(uploadsDir, entry.name);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.mtimeMs < cutoff) {
          await fs.rm(fullPath, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
}

function normalizeSessionPath(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveUploadTarget(engine, sessionPath) {
  if (sessionPath) {
    return {
      dir: sessionFilesCacheDir(engine.hanakoHome, sessionPath),
      storageKind: "managed_cache",
      shouldCleanOldUploads: false,
    };
  }
  return {
    dir: path.join(engine.hanakoHome, "uploads"),
    storageKind: undefined,
    shouldCleanOldUploads: true,
  };
}

function uniqueUploadName(base, ext) {
  return `${base}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}${ext}`;
}

export function createUploadRoute(engine) {
  const route = new Hono();

  route.post("/upload", async (c) => {
    const body = await safeJson(c);
    const { paths } = body;
    const sessionPath = normalizeSessionPath(body?.sessionPath);
    if (!Array.isArray(paths) || paths.length === 0) {
      return c.json({ error: t("error.pathsRequired") }, 400);
    }

    const uploadTarget = resolveUploadTarget(engine, sessionPath);
    const uploadsDir = uploadTarget.dir;

    await fs.mkdir(uploadsDir, { recursive: true });

    if (uploadTarget.shouldCleanOldUploads) {
      // 后台清理旧上传（不阻塞当前请求）
      cleanOldUploads(uploadsDir).catch(() => {});
    }

    const results = [];
    let totalFiles = 0;

    for (const srcPath of paths) {
      // 超出文件数限制后，对剩余路径统一报错
      if (totalFiles > MAX_FILES) {
        results.push({
          src: srcPath,
          error: t("error.tooManyFiles", { max: MAX_FILES, n: totalFiles }),
        });
        continue;
      }

      try {
        if (!path.isAbsolute(srcPath)) {
          results.push({ src: srcPath, error: "Path must be absolute" });
          continue;
        }
        let stat;
        try {
          stat = await fs.lstat(srcPath);
        } catch {
          results.push({ src: srcPath, error: t("error.pathNotFound") });
          continue;
        }
        if (stat.isSymbolicLink()) {
          results.push({ src: srcPath, error: "symlink not allowed" });
          continue;
        }
        if (isSensitivePath(srcPath, engine.hanakoHome)) {
          results.push({ src: srcPath, error: "sensitive path blocked" });
          continue;
        }

        // 安全检查通过后再统计文件数
        const pathFileCount = await countFiles(srcPath, { limit: MAX_FILES - totalFiles });
        totalFiles += pathFileCount;
        if (totalFiles > MAX_FILES) {
          results.push({
            src: srcPath,
            error: t("error.tooManyFiles", { max: MAX_FILES, n: totalFiles }),
          });
          continue;
        }

        const name = path.basename(srcPath);
        const isDir = stat.isDirectory();

        // 统一命名：原名_时间戳（文件保留扩展名）
        const ext = isDir ? "" : path.extname(srcPath);
        const base = isDir ? name : path.basename(srcPath, ext);
        const destName = uniqueUploadName(base, ext);
        const destPath = path.join(uploadsDir, destName);

        if (isDir) {
          await fs.cp(srcPath, destPath, { recursive: true });
        } else {
          await fs.copyFile(srcPath, destPath);
        }

        const sessionFile = registerSessionFileFromRequest(engine, {
          sessionPath,
          filePath: destPath,
          label: name,
          origin: "user_upload",
          storageKind: uploadTarget.storageKind,
        });

        results.push({
          src: srcPath,
          dest: destPath,
          name,
          isDirectory: isDir,
          ...(sessionFile || {}),
        });
      } catch (err) {
        if (err instanceof UploadPathError) {
          results.push({ src: srcPath, error: err.message });
          continue;
        }
        results.push({ src: srcPath, error: err.message });
      }
    }

    return c.json({ uploads: results, uploadsDir });
  });

  // POST /api/upload-blob
  // Body: { blobs: [{ name, base64Data, mimeType }, ...] }  (also accepts singular { name, base64Data, mimeType })
  // 把内存中的 base64 数据落到与 /api/upload 同一个 uploads 目录，输出形态保持一致
  route.post("/upload-blob", async (c) => {
    const body = await safeJson(c);
    const sessionPath = normalizeSessionPath(body?.sessionPath);
    let blobs = body?.blobs;
    if (!Array.isArray(blobs)) {
      if (body?.base64Data) blobs = [{ name: body.name, base64Data: body.base64Data, mimeType: body.mimeType }];
      else return c.json({ error: t("error.pathsRequired") }, 400);
    }
    if (blobs.length === 0) return c.json({ error: t("error.pathsRequired") }, 400);

    const uploadTarget = resolveUploadTarget(engine, sessionPath);
    const uploadsDir = uploadTarget.dir;
    await fs.mkdir(uploadsDir, { recursive: true });
    if (uploadTarget.shouldCleanOldUploads) {
      cleanOldUploads(uploadsDir).catch(() => {});
    }

    const results = [];
    for (let i = 0; i < blobs.length; i++) {
      if (i >= MAX_FILES) {
        results.push({ error: t("error.tooManyFiles", { max: MAX_FILES, n: blobs.length }) });
        continue;
      }
      const { name, base64Data, mimeType } = blobs[i] || {};
      try {
        if (typeof base64Data !== "string" || !base64Data) {
          results.push({ error: "base64Data required" });
          continue;
        }
        if (typeof mimeType !== "string" || !isAllowedChatImageMime(mimeType)) {
          results.push({ error: "unsupported mimeType" });
          continue;
        }
        if (!isChatImageBase64WithinLimit(base64Data)) {
          results.push({ error: `blob too large (max ${MAX_CHAT_IMAGE_BASE64_CHARS} bytes)` });
          continue;
        }
        const buf = Buffer.from(base64Data, "base64");
        if (buf.length === 0) {
          results.push({ error: "empty blob" });
          continue;
        }

        const safeName = sanitizeBlobName(name, mimeType);
        const ext = path.extname(safeName);
        const base = path.basename(safeName, ext);
        const destName = uniqueUploadName(base, ext);
        const destPath = path.join(uploadsDir, destName);

        await fs.writeFile(destPath, buf);

        const sessionFile = registerSessionFileFromRequest(engine, {
          sessionPath,
          filePath: destPath,
          label: safeName,
          origin: "user_upload",
          storageKind: uploadTarget.storageKind,
        });

        results.push({
          dest: destPath,
          name: safeName,
          isDirectory: false,
          ...(sessionFile || {}),
        });
      } catch (err) {
        results.push({ error: err?.message || String(err) });
      }
    }

    return c.json({ uploads: results, uploadsDir });
  });

  return route;
}
