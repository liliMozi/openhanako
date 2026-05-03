import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { detectMime, extOfName, inferFileKind } from "../file-metadata.js";

export const SESSION_FILE_SIDECAR_VERSION = 1;
export const SESSION_FILE_CACHE_INACTIVE_TTL_MS = 72 * 60 * 60 * 1000;

export function sessionFileSidecarPath(sessionPath) {
  return `${sessionPath}.files.json`;
}

export function sessionFilesCacheDir(hanakoHome, sessionPath) {
  if (!hanakoHome) throw new Error("hanakoHome is required for session file cache");
  if (!sessionPath) throw new Error("sessionPath is required for session file cache");
  const hash = createHash("sha256").update(String(sessionPath)).digest("hex").slice(0, 24);
  return path.join(hanakoHome, "session-files", hash);
}

export function moveSessionFileSidecarSync(fromSessionPath, toSessionPath) {
  const src = sessionFileSidecarPath(fromSessionPath);
  if (!fs.existsSync(src)) return false;
  const dest = sessionFileSidecarPath(toSessionPath);
  if (fs.existsSync(dest)) throw new Error("stage file sidecar destination already exists");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return true;
}

export function deleteSessionFileSidecarSync(sessionPath) {
  fs.rmSync(sessionFileSidecarPath(sessionPath), { force: true });
}

export class SessionFileRegistry {
  constructor({ now = () => Date.now(), managedCacheRoot = null } = {}) {
    this._now = now;
    this._managedCacheRoot = managedCacheRoot ? normalizeExistingOrResolvedPath(managedCacheRoot) : null;
    this._byId = new Map();
    this._idsBySession = new Map();
    this._sidecarsBySession = new Map();
    this._loadedSessions = new Set();
  }

  registerFile({ sessionPath, filePath, label, origin = "unknown", storageKind = "external" } = {}) {
    if (!sessionPath) throw new Error("sessionPath is required to register a session file");
    if (!filePath || !path.isAbsolute(filePath)) throw new Error("filePath must be an absolute path");
    this._hydrateSession(sessionPath);

    let realPath;
    try {
      realPath = fs.realpathSync(filePath);
    } catch {
      throw new Error(`file not found: ${filePath}`);
    }

    const stat = fs.statSync(realPath);
    const filename = path.basename(filePath);
    const ext = extOfName(filename);
    const sample = stat.isFile() ? readSample(realPath) : Buffer.alloc(0);
    const mime = stat.isDirectory()
      ? "inode/directory"
      : detectMime(sample, "application/octet-stream", filename);
    const id = buildSessionFileId({ sessionPath, realPath, size: stat.size, mtimeMs: stat.mtimeMs });
    const existing = this._byId.get(id);
    if (existing) return existing;

    const entry = Object.freeze({
      id,
      sessionPath,
      origin,
      filePath,
      realPath,
      displayName: label || filename,
      filename,
      label: label || filename,
      ext,
      mime,
      size: stat.isDirectory() ? null : stat.size,
      kind: inferFileKind({ mime, ext, isDirectory: stat.isDirectory() }),
      isDirectory: stat.isDirectory(),
      createdAt: this._now(),
      mtimeMs: stat.mtimeMs,
      storageKind,
      status: "available",
      missingAt: null,
    });

    this._remember(entry, sessionPath);
    const sidecar = this._sidecarsBySession.get(sessionPath) || emptySidecar(sessionPath, this._now());
    sidecar.files[id] = entry;
    sidecar.refs.push({
      fileId: id,
      origin,
      storageKind,
      createdAt: this._now(),
    });
    sidecar.updatedAt = this._now();
    this._sidecarsBySession.set(sessionPath, sidecar);
    this._saveSidecar(sessionPath);
    return entry;
  }

  get(fileId, { sessionPath } = {}) {
    if (fileId && sessionPath && !this._byId.has(fileId)) this._hydrateSession(sessionPath);
    return this._byId.get(fileId) || null;
  }

  getByFilePath(filePath, { sessionPath } = {}) {
    if (!filePath) return null;
    if (sessionPath) this._hydrateSession(sessionPath);
    const target = normalizeExistingOrResolvedPath(filePath);
    const ids = sessionPath
      ? (this._idsBySession.get(sessionPath) || [])
      : Array.from(this._byId.keys());
    for (const id of ids) {
      const entry = this._byId.get(id);
      if (!entry) continue;
      const candidates = [entry.filePath, entry.realPath].filter(Boolean);
      if (candidates.some((candidate) => normalizeExistingOrResolvedPath(candidate) === target)) {
        return entry;
      }
    }
    return null;
  }

  list(sessionPath) {
    this._hydrateSession(sessionPath);
    const ids = this._idsBySession.get(sessionPath) || [];
    return ids.map(id => this._byId.get(id)).filter(Boolean);
  }

  cleanupColdSessionFiles({ sessionPath, maxInactiveMs = SESSION_FILE_CACHE_INACTIVE_TTL_MS } = {}) {
    if (!sessionPath) throw new Error("sessionPath is required to clean session files");
    this._hydrateSession(sessionPath);

    let sessionStat;
    try {
      sessionStat = fs.statSync(sessionPath);
    } catch {
      return { sessionPath, cold: false, skipped: "missing_session", expired: 0, deleted: 0 };
    }

    const ageMs = this._now() - sessionStat.mtimeMs;
    if (ageMs < maxInactiveMs) {
      return { sessionPath, cold: false, ageMs, expired: 0, deleted: 0 };
    }

    const sidecar = this._sidecarsBySession.get(sessionPath) || emptySidecar(sessionPath, this._now());
    let expired = 0;
    let deleted = 0;
    let changed = false;

    for (const [id, file] of Object.entries(sidecar.files || {})) {
      if (!isManagedCache(file) || file.status === "expired") continue;
      const target = file.realPath || file.filePath;
      if (target) {
        this._assertManagedCacheTarget(target);
        const existed = fs.existsSync(target);
        fs.rmSync(target, { recursive: true, force: true });
        if (existed) deleted += 1;
      }
      const next = freezeEntry({
        ...file,
        status: "expired",
        missingAt: this._now(),
      });
      sidecar.files[id] = next;
      this._remember(next, sessionPath);
      expired += 1;
      changed = true;
    }

    if (changed) {
      sidecar.updatedAt = this._now();
      this._sidecarsBySession.set(sessionPath, sidecar);
      this._saveSidecar(sessionPath);
    }

    return { sessionPath, cold: true, ageMs, expired, deleted };
  }

  cleanupColdSessions({ agentsDir, maxInactiveMs = SESSION_FILE_CACHE_INACTIVE_TTL_MS } = {}) {
    if (!agentsDir) throw new Error("agentsDir is required to clean session files");
    const sessions = collectSessionPaths(agentsDir);
    const results = [];
    for (const sessionPath of sessions) {
      if (!fs.existsSync(sessionFileSidecarPath(sessionPath))) continue;
      results.push(this.cleanupColdSessionFiles({ sessionPath, maxInactiveMs }));
    }
    return results;
  }

  _hydrateSession(sessionPath) {
    if (!sessionPath) throw new Error("sessionPath is required");
    if (this._loadedSessions.has(sessionPath)) return;
    const sidecar = this._readSidecar(sessionPath);
    this._sidecarsBySession.set(sessionPath, sidecar);
    this._loadedSessions.add(sessionPath);
    for (const raw of Object.values(sidecar.files || {})) {
      const entry = freezeEntry(raw);
      this._remember(entry, sessionPath);
    }
  }

  _remember(entry, requestedSessionPath = null) {
    this._byId.set(entry.id, entry);
    const sessions = new Set([entry.sessionPath, requestedSessionPath].filter(Boolean));
    for (const sessionPath of sessions) {
      if (!this._idsBySession.has(sessionPath)) this._idsBySession.set(sessionPath, []);
      const ids = this._idsBySession.get(sessionPath);
      if (!ids.includes(entry.id)) ids.push(entry.id);
    }
  }

  _readSidecar(sessionPath) {
    const sidecarPath = sessionFileSidecarPath(sessionPath);
    if (!fs.existsSync(sidecarPath)) return emptySidecar(sessionPath, this._now());
    try {
      const raw = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
      if (raw?.version !== SESSION_FILE_SIDECAR_VERSION || !raw.files || typeof raw.files !== "object") {
        throw new Error("invalid sidecar schema");
      }
      return {
        version: SESSION_FILE_SIDECAR_VERSION,
        sessionPath: raw.sessionPath || sessionPath,
        files: raw.files,
        refs: Array.isArray(raw.refs) ? raw.refs : [],
        createdAt: raw.createdAt || this._now(),
        updatedAt: raw.updatedAt || this._now(),
      };
    } catch (err) {
      throw new Error(`failed to read session file sidecar: ${sidecarPath}: ${err.message}`);
    }
  }

  _saveSidecar(sessionPath) {
    const sidecar = this._sidecarsBySession.get(sessionPath);
    if (!sidecar) return;
    const sidecarPath = sessionFileSidecarPath(sessionPath);
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    const tmpPath = `${sidecarPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf-8");
    fs.renameSync(tmpPath, sidecarPath);
  }

  _assertManagedCacheTarget(filePath) {
    if (!this._managedCacheRoot) return;
    const realPath = normalizeExistingOrResolvedPath(filePath);
    if (!isInsideRoot(realPath, this._managedCacheRoot)) {
      throw new Error(`managed cache file is outside session-files root: ${filePath}`);
    }
  }
}

function emptySidecar(sessionPath, now) {
  return {
    version: SESSION_FILE_SIDECAR_VERSION,
    sessionPath,
    files: {},
    refs: [],
    createdAt: now,
    updatedAt: now,
  };
}

function freezeEntry(raw) {
  return Object.freeze({
    ...raw,
    storageKind: raw.storageKind || "external",
    status: raw.status || "available",
    missingAt: raw.missingAt ?? null,
  });
}

function isManagedCache(file) {
  return file?.storageKind === "managed_cache";
}

function collectSessionPaths(agentsDir) {
  let agents = [];
  try { agents = fs.readdirSync(agentsDir, { withFileTypes: true }); } catch { return []; }
  const sessions = [];
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const sessionsDir = path.join(agentsDir, agent.name, "sessions");
    collectJsonlFiles(sessionsDir, sessions);
    collectJsonlFiles(path.join(sessionsDir, "archived"), sessions);
  }
  return sessions;
}

function collectJsonlFiles(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(path.join(dir, entry.name));
    }
  }
}

function normalizeExistingOrResolvedPath(filePath) {
  const resolved = path.resolve(filePath);
  try { return fs.realpathSync(resolved); }
  catch { return resolved; }
}

function isInsideRoot(filePath, root) {
  const rel = path.relative(root, filePath);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function readSample(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function buildSessionFileId({ sessionPath, realPath, size, mtimeMs }) {
  const hash = createHash("sha256")
    .update(JSON.stringify([sessionPath, realPath, size, Math.round(mtimeMs)]))
    .digest("hex")
    .slice(0, 16);
  return `sf_${hash}`;
}
