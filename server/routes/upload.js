/**
 * upload.js — 文件上传路由
 *
 * POST /api/upload
 * Body: { paths: ["/absolute/path/to/file_or_dir", ...] }
 *
 * 纯粹的"搬运"操作：把文件或文件夹复制到统一的 uploads 目录。
 * 不做任何业务判断（PDF 解析、图片识别等由 skill 层处理）。
 *
 * 存储位置：{hanakoHome}/uploads/
 * 清理策略：24 小时过期自动删除。
 */
import fsSync from "fs";
import fs from "fs/promises";
import path from "path";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { t } from "../i18n.js";
import { isSensitivePath } from "../utils/path-security.js";

const MAX_FILES = 9;

/** 递归统计路径中的文件数量（异步） */
async function countFiles(p) {
  try {
    const stat = await fs.stat(p);
    if (!stat.isDirectory()) return 1;
    let count = 0;
    const entries = await fs.readdir(p);
    for (const entry of entries) {
      count += await countFiles(path.join(p, entry));
    }
    return count;
  } catch {
    return 0;
  }
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

export function createUploadRoute(engine) {
  const route = new Hono();

  route.post("/upload", async (c) => {
    const body = await safeJson(c);
    const { paths } = body;
    if (!Array.isArray(paths) || paths.length === 0) {
      return c.json({ error: t("error.pathsRequired") }, 400);
    }

    // 确定 uploads 目录
    const uploadsDir = path.join(engine.hanakoHome, "uploads");

    await fs.mkdir(uploadsDir, { recursive: true });

    // 后台清理旧上传（不阻塞当前请求）
    cleanOldUploads(uploadsDir).catch(() => {});

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
          stat = await fs.stat(srcPath);
        } catch {
          results.push({ src: srcPath, error: t("error.pathNotFound") });
          continue;
        }
        if (isSensitivePath(srcPath, engine.hanakoHome)) {
          results.push({ src: srcPath, error: "sensitive path blocked" });
          continue;
        }

        // 安全检查通过后再统计文件数
        const pathFileCount = await countFiles(srcPath);
        totalFiles += pathFileCount;
        if (totalFiles > MAX_FILES) {
          results.push({
            src: srcPath,
            error: t("error.tooManyFiles", { max: MAX_FILES, n: totalFiles }),
          });
          continue;
        }

        const name = path.basename(srcPath);
        const timestamp = Date.now().toString(36);
        const isDir = stat.isDirectory();

        // 统一命名：原名_时间戳（文件保留扩展名）
        const ext = isDir ? "" : path.extname(srcPath);
        const base = isDir ? name : path.basename(srcPath, ext);
        const destName = `${base}_${timestamp}${ext}`;
        const destPath = path.join(uploadsDir, destName);

        if (isDir) {
          await fs.cp(srcPath, destPath, { recursive: true });
        } else {
          await fs.copyFile(srcPath, destPath);
        }

        results.push({
          src: srcPath,
          dest: destPath,
          name,
          isDirectory: isDir,
        });
      } catch (err) {
        results.push({ src: srcPath, error: err.message });
      }
    }

    return c.json({ uploads: results, uploadsDir });
  });

  return route;
}
