import fs from "fs";
import os from "os";
import path from "path";

export function collectBridgeMediaAllowedRoots(engine, { agentId = null, agent = null } = {}) {
  const roots = [];
  const add = (root) => {
    const normalized = normalizeBridgeMediaRoot(root);
    if (normalized && !roots.includes(normalized)) roots.push(normalized);
  };

  add(engine?.hanakoHome);

  const targetAgent = agent || resolveAgent(engine, agentId);
  addAgentHome(targetAgent, add);
  if (agentId) add(safeCall(() => engine?.getHomeCwd?.(agentId)));

  for (const entry of agentValues(safeCall(() => engine?.getAgents?.()))) {
    addAgentHome(entry, add);
    if (entry?.id) add(safeCall(() => engine?.getHomeCwd?.(entry.id)));
  }

  add(safeCall(() => os.homedir()));
  for (const tempRoot of collectSystemTempRoots()) add(tempRoot);

  return roots;
}

export function isInsideBridgeMediaRoot(candidatePath, roots) {
  if (!candidatePath) return false;
  const candidate = normalizeExistingOrResolvedPath(candidatePath);
  return (roots || []).some((root) => isInsideRoot(candidate, root));
}

function resolveAgent(engine, agentId) {
  if (agentId && typeof engine?.getAgent === "function") {
    return safeCall(() => engine.getAgent(agentId));
  }
  return engine?.agent || null;
}

function addAgentHome(agent, add) {
  add(agent?.config?.desk?.home_folder);
}

function agentValues(raw) {
  if (!raw) return [];
  if (raw instanceof Map) return Array.from(raw.values());
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") return Object.values(raw);
  return [];
}

function normalizeBridgeMediaRoot(root) {
  if (typeof root !== "string" || !root.trim()) return null;
  const normalized = normalizeExistingOrResolvedPath(root);
  if (!path.isAbsolute(normalized)) return null;
  if (normalized === path.parse(normalized).root) return null;
  return normalized;
}

function collectSystemTempRoots() {
  const roots = [safeCall(() => os.tmpdir())];
  if (process.platform !== "win32" && fs.existsSync("/tmp")) {
    roots.push("/tmp");
  }
  return roots;
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

function safeCall(fn) {
  try { return fn(); }
  catch { return null; }
}
