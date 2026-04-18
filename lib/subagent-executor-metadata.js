import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const SUBAGENT_EXECUTOR_META_VERSION = 1;
export const SUBAGENT_SESSION_META_FILE = "session-meta.json";
export const UNKNOWN_EXECUTOR_NAME = "Unknown agent";

const metaWriteQueues = new Map();

export function normalizeExecutorMetadata(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const executorAgentId = source.executorAgentId || source.agentId || null;
  const executorAgentNameSnapshot =
    source.executorAgentNameSnapshot
    || source.executorAgentName
    || source.agentNameSnapshot
    || source.agentName
    || null;

  if (!executorAgentId && !executorAgentNameSnapshot) return null;

  return {
    executorAgentId,
    executorAgentNameSnapshot,
    executorMetaVersion: SUBAGENT_EXECUTOR_META_VERSION,
  };
}

export function mergeExecutorMetadata(target, raw, { includeLegacy = true } = {}) {
  const meta = normalizeExecutorMetadata(raw);
  if (!target || !meta) return target;

  target.executorAgentId = meta.executorAgentId;
  target.executorAgentNameSnapshot = meta.executorAgentNameSnapshot;
  target.executorMetaVersion = meta.executorMetaVersion;

  if (includeLegacy) {
    if (meta.executorAgentId) target.agentId = meta.executorAgentId;
    if (meta.executorAgentNameSnapshot) target.agentName = meta.executorAgentNameSnapshot;
  }

  return target;
}

export function materializeExecutorIdentity(raw, getAgent, unknownName = UNKNOWN_EXECUTOR_NAME) {
  const meta = normalizeExecutorMetadata(raw);
  if (!meta) return null;

  const liveAgent = meta.executorAgentId ? getAgent?.(meta.executorAgentId) || null : null;
  return {
    agentId: meta.executorAgentId,
    agentName: meta.executorAgentNameSnapshot || liveAgent?.agentName || unknownName,
  };
}

export function getSubagentSessionMetaPath(sessionPath) {
  if (!sessionPath) return null;
  return path.join(path.dirname(sessionPath), SUBAGENT_SESSION_META_FILE);
}

export function readSubagentSessionMetaSync(sessionPath) {
  const metaPath = getSubagentSessionMetaPath(sessionPath);
  if (!metaPath) return null;

  try {
    if (!fs.existsSync(metaPath)) return null;
    const raw = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    return normalizeExecutorMetadata(raw[path.basename(sessionPath)] || {});
  } catch {
    return null;
  }
}

export function writeSubagentSessionMeta(sessionPath, raw) {
  const meta = normalizeExecutorMetadata(raw);
  const metaPath = getSubagentSessionMetaPath(sessionPath);
  if (!meta || !metaPath) return Promise.resolve();

  const sessKey = path.basename(sessionPath);
  const next = async () => {
    let fileData = {};
    try {
      fileData = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    } catch {
      fileData = {};
    }

    fileData[sessKey] = {
      ...fileData[sessKey],
      ...meta,
    };

    await fsp.mkdir(path.dirname(metaPath), { recursive: true });
    await fsp.writeFile(metaPath, JSON.stringify(fileData, null, 2) + "\n", "utf-8");
  };

  const prev = metaWriteQueues.get(metaPath) || Promise.resolve();
  const queued = prev.then(next, next);
  metaWriteQueues.set(metaPath, queued);
  return queued.finally(() => {
    if (metaWriteQueues.get(metaPath) === queued) {
      metaWriteQueues.delete(metaPath);
    }
  });
}
