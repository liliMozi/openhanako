export const COMPUTER_USE_DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  provider_by_platform: {
    darwin: "macos:cua",
    win32: "windows:uia",
    linux: "mock",
  },
  allow_windows_input_injection: false,
  app_approvals: [],
});

function normalizeProviderByPlatform(value) {
  const out = { ...COMPUTER_USE_DEFAULT_SETTINGS.provider_by_platform };
  if (!value || typeof value !== "object") return out;
  for (const key of ["darwin", "win32", "linux"]) {
    if (typeof value[key] === "string" && value[key].trim()) {
      out[key] = value[key].trim();
    }
  }
  return out;
}

function normalizeApproval(item) {
  if (!item || typeof item !== "object") return null;
  const providerId = typeof item.providerId === "string" ? item.providerId.trim() : "";
  const appId = typeof item.appId === "string" ? item.appId.trim() : "";
  if (!providerId || !appId) return null;
  return {
    providerId,
    appId,
    appName: typeof item.appName === "string" ? item.appName.trim() : "",
    scope: item.scope === "window" ? "window" : "app",
    approvedAt: typeof item.approvedAt === "string" && item.approvedAt
      ? item.approvedAt
      : new Date(0).toISOString(),
  };
}

export function normalizeComputerUseSettings(input = {}) {
  const approvals = Array.isArray(input.app_approvals)
    ? input.app_approvals.map(normalizeApproval).filter(Boolean)
    : [];
  const deduped = new Map();
  for (const approval of approvals) {
    deduped.set(`${approval.providerId}\0${approval.appId}`, approval);
  }
  return {
    enabled: input.enabled === true,
    provider_by_platform: normalizeProviderByPlatform(input.provider_by_platform),
    allow_windows_input_injection: input.allow_windows_input_injection === true,
    app_approvals: [...deduped.values()],
  };
}

export function isComputerUseAppApproved(settings, { providerId, appId } = {}) {
  if (!providerId || !appId) return false;
  const normalized = normalizeComputerUseSettings(settings);
  return normalized.app_approvals.some((approval) =>
    approval.providerId === providerId && approval.appId === appId
  );
}

export function approveComputerUseApp(settings, approval, { now = () => new Date().toISOString() } = {}) {
  const normalized = normalizeComputerUseSettings(settings);
  const nextApproval = normalizeApproval({
    ...approval,
    approvedAt: approval?.approvedAt || now(),
  });
  if (!nextApproval) {
    throw new Error("computer use approval requires providerId and appId");
  }
  return normalizeComputerUseSettings({
    ...normalized,
    app_approvals: [
      ...normalized.app_approvals.filter((item) =>
        item.providerId !== nextApproval.providerId || item.appId !== nextApproval.appId
      ),
      nextApproval,
    ],
  });
}

export function revokeComputerUseApp(settings, { providerId, appId } = {}) {
  const normalized = normalizeComputerUseSettings(settings);
  return normalizeComputerUseSettings({
    ...normalized,
    app_approvals: normalized.app_approvals.filter((item) =>
      item.providerId !== providerId || item.appId !== appId
    ),
  });
}
