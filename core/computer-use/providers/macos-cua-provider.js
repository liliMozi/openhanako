import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { COMPUTER_USE_ERRORS, computerUseError } from "../errors.js";
import { createCommandRunner } from "./command-runner.js";

const HANA_CURSOR_BLOOM_COLOR = "#537D96";
const MACOS_CUA_ALLOWED_ACTIONS = ["double_click", "click_point", "type_text", "press_key", "scroll", "drag", "stop"];

function expandHome(filePath, homeDir = os.homedir()) {
  if (!filePath || !filePath.startsWith("~/")) return filePath;
  return path.join(homeDir, filePath.slice(2));
}

function helperPath(root) {
  return path.join(root, "hana-computer-use-helper");
}

export function resolveHanaCursorImagePath() {
  return fileURLToPath(new URL("../assets/hana-cursor.svg", import.meta.url));
}

function commandSupportsHanaCursor(command) {
  return path.basename(String(command || "")) === "hana-computer-use-helper";
}

function bundledHelperCandidates({ env, hanaRoot, cwd, arch }) {
  const roots = [];
  if (env.HANA_COMPUTER_USE_RUNTIME_ROOT) {
    roots.push(env.HANA_COMPUTER_USE_RUNTIME_ROOT);
  }
  if (hanaRoot) {
    roots.push(path.resolve(hanaRoot, "..", "computer-use", "macos"));
    roots.push(path.resolve(hanaRoot, "dist-computer-use", `mac-${arch}`));
  }
  if (cwd) {
    roots.push(path.resolve(cwd, "dist-computer-use", `mac-${arch}`));
  }
  return [...new Set(roots.filter(Boolean))].map(helperPath);
}

export function resolveCuaDriverCommand({
  env = process.env,
  homeDir = os.homedir(),
  existsSync = fs.existsSync,
  hanaRoot = env.HANA_ROOT,
  cwd = process.cwd(),
  arch = process.arch,
} = {}) {
  const candidates = [
    env.HANA_COMPUTER_USE_HELPER_PATH,
    ...bundledHelperCandidates({ env, hanaRoot, cwd, arch }),
    env.HANA_CUA_DRIVER_PATH,
    "~/.local/bin/cua-driver",
    "/usr/local/bin/cua-driver",
    "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
  ].filter(Boolean).map((p) => expandHome(p, homeDir));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "cua-driver";
}

function parseJsonMaybe(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { content: [{ type: "text", text }], structuredContent: null };
  }
}

function getStructured(result) {
  return result?.structuredContent
    || result?.structured_content
    || result?.data
    || null;
}

function getContent(result) {
  return Array.isArray(result?.content) ? result.content : [];
}

function getText(result) {
  return getContent(result)
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("\n");
}

function getImage(result) {
  return getContent(result).find((block) => block?.type === "image") || null;
}

function parsePermissionText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/(?:✅|❌)?\s*([^:]+):\s*(.+)$/u);
      if (!match) return null;
      return {
        name: match[1].trim(),
        granted: !/not\s+granted|missing|denied|false/i.test(match[2]),
      };
    })
    .filter(Boolean);
}

function normalizePermissions(result) {
  const structured = getStructured(result);
  if (Array.isArray(structured?.permissions)) return structured.permissions;
  return parsePermissionText(getText(result));
}

function normalizeWindows(windows = []) {
  if (!Array.isArray(windows)) return [];
  return windows.map((win) => ({
    windowId: String(win.window_id ?? win.windowId ?? win.id ?? ""),
    title: win.title || win.name || "",
    bounds: win.bounds || null,
    isOnScreen: win.is_on_screen ?? win.isOnScreen ?? null,
    onCurrentSpace: win.on_current_space ?? win.onCurrentSpace ?? null,
    layer: win.layer ?? null,
    zIndex: win.z_index ?? win.zIndex ?? null,
  })).filter((win) => win.windowId);
}

function normalizeAppsPayload(payload) {
  const apps = Array.isArray(payload) ? payload : (payload?.apps || payload?.items || []);
  if (!Array.isArray(apps)) return [];
  return apps.map((app) => {
    const bundleId = app.bundle_id || app.bundleId || app.appId || app.id || null;
    const pid = app.pid ?? app.process_id ?? app.processId ?? null;
    const appId = bundleId || (pid != null ? `pid:${pid}` : app.name || "unknown");
    return {
      appId,
      name: app.name || app.localized_name || app.displayName || appId,
      pid,
      active: app.active ?? app.is_active ?? null,
      windows: normalizeWindows(app.windows),
      providerData: {
        bundleId,
        pid,
      },
    };
  });
}

function windowArea(win) {
  const width = Number(win?.bounds?.width || 0);
  const height = Number(win?.bounds?.height || 0);
  return Number.isFinite(width) && Number.isFinite(height) ? width * height : 0;
}

function scoreLaunchWindow(win) {
  let score = 0;
  if (win?.isOnScreen === true) score += 1000;
  if (win?.onCurrentSpace === true) score += 500;
  if (String(win?.title || "").trim()) score += 100;
  const area = windowArea(win);
  score += Math.min(80, area / 10000);
  if (Number(win?.bounds?.height || 0) > 80) score += 50;
  return score;
}

function selectLaunchWindow(windows, targetWindowId = null) {
  if (!Array.isArray(windows) || !windows.length) return null;
  if (targetWindowId) {
    const explicit = windows.find((win) => String(win.windowId) === String(targetWindowId));
    if (explicit) return explicit;
  }
  return [...windows].sort((a, b) => scoreLaunchWindow(b) - scoreLaunchWindow(a))[0] || null;
}

function normalizeLaunchPayload(payload, target) {
  const data = payload || {};
  const windows = normalizeWindows(data.windows);
  const pid = data.pid ?? data.process_id ?? data.processId ?? target?.pid ?? null;
  const selectedWindow = selectLaunchWindow(windows, target?.windowId);
  const windowId = target?.windowId || selectedWindow?.windowId || null;
  if (pid == null || windowId == null) {
    throw computerUseError(
      COMPUTER_USE_ERRORS.TARGET_NOT_FOUND,
      "Cua Driver did not return a pid and window id for the requested target.",
      { target },
    );
  }
  return {
    appId: data.bundle_id || data.bundleId || target?.appId || `pid:${pid}`,
    windowId: String(windowId),
    providerState: {
      pid: Number(pid),
      windowId: Number(windowId),
      appName: data.name || data.app_name || target?.name || null,
      bundleId: data.bundle_id || data.bundleId || target?.appId || null,
    },
  };
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseElementsFromMarkdown(markdown) {
  const elements = [];
  const lines = String(markdown || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^(\s*)-\s+\[(\d+)\]\s+([A-Za-z0-9_]+)(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    const rest = match[4] || "";
    const childLabels = [];
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      const child = lines[childIndex];
      const childIndent = child.match(/^\s*/)?.[0]?.length || 0;
      if (childIndent <= indent && /^\s*-\s+/.test(child)) break;
      if (/AX(?:StaticText|Image|Button|Heading|TextField)\b/.test(child)) {
        const label = labelFromMarkdownFragment(child);
        if (label) childLabels.push(label);
      }
    }
    elements.push({
      elementId: match[2],
      role: match[3],
      label: labelFromMarkdownFragment(rest) || uniqueLabelParts(childLabels).join(" "),
      enabled: !/\bDISABLED\b/.test(rest),
      bounds: null,
    });
  }
  return elements;
}

function labelFromMarkdownFragment(fragment) {
  const text = String(fragment || "");
  const quoted = text.match(/"([^"]+)"/);
  if (quoted?.[1]) return quoted[1].trim();
  const value = text.match(/=\s*"([^"]+)"/);
  if (value?.[1]) return value[1].trim();
  const parenthetical = text.match(/\(([^)]+)\)/);
  if (parenthetical?.[1]) return parenthetical[1].trim();
  return "";
}

function uniqueLabelParts(labels) {
  const seen = new Set();
  const result = [];
  for (const label of labels) {
    const normalized = String(label || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeWindowState(result, lease) {
  const structured = getStructured(result) || {};
  const text = getText(result);
  const image = getImage(result);
  if (!image?.data) {
    throw computerUseError(
      COMPUTER_USE_ERRORS.PROVIDER_CRASHED,
      "Cua Driver response did not include screenshot image data.",
      { leaseId: lease.leaseId },
    );
  }
  const screenshot = {
    type: "image",
    mimeType: image.mimeType || image.mime_type || "image/png",
    data: image.data,
  };

  const elements = Array.isArray(structured.elements)
    ? structured.elements.map((el, index) => ({
        elementId: String(el.element_index ?? el.elementId ?? el.id ?? index),
        role: el.role || el.ax_role || el.type || "element",
        label: el.label || el.name || el.title || "",
        value: el.value,
        bounds: el.bounds || null,
        enabled: el.enabled !== false,
      }))
    : parseElementsFromMarkdown(structured.tree_markdown || structured.treeMarkdown || text);

  return {
    mode: "vision-native",
    appId: lease.appId,
    windowId: lease.windowId,
    screenshot,
    display: structured.display || structured.screen || { width: 1568, height: 1000, scaleFactor: 1 },
    focusedElementId: structured.focusedElementId || null,
    elements,
    providerState: lease.providerState,
  };
}

function elementIndexFromId(elementId) {
  const raw = String(elementId || "").replace(/^cua:/, "");
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw computerUseError(COMPUTER_USE_ERRORS.TARGET_NOT_FOUND, `Invalid Cua element id: ${elementId}`, { elementId });
  }
  return n;
}

function assertNoElementIndex(action) {
  if (!action?.elementId) return;
  throw computerUseError(
    COMPUTER_USE_ERRORS.CAPABILITY_UNSUPPORTED,
    "Element-indexed Computer Use actions are unavailable with the bundled macOS helper. Use screenshot coordinates with click_point or double_click instead.",
    { action: action.type, elementId: action.elementId },
  );
}

export function createMacosCuaProvider({
  providerId = "macos:cua",
  platform = process.platform,
  command = resolveCuaDriverCommand(),
  cursorImagePath = commandSupportsHanaCursor(command) ? resolveHanaCursorImagePath() : null,
  cursorBloomColor = HANA_CURSOR_BLOOM_COLOR,
  runner = createCommandRunner(),
  timeoutMs = 30000,
  launchRetryAttempts = 3,
  launchRetryDelayMs = 350,
} = {}) {
  let nativeCursorConfigPromise = null;

  async function runRaw(args, options = {}) {
    const result = await runner.run(command, args, { timeoutMs: options.timeoutMs || timeoutMs });
    if (result.exitCode !== 0) {
      const stderr = result.stderr || "";
      const parsed = parseJsonMaybe(result.stdout);
      const helperMessage = getText(parsed);
      const permissionDenied = /permission|accessibility|screen recording|tcc/i.test(stderr);
      throw computerUseError(
        permissionDenied ? COMPUTER_USE_ERRORS.OS_PERMISSION_DENIED : COMPUTER_USE_ERRORS.PROVIDER_CRASHED,
        helperMessage || stderr.trim() || `cua-driver exited with code ${result.exitCode}`,
        { providerId, exitCode: result.exitCode },
      );
    }
    const parsed = parseJsonMaybe(result.stdout);
    if (parsed?.isError) {
      throw computerUseError(COMPUTER_USE_ERRORS.PROVIDER_CRASHED, getText(parsed) || "Cua Driver returned an error", { providerId });
    }
    return parsed;
  }

  async function runTool(name, payload = null) {
    const args = payload == null
      ? [name, "--raw", "--compact"]
      : [name, JSON.stringify(payload), "--raw", "--compact"];
    return runRaw(args);
  }

  async function ensureNativeCursorConfigured() {
    if (!cursorImagePath) return;
    if (!nativeCursorConfigPromise) {
      nativeCursorConfigPromise = (async () => {
        await runTool("set_agent_cursor_enabled", { enabled: true });
        await runTool("set_agent_cursor_style", {
          image_path: cursorImagePath,
          bloom_color: cursorBloomColor,
        });
      })().catch((err) => {
        nativeCursorConfigPromise = null;
        throw err;
      });
    }
    await nativeCursorConfigPromise;
  }

  function ensureDarwin() {
    if (platform !== "darwin") {
      throw computerUseError(COMPUTER_USE_ERRORS.PROVIDER_UNAVAILABLE, "Cua Driver is available only on macOS.", {
        providerId,
        platform,
      });
    }
  }

  return {
    providerId,
    capabilities: {
      platform: "macos",
      observationModes: ["vision-native"],
      screenshot: true,
      accessibilityTree: true,
      elementActions: true,
      backgroundControl: "full",
      pointClick: "requiresApproval",
      drag: "requiresApproval",
      textInput: "semantic",
      keyboardInput: "pidScoped",
      requiresForegroundForInput: false,
      nativeCursor: Boolean(cursorImagePath),
      isolated: false,
    },

    async getStatus() {
      if (platform !== "darwin") {
        return { providerId, available: false, reason: "unsupported-platform", platform };
      }
      try {
        const status = await runner.run(command, ["status"], { timeoutMs: 5000 });
        if (status.exitCode !== 0) {
          return { providerId, available: false, reason: "daemon-unavailable", stderr: status.stderr || "" };
        }
        let permissions = [];
        try {
          const perms = await runTool("check_permissions", { prompt: false });
          permissions = normalizePermissions(perms);
        } catch (err) {
          permissions = [{ name: "accessibility", granted: false }, { name: "screen-recording", granted: false }];
        }
        return { providerId, available: true, command, daemon: status.stdout.trim(), permissions };
      } catch (err) {
        return {
          providerId,
          available: false,
          reason: err?.code === "ENOENT" ? "binary-not-found" : "status-failed",
          error: err?.message || String(err),
        };
      }
    },

    async requestPermissions() {
      ensureDarwin();
      const perms = await runTool("check_permissions", { prompt: true });
      return { providerId, available: true, permissions: normalizePermissions(perms) };
    },

    async listApps() {
      ensureDarwin();
      const result = await runTool("list_apps");
      return normalizeAppsPayload(getStructured(result));
    },

    async createLease(_ctx, target = {}) {
      ensureDarwin();
      await ensureNativeCursorConfigured();
      if (target.pid || target.processId) {
        const pid = Number(target.pid || target.processId);
        const windowId = Number(target.windowId);
        if (!Number.isFinite(pid) || !Number.isFinite(windowId)) {
          throw computerUseError(COMPUTER_USE_ERRORS.TARGET_NOT_FOUND, "Cua lease target requires pid and windowId.", { target });
        }
        return {
          appId: target.appId || `pid:${pid}`,
          windowId: String(windowId),
          allowedActions: MACOS_CUA_ALLOWED_ACTIONS,
          providerState: { pid, windowId, appName: target.name || null, bundleId: target.appId || null },
        };
      }

      if (!target.appId && !target.name) {
        throw computerUseError(COMPUTER_USE_ERRORS.TARGET_NOT_FOUND, "Cua lease target requires appId, app name, or pid/windowId.", { target });
      }

      const payload = target.appId ? { bundle_id: target.appId } : { name: target.name };
      const attempts = Math.max(1, Number(launchRetryAttempts) || 1);
      let normalized = null;
      let lastError = null;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const result = await runTool("launch_app", payload);
        try {
          normalized = normalizeLaunchPayload(getStructured(result), target);
          break;
        } catch (err) {
          if (err?.code !== COMPUTER_USE_ERRORS.TARGET_NOT_FOUND || attempt === attempts - 1) {
            throw err;
          }
          lastError = err;
          await sleep(launchRetryDelayMs);
        }
      }
      if (!normalized && lastError) throw lastError;
      return {
        ...normalized,
        allowedActions: MACOS_CUA_ALLOWED_ACTIONS,
      };
    },

    async getAppState(_ctx, lease) {
      ensureDarwin();
      await ensureNativeCursorConfigured();
      const { pid, windowId } = lease.providerState || {};
      if (!pid || !windowId) {
        throw computerUseError(COMPUTER_USE_ERRORS.TARGET_NOT_FOUND, "Cua lease is missing native pid/windowId.", { leaseId: lease.leaseId });
      }
      const result = await runTool("get_window_state", { pid, window_id: windowId });
      return normalizeWindowState(result, lease);
    },

    async performAction(_ctx, lease, action) {
      ensureDarwin();
      await ensureNativeCursorConfigured();
      const { pid, windowId } = lease.providerState || {};
      if (!pid || !windowId) {
        throw computerUseError(COMPUTER_USE_ERRORS.TARGET_NOT_FOUND, "Cua lease is missing native pid/windowId.", { leaseId: lease.leaseId });
      }

      if (action.type === "click_element") {
        assertNoElementIndex(action);
        return getStructured(await runTool("click", { pid, window_id: windowId, element_index: elementIndexFromId(action.elementId) })) || { ok: true };
      }
      if (action.type === "double_click") {
        assertNoElementIndex(action);
        const payload = { pid, window_id: windowId };
        if (action.elementId) {
          payload.element_index = elementIndexFromId(action.elementId);
        } else {
          payload.x = action.x;
          payload.y = action.y;
        }
        return getStructured(await runTool("double_click", payload)) || { ok: true };
      }
      if (action.type === "perform_secondary_action") {
        assertNoElementIndex(action);
        return getStructured(await runTool("right_click", { pid, window_id: windowId, element_index: elementIndexFromId(action.elementId) })) || { ok: true };
      }
      if (action.type === "click_point") {
        return getStructured(await runTool("click", { pid, window_id: windowId, x: action.x, y: action.y })) || { ok: true };
      }
      if (action.type === "type_text") {
        assertNoElementIndex(action);
        const payload = { pid, text: action.text || "" };
        if (action.elementId) {
          payload.window_id = windowId;
          payload.element_index = elementIndexFromId(action.elementId);
        }
        return getStructured(await runTool("type_text", payload)) || { ok: true };
      }
      if (action.type === "press_key") {
        return getStructured(await runTool("press_key", { pid, key: action.key })) || { ok: true };
      }
      if (action.type === "scroll") {
        assertNoElementIndex(action);
        const payload = { pid, direction: action.direction, amount: action.amount || 3 };
        if (action.elementId) {
          payload.window_id = windowId;
          payload.element_index = elementIndexFromId(action.elementId);
        }
        return getStructured(await runTool("scroll", payload)) || { ok: true };
      }
      if (action.type === "drag") {
        return getStructured(await runTool("drag", {
          pid,
          window_id: windowId,
          from_x: action.fromX,
          from_y: action.fromY,
          to_x: action.toX,
          to_y: action.toY,
        })) || { ok: true };
      }
      throw computerUseError(COMPUTER_USE_ERRORS.CAPABILITY_UNSUPPORTED, `Unsupported Cua action: ${action.type}`, { action: action.type });
    },

    async releaseLease() {
      return { released: true };
    },

    async stop() {
      return { stopped: true };
    },
  };
}
