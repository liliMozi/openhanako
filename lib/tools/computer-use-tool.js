import { Type, StringEnum } from "../pi-sdk/index.js";
import { toolOk } from "./tool-result.js";
import { getToolSessionPath } from "./tool-session.js";
import {
  COMPUTER_USE_ERRORS,
  computerUseError,
  serializeComputerUseError,
} from "../../core/computer-use/errors.js";

function errorResult(err) {
  const serialized = serializeComputerUseError(err);
  return {
    content: [{ type: "text", text: serialized.message }],
    details: {
      error: serialized.message,
      errorCode: serialized.code,
      ...serialized.details,
    },
  };
}

function textResult(text, details = {}) {
  return toolOk(text, details);
}

function resolveToolCtx(ctx, options) {
  const sessionPath = getToolSessionPath(ctx);
  const model = ctx?.model || options.getSessionModel?.(sessionPath) || null;
  const agentId = ctx?.agentId || options.getAgentId?.(sessionPath) || null;
  return { sessionPath, agentId, model };
}

function actionTarget(params) {
  const fromX = params.fromX ?? params.from_x;
  const fromY = params.fromY ?? params.from_y;
  const toX = params.toX ?? params.to_x;
  const toY = params.toY ?? params.to_y;
  if (params.action === "drag" && [fromX, fromY, toX, toY].every((value) => typeof value === "number")) {
    return { coordinateSpace: "window", fromX, fromY, toX, toY };
  }
  if (params.elementId) {
    return { coordinateSpace: "element", elementId: params.elementId };
  }
  if (typeof params.x === "number" && typeof params.y === "number") {
    return { coordinateSpace: "window", x: params.x, y: params.y };
  }
  return undefined;
}

function emitComputerOverlay(options, toolCtx, phase, action, patch = {}) {
  if (!toolCtx.sessionPath) return;
  options.emitEvent?.({
    type: "computer_overlay",
    phase,
    action,
    sessionPath: toolCtx.sessionPath,
    agentId: toolCtx.agentId || null,
    ts: Date.now(),
    ...patch,
  }, toolCtx.sessionPath);
}

function buildComputerAppApprovalRequest(confirmId, approval, status = "pending") {
  return {
    type: "session_confirmation",
    confirmId,
    kind: "computer_app_approval",
    surface: "input",
    status,
    title: "允许 Hana 使用电脑",
    body: "Hana 想控制这个应用来继续当前任务。",
    subject: {
      label: approval.appName || approval.appId,
      detail: `${approval.providerId} · ${approval.appId}`,
    },
    severity: "elevated",
    actions: {
      confirmLabel: "同意",
      rejectLabel: "拒绝",
    },
    payload: { approval },
  };
}

function resolveAppApproval(params, serializedError) {
  const providerId = serializedError?.details?.providerId || params.providerId || "";
  const appId = serializedError?.details?.appId || params.appId || "";
  if (!providerId || !appId) return null;
  return {
    providerId,
    appId,
    appName: params.appName || params.name || appId,
    scope: "app",
  };
}

function normalizeAppLookup(value) {
  return String(value || "").trim().toLowerCase();
}

function appLookupValues(app) {
  return [
    app?.name,
    app?.appName,
    app?.appId,
    app?.id,
    app?.bundleId,
    app?.providerData?.bundleId,
  ].map(normalizeAppLookup).filter(Boolean);
}

function lookupTokens(value) {
  return normalizeAppLookup(value)
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

function scoreAppNameMatch(app, requestedName) {
  const query = normalizeAppLookup(requestedName);
  if (!query) return 0;
  const values = appLookupValues(app);
  if (values.some((value) => value === query)) return 100;
  if (values.some((value) => value.endsWith(`.${query}`))) return 90;
  if (values.some((value) => value.includes(query) || query.includes(value))) return 80;

  const queryTokens = lookupTokens(query);
  if (!queryTokens.length) return 0;
  const haystack = values.join(" ");
  return queryTokens.every((token) => haystack.includes(token)) ? 70 : 0;
}

function findAppByName(apps, requestedName) {
  const matches = (Array.isArray(apps) ? apps : [])
    .map((app) => ({ app, score: scoreAppNameMatch(app, requestedName) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!matches.length) return null;
  const bestScore = matches[0].score;
  const best = matches.filter((entry) => entry.score === bestScore);
  return best.length === 1 ? best[0].app : null;
}

function firstWindowId(app) {
  const windowId = app?.windows?.[0]?.windowId;
  return windowId ? String(windowId) : null;
}

async function resolveStartTarget(toolCtx, host, params) {
  const target = {
    providerId: params.providerId,
    appId: params.appId,
    appName: params.appName || params.name || null,
    name: params.name || params.appName || null,
    windowId: params.windowId,
  };
  if (target.appId || !target.appName) return target;

  const apps = await host.listApps(toolCtx, target.providerId);
  const app = findAppByName(apps, target.appName);
  if (!app?.appId) {
    throw computerUseError(
      COMPUTER_USE_ERRORS.TARGET_NOT_FOUND,
      `Computer Use could not resolve app name to an app id: ${target.appName}`,
      { providerId: target.providerId || null, appName: target.appName },
    );
  }

  return {
    ...target,
    appId: app.appId,
    appName: app.name || target.appName,
    name: app.name || target.name,
    windowId: target.windowId || firstWindowId(app) || undefined,
  };
}

function toConfirmationStatus(action) {
  if (action === "confirmed") return "confirmed";
  if (action === "timeout") return "timeout";
  if (action === "aborted") return "aborted";
  return "rejected";
}

async function createLeaseWithAppApproval(options, toolCtx, host, params) {
  const target = await resolveStartTarget(toolCtx, host, params);

  try {
    return {
      lease: await host.createLease(toolCtx, target),
      confirmation: null,
      confirmed: true,
    };
  } catch (err) {
    const serialized = serializeComputerUseError(err);
    if (serialized.code !== COMPUTER_USE_ERRORS.APP_APPROVAL_REQUIRED) throw err;

    const confirmStore = options.getConfirmStore?.() || options.confirmStore || null;
    const approveComputerUseApp = options.approveComputerUseApp;
    const approval = resolveAppApproval(target, serialized);
    if (!toolCtx.sessionPath || !confirmStore || typeof approveComputerUseApp !== "function" || !approval) {
      throw err;
    }

    const { confirmId, promise } = confirmStore.create(
      "computer_app_approval",
      { approval },
      toolCtx.sessionPath,
    );
    const request = buildComputerAppApprovalRequest(confirmId, approval);
    options.emitEvent?.({ type: "session_confirmation", request }, toolCtx.sessionPath);

    const decision = await promise;
    const status = toConfirmationStatus(decision?.action);
    const confirmation = { kind: "computer_app_approval", status, approval, confirmId };
    if (status !== "confirmed") {
      return { lease: null, confirmation, confirmed: false };
    }

    approveComputerUseApp(approval);
    return {
      lease: await host.createLease(toolCtx, target),
      confirmation,
      confirmed: true,
    };
  }
}

async function withActionOverlay(options, toolCtx, params, fn) {
  const presentation = params.presentation || {};
  const base = {
    leaseId: params.leaseId,
    snapshotId: params.snapshotId,
    target: actionTarget(params),
    inputMode: presentation.inputMode || "background",
    requiresForeground: presentation.requiresForeground === true,
    interruptKey: presentation.interruptKey || null,
    visualSurface: presentation.visualSurface === "provider" ? "provider" : "renderer",
  };
  emitComputerOverlay(options, toolCtx, "preview", params.action, base);
  emitComputerOverlay(options, toolCtx, "running", params.action, base);
  try {
    const result = await fn();
    const resultMode = result?.mode === "foreground-input" ? {
      inputMode: "foreground-input",
      requiresForeground: true,
      interruptKey: "Escape",
    } : {};
    emitComputerOverlay(options, toolCtx, "done", params.action, { ...base, ...resultMode });
    return result;
  } catch (err) {
    const serialized = serializeComputerUseError(err);
    emitComputerOverlay(options, toolCtx, "error", params.action, {
      ...base,
      errorCode: serialized.code,
    });
    throw err;
  }
}

function resolveCurrentLeaseParams(host, toolCtx, params = {}) {
  const activeLease = params.leaseId ? null : host.getActiveLease?.(toolCtx);
  return {
    leaseId: params.leaseId || activeLease?.leaseId,
    snapshotId: params.snapshotId || activeLease?.lastSnapshotId,
  };
}

function elementText(element = {}) {
  return [
    element.label,
    element.value,
    element.description,
    element.title,
  ].map((value) => String(value || "").trim()).filter(Boolean).join(" · ");
}

function formatElementSummary(elements = [], { limit = 60 } = {}) {
  const rows = (Array.isArray(elements) ? elements : [])
    .map((element) => ({
      elementId: String(element.elementId || ""),
      role: String(element.role || "element"),
      text: elementText(element),
      enabled: element.enabled !== false,
    }))
    .filter((element) => element.elementId && (element.text || element.enabled))
    .slice(0, limit);

  if (!rows.length) return "No labeled UI elements were exposed by this app snapshot.";
  const lines = rows.map((element) => {
    const disabled = element.enabled ? "" : " disabled";
    const label = element.text ? ` \"${element.text}\"` : "";
    return `- ${element.elementId}: ${element.role}${label}${disabled}`;
  });
  if (Array.isArray(elements) && elements.length > rows.length) {
    lines.push(`- ... ${elements.length - rows.length} more elements omitted`);
  }
  return lines.join("\n");
}

function buildActionGuidance(snapshot) {
  const allowedActions = Array.isArray(snapshot.allowedActions) ? snapshot.allowedActions : [];
  const hasExplicitActions = allowedActions.length > 0;
  const allowsElementClicks = !hasExplicitActions
    || allowedActions.includes("click_element")
    || allowedActions.includes("perform_secondary_action");
  const allowsCoordinateClicks = allowedActions.includes("click_point") || allowedActions.includes("double_click");

  if (!allowsElementClicks && allowsCoordinateClicks) {
    return [
      "- Use screenshot coordinates with click_point or double_click. Coordinates are x/y pixels in the screenshot, with the top-left as 0,0.",
      "- Element ids are for reading only on this provider; do not pass elementId to click_element, double_click, type_text, scroll, or perform_secondary_action.",
    ].join("\n");
  }

  return "- Use element ids with click_element, double_click, type_text, scroll, or perform_secondary_action. Media lists often require double_click to open or play.";
}

function buildAppStateText(snapshot) {
  return [
    "Current Computer Use state:",
    `- leaseId: ${snapshot.leaseId}`,
    `- snapshotId: ${snapshot.snapshotId}`,
    `- appId: ${snapshot.appId || "unknown"}`,
    `- windowId: ${snapshot.windowId || "unknown"}`,
    buildActionGuidance(snapshot),
    "Visible/labeled elements:",
    formatElementSummary(snapshot.elements),
  ].join("\n");
}

export function createComputerUseTool(options = {}) {
  return {
    name: "computer",
    label: "Computer Use",
    description: "Inspect and control an approved desktop app or window through Hana Computer Use.",
    parameters: Type.Object({
      action: StringEnum([
        "status",
        "list_apps",
        "start",
        "get_app_state",
        "click_element",
        "double_click",
        "click_point",
        "type_text",
        "press_key",
        "scroll",
        "drag",
        "perform_secondary_action",
        "stop",
      ]),
      providerId: Type.Optional(Type.String()),
      leaseId: Type.Optional(Type.String()),
      snapshotId: Type.Optional(Type.String()),
      appId: Type.Optional(Type.String()),
      appName: Type.Optional(Type.String()),
      windowId: Type.Optional(Type.String()),
      elementId: Type.Optional(Type.String()),
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
      text: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
      direction: Type.Optional(StringEnum(["up", "down", "left", "right"])),
      amount: Type.Optional(Type.Number()),
      fromX: Type.Optional(Type.Number()),
      fromY: Type.Optional(Type.Number()),
      toX: Type.Optional(Type.Number()),
      toY: Type.Optional(Type.Number()),
      from_x: Type.Optional(Type.Number()),
      from_y: Type.Optional(Type.Number()),
      to_x: Type.Optional(Type.Number()),
      to_y: Type.Optional(Type.Number()),
    }),

    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        const toolCtx = resolveToolCtx(ctx, options);
        if (options.isAgentToolEnabled && !options.isAgentToolEnabled(toolCtx)) {
          throw computerUseError(
            COMPUTER_USE_ERRORS.DISABLED,
            "Computer Use is disabled for this agent.",
            { agentId: toolCtx.agentId || null },
          );
        }
        const host = options.getComputerHost?.();
        if (!host) throw new Error("ComputerHost is unavailable");

        switch (params.action) {
          case "status": {
            const status = await host.getStatus(toolCtx);
            return textResult("Computer Use status loaded.", { action: "status", status });
          }
          case "list_apps": {
            const apps = await host.listApps(toolCtx, params.providerId);
            return textResult(JSON.stringify(apps, null, 2), { action: "list_apps", apps });
          }
          case "start": {
            const { lease, confirmation, confirmed } = await createLeaseWithAppApproval(options, toolCtx, host, params);
            if (!lease) {
              return textResult("Computer Use app approval was not granted.", {
                action: "start",
                confirmed,
                confirmation,
              });
            }
            return textResult(`Computer Use lease started: ${lease.leaseId}`, {
              action: "start",
              ...lease,
              ...(confirmation ? { confirmation } : {}),
            });
          }
          case "get_app_state": {
            const leaseParams = resolveCurrentLeaseParams(host, toolCtx, params);
            const presentation = host.getActionPresentation?.(toolCtx, leaseParams.leaseId, "get_app_state") || {};
            const visualSurface = presentation.visualSurface === "provider" ? "provider" : "renderer";
            emitComputerOverlay(options, toolCtx, "running", "get_app_state", {
              leaseId: leaseParams.leaseId,
              visualSurface,
            });
            const snapshot = await host.getAppState(toolCtx, leaseParams.leaseId);
            emitComputerOverlay(options, toolCtx, "done", "get_app_state", {
              leaseId: snapshot.leaseId,
              snapshotId: snapshot.snapshotId,
              visualSurface,
            });
            return {
              content: [
                { type: "text", text: buildAppStateText(snapshot) },
                snapshot.screenshot,
              ],
              details: {
                action: "get_app_state",
                snapshotId: snapshot.snapshotId,
                leaseId: snapshot.leaseId,
                appId: snapshot.appId,
                windowId: snapshot.windowId,
                providerId: snapshot.providerId,
                allowedActions: snapshot.allowedActions,
                elements: snapshot.elements,
                display: snapshot.display,
              },
            };
          }
          case "click_element":
          case "double_click":
          case "click_point":
          case "type_text":
          case "press_key":
          case "scroll":
          case "drag":
          case "perform_secondary_action": {
            const leaseParams = resolveCurrentLeaseParams(host, toolCtx, params);
            const fromX = params.fromX ?? params.from_x;
            const fromY = params.fromY ?? params.from_y;
            const toX = params.toX ?? params.to_x;
            const toY = params.toY ?? params.to_y;
            const presentation = host.getActionPresentation?.(toolCtx, leaseParams.leaseId, params.action) || {};
            const result = await withActionOverlay(options, toolCtx, {
              ...params,
              ...leaseParams,
              presentation,
            }, () => host.performAction(toolCtx, leaseParams.leaseId, {
              type: params.action,
              snapshotId: leaseParams.snapshotId,
              elementId: params.elementId,
              x: params.x,
              y: params.y,
              text: params.text,
              key: params.key,
              direction: params.direction,
              amount: params.amount,
              fromX,
              fromY,
              toX,
              toY,
            }));
            return textResult(`Computer action completed: ${params.action}`, { action: params.action, result });
          }
          case "stop": {
            const leaseParams = resolveCurrentLeaseParams(host, toolCtx, params);
            await host.stop(toolCtx, leaseParams.leaseId);
            emitComputerOverlay(options, toolCtx, "clear", "stop", {
              leaseId: leaseParams.leaseId,
            });
            return textResult("Computer Use stopped.", { action: "stop", leaseId: leaseParams.leaseId });
          }
          default:
            throw new Error(`Unknown computer action: ${params.action}`);
        }
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}
