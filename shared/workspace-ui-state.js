import { normalizeWorkspacePath } from "./workspace-history.js";

const MAX_WORKSPACES = 50;
const MAX_PATHS = 256;
const MAX_TABS = 32;
const MAX_STRING = 1024;

function cleanString(value, max = MAX_STRING) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function normalizeRelativePath(value) {
  const raw = cleanString(value);
  if (!raw) return "";
  const slashed = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!slashed || slashed === "." || slashed === "..") return "";
  const parts = slashed.split("/").filter(Boolean);
  if (parts.some(part => part === "." || part === "..")) return "";
  return parts.join("/");
}

function uniqueRelativePaths(values, limit = MAX_PATHS) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeRelativePath(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizePreviewTab(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanString(raw.id);
  if (!id) return null;
  const filePath = normalizeWorkspacePath(raw.filePath) || "";
  const relativePath = normalizeRelativePath(raw.relativePath);
  if (!filePath && !relativePath) return null;
  return {
    id,
    ...(filePath ? { filePath } : {}),
    ...(relativePath ? { relativePath } : {}),
    title: cleanString(raw.title, 256),
    type: cleanString(raw.type, 64) || "file-info",
    ext: cleanString(raw.ext, 32).toLowerCase(),
    language: cleanString(raw.language, 64) || null,
  };
}

export function normalizeWorkspaceUiEntry(raw = {}, { now = () => Date.now() } = {}) {
  const previewTabs = [];
  const seenTabs = new Set();
  for (const item of Array.isArray(raw.previewTabs) ? raw.previewTabs : []) {
    const tab = normalizePreviewTab(item);
    if (!tab || seenTabs.has(tab.id)) continue;
    seenTabs.add(tab.id);
    previewTabs.push(tab);
    if (previewTabs.length >= MAX_TABS) break;
  }

  const tabIds = new Set(previewTabs.map(tab => tab.id));
  const openTabs = [];
  for (const rawId of Array.isArray(raw.openTabs) ? raw.openTabs : []) {
    const id = cleanString(rawId);
    if (!id || !tabIds.has(id) || openTabs.includes(id)) continue;
    openTabs.push(id);
    if (openTabs.length >= MAX_TABS) break;
  }
  if (openTabs.length === 0 && previewTabs.length > 0) {
    openTabs.push(previewTabs[0].id);
  }

  const requestedActive = cleanString(raw.activeTabId);
  const activeTabId = openTabs.includes(requestedActive)
    ? requestedActive
    : (openTabs[0] || null);

  return {
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now(),
    deskCurrentPath: normalizeRelativePath(raw.deskCurrentPath),
    deskExpandedPaths: uniqueRelativePaths(raw.deskExpandedPaths),
    deskSelectedPath: normalizeRelativePath(raw.deskSelectedPath),
    previewOpen: raw.previewOpen === true,
    openTabs,
    activeTabId,
    previewTabs,
  };
}

export function normalizeWorkspaceUiState(raw = {}, opts = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const entries = Object.entries(source.workspaces || {})
    .map(([workspace, entry]) => [normalizeWorkspacePath(workspace), entry])
    .filter(([workspace]) => !!workspace)
    .map(([workspace, entry]) => [workspace, normalizeWorkspaceUiEntry(entry, opts)])
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
    .slice(0, MAX_WORKSPACES);
  return {
    version: 1,
    workspaces: Object.fromEntries(entries),
  };
}

export function upsertWorkspaceUiState(raw, workspaceRoot, entry, opts = {}) {
  const workspace = normalizeWorkspacePath(workspaceRoot);
  if (!workspace) return normalizeWorkspaceUiState(raw, opts);
  const state = normalizeWorkspaceUiState(raw, opts);
  state.workspaces[workspace] = normalizeWorkspaceUiEntry(entry, opts);
  return normalizeWorkspaceUiState(state, opts);
}
