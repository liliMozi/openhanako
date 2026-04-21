import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".wasm",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv", ".flac",
  ".ttf", ".otf", ".woff", ".woff2",
  ".db", ".sqlite", ".sqlite3",
]);

export class CheckpointStore {
  constructor(checkpointsDir) {
    this._dir = checkpointsDir;
  }

  async save({ sessionPath, tool, filePath, maxSizeKb }) {
    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) return null;

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return null;
    }

    if (stat.size > maxSizeKb * 1024) return null;

    const buf = fs.readFileSync(filePath);
    const sample = buf.subarray(0, 8192);
    if (sample.includes(0)) return null;

    const content = buf.toString("utf-8");

    fs.mkdirSync(this._dir, { recursive: true });
    const ts = Date.now();
    const suffix = randomBytes(2).toString("hex");
    const id = `${ts}_${suffix}`;
    const filename = `${id}.json`;
    const fileFull = path.join(this._dir, filename);
    const tmp = fileFull + ".tmp";

    const data = JSON.stringify({
      ts,
      sessionPath: sessionPath || null,
      tool,
      path: filePath,
      content,
      size: stat.size,
    });

    fs.writeFileSync(tmp, data, "utf-8");
    fs.renameSync(tmp, fileFull);

    return id;
  }

  async list() {
    let entries;
    try {
      entries = fs.readdirSync(this._dir);
    } catch {
      return [];
    }

    const results = [];
    for (const name of entries) {
      if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
      try {
        const raw = fs.readFileSync(path.join(this._dir, name), "utf-8");
        const obj = JSON.parse(raw);
        results.push({
          id: name.replace(/\.json$/, ""),
          ts: obj.ts,
          tool: obj.tool,
          path: obj.path,
          size: obj.size,
        });
      } catch {
        // corrupted file, skip
      }
    }

    results.sort((a, b) => b.ts - a.ts);
    return results;
  }

  async restore(id) {
    const filePath = path.join(this._dir, `${id}.json`);
    const raw = fs.readFileSync(filePath, "utf-8");
    const obj = JSON.parse(raw);

    fs.mkdirSync(path.dirname(obj.path), { recursive: true });
    fs.writeFileSync(obj.path, obj.content, "utf-8");

    return { restoredTo: obj.path };
  }

  async remove(id) {
    const filePath = path.join(this._dir, `${id}.json`);
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }

  async cleanup(retentionDays) {
    let entries;
    try {
      entries = fs.readdirSync(this._dir);
    } catch {
      return;
    }

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const name of entries) {
      if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
      const ts = parseInt(name.split("_")[0], 10);
      if (!isNaN(ts) && ts < cutoff) {
        try {
          fs.unlinkSync(path.join(this._dir, name));
        } catch {}
      }
    }
  }
}
