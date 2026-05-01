import { classifySessionPermission, normalizeSessionPermissionMode } from "../../core/session-permission-mode.js";
import { getToolSessionPath } from "./tool-session.js";
import { toolError, toolOk } from "./tool-result.js";

function findRuntimeCtx(args) {
  for (let i = args.length - 1; i >= 2; i--) {
    const value = args[i];
    if (value && typeof value === "object" && (value.sessionManager || value.sessionPath || value.agentId || value.model)) {
      return value;
    }
  }
  return null;
}

function buildToolApprovalRequest(confirmId, toolName, params) {
  return {
    type: "session_confirmation",
    confirmId,
    kind: "tool_action_approval",
    surface: "input",
    status: "pending",
    title: "允许 Hana 执行这次操作",
    body: "当前会话处于先问模式，这次操作会改变本地或外部状态。",
    subject: {
      label: toolName,
      detail: summarizeParams(params),
    },
    severity: "elevated",
    actions: {
      confirmLabel: "同意",
      rejectLabel: "拒绝",
    },
    payload: { toolName, params },
  };
}

function summarizeParams(params) {
  if (!params || typeof params !== "object") return "";
  const keys = ["action", "path", "file_path", "command", "url", "key", "label"];
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return `${key}: ${value.trim().slice(0, 160)}`;
  }
  return "";
}

function toStatus(action) {
  if (action === "confirmed") return "confirmed";
  if (action === "timeout") return "timeout";
  if (action === "aborted") return "aborted";
  return "rejected";
}

async function askForToolApproval(toolName, params, sessionPath, deps) {
  const confirmStore = deps.getConfirmStore?.() || deps.confirmStore || null;
  if (!confirmStore || !sessionPath) {
    return { allowed: false, status: "rejected", confirmId: "", reason: "confirmation-unavailable" };
  }
  const { confirmId, promise } = confirmStore.create(
    "tool_action_approval",
    { toolName, params },
    sessionPath,
  );
  deps.emitEvent?.({
    type: "session_confirmation",
    request: buildToolApprovalRequest(confirmId, toolName, params),
  }, sessionPath);
  const decision = await promise;
  const status = toStatus(decision?.action);
  return {
    allowed: status === "confirmed",
    status,
    confirmId,
  };
}

export function wrapWithSessionPermission(tools = [], deps = {}) {
  return tools.map((tool) => {
    if (!tool?.execute || tool._sessionPermissionWrapped) return tool;
    return {
      ...tool,
      _sessionPermissionWrapped: true,
      execute: async (...args) => {
        const params = args[1] || {};
        const ctx = findRuntimeCtx(args);
        const sessionPath = getToolSessionPath(ctx) || ctx?.sessionPath || deps.getSessionPath?.() || null;
        const mode = normalizeSessionPermissionMode(
          deps.getPermissionMode?.(sessionPath) || deps.getPermissionMode?.() || "ask",
        );
        const decision = classifySessionPermission({ mode, toolName: tool.name, params });
        if (decision.action === "allow") {
          return tool.execute(...args);
        }
        if (decision.action === "deny") {
          return toolError(decision.message, {
            errorCode: decision.code,
            permissionMode: mode,
            toolName: tool.name,
            ...(decision.details || {}),
          });
        }

        const approval = await askForToolApproval(tool.name, params, sessionPath, deps);
        if (!approval.allowed) {
          return toolOk("Tool action was not approved.", {
            action: tool.name,
            confirmed: false,
            confirmation: {
              kind: "tool_action_approval",
              status: approval.status,
              confirmId: approval.confirmId,
              toolName: tool.name,
              reason: approval.reason,
            },
          });
        }
        return tool.execute(...args);
      },
    };
  });
}
