import { COMPUTER_USE_ERRORS, computerUseError } from "./errors.js";
import { assertComputerUseModelSupported } from "./model-policy.js";
import { ComputerLeaseRegistry } from "./lease-registry.js";
import { resolveComputerProviderId } from "./provider-contract.js";
import { isComputerUseAppApproved, normalizeComputerUseSettings } from "./settings.js";
import { ACCESS_MODE_READ_ONLY, normalizeAccessMode } from "../config-coordinator.js";

const ACTION_CAPABILITY = {
  click_element: "elementActions",
  double_click: "pointClick",
  type_text: "elementActions",
  press_key: "keyboardInput",
  scroll: "elementActions",
  click_point: "pointClick",
  drag: "drag",
  perform_secondary_action: "elementActions",
};

const CAPABILITY_ALLOWED_VALUES = new Set([
  true,
  "allowed",
  "semantic",
  "focused",
  "pidScoped",
]);

const FOREGROUND_CAPABILITY_VALUES = new Set(["foreground"]);

function sameLeaseOwner(lease, ctx = {}) {
  return lease?.sessionPath === (ctx?.sessionPath || null)
    && lease?.agentId === (ctx?.agentId || null);
}

function targetAppId(target = {}) {
  return target.appId
    || (target.pid || target.processId ? `pid:${target.pid || target.processId}` : null)
    || null;
}

function cloneLease(lease) {
  if (!lease) return null;
  return {
    ...lease,
    allowedActions: Array.isArray(lease.allowedActions) ? [...lease.allowedActions] : [],
    providerState: lease.providerState && typeof lease.providerState === "object"
      ? structuredClone(lease.providerState)
      : {},
  };
}

function findSnapshotElement(snapshot, elementId) {
  if (!elementId || !Array.isArray(snapshot?.elements)) return null;
  return snapshot.elements.find((element) => String(element?.elementId) === String(elementId)) || null;
}

function capabilityKeyForAction(capabilities, action = {}) {
  if (action?.type === "double_click" && action?.elementId && capabilities?.elementDoubleClick !== undefined) {
    return "elementDoubleClick";
  }
  return ACTION_CAPABILITY[action?.type];
}

export class ComputerHost {
  constructor({
    providers,
    defaultProviderId,
    leases = new ComputerLeaseRegistry(),
    platform = process.platform,
    getSettings = () => ({}),
    getAccessMode = () => "operate",
    getPrimaryAgentId = () => null,
  }) {
    if (!providers) throw new Error("ComputerHost requires providers");
    this._providers = providers;
    this._defaultProviderId = defaultProviderId;
    this._leases = leases;
    this._platform = platform;
    this._getSettings = getSettings;
    this._getAccessMode = getAccessMode;
    this._getPrimaryAgentId = getPrimaryAgentId;
  }

  async getStatus(ctx = {}) {
    const providers = [];
    for (const provider of this._providers.list()) {
      providers.push({
        providerId: provider.providerId,
        capabilities: provider.capabilities,
        status: provider.getStatus ? await provider.getStatus(ctx) : { available: true },
      });
    }
    const settings = this._settings();
    const selectedProviderId = this._resolveProviderId(ctx, {});
    const activeLease = this._leases.getActiveLease?.() || null;
    return {
      enabled: settings.enabled === true,
      platform: this._platform,
      defaultProviderId: this._defaultProviderId,
      selectedProviderId,
      providers,
      activeLease: activeLease ? {
        leaseId: activeLease.leaseId,
        sessionPath: activeLease.sessionPath,
        agentId: activeLease.agentId,
        providerId: activeLease.providerId,
        appId: activeLease.appId,
        windowId: activeLease.windowId,
        createdAt: activeLease.createdAt,
      } : null,
    };
  }

  getActiveLease(ctx = {}) {
    return cloneLease(this._leases.getActiveLeaseFor?.(ctx) || null);
  }

  async listApps(ctx = {}, providerId = null) {
    this._assertRuntimeAllowed(ctx);
    assertComputerUseModelSupported(ctx.model);
    const provider = this._providers.require(this._resolveProviderId(ctx, { providerId }));
    return await provider.listApps(ctx);
  }

  async createLease(ctx, target = {}) {
    this._assertRuntimeAllowed(ctx);
    assertComputerUseModelSupported(ctx.model);
    const providerId = this._resolveProviderId(ctx, target);
    const activeLease = await this._reuseOrReplaceActiveLease(ctx, providerId, target);
    if (activeLease) return activeLease;
    const provider = this._providers.require(providerId);
    this._assertAppApproved(provider, providerId, target);
    const providerLease = await provider.createLease?.(ctx, target);
    return this._leases.createLease(ctx, {
      providerId,
      appId: providerLease?.appId || target.appId,
      windowId: providerLease?.windowId || target.windowId || null,
      allowedActions: providerLease?.allowedActions || ["click_element", "double_click", "type_text", "press_key", "scroll", "perform_secondary_action", "stop"],
      providerState: providerLease?.providerState || {},
    });
  }

  async releaseLease(ctx, leaseId) {
    const lease = this._leases.getLease(ctx, leaseId);
    if (!lease) return false;
    const provider = this._providers.require(lease.providerId);
    await provider.releaseLease?.(ctx, lease);
    return this._leases.releaseLease(ctx, leaseId);
  }

  async getAppState(ctx, leaseId) {
    this._assertRuntimeAllowed(ctx);
    assertComputerUseModelSupported(ctx.model);
    const lease = this._resolveActiveLease(ctx, leaseId);
    const provider = this._providers.require(lease.providerId);
    const raw = await provider.getAppState(ctx, lease);
    return this._leases.recordSnapshot(ctx, lease.leaseId, {
      ...raw,
      leaseId: lease.leaseId,
      providerId: lease.providerId,
      allowedActions: Array.isArray(lease.allowedActions) ? [...lease.allowedActions] : [],
      mode: raw.mode || "vision-native",
    });
  }

  async performAction(ctx, leaseId, action) {
    this._assertRuntimeAllowed(ctx);
    assertComputerUseModelSupported(ctx.model);
    const lease = this._resolveActiveLease(ctx, leaseId);
    const snapshotId = action?.snapshotId || lease.lastSnapshotId;
    const snapshot = this._leases.validateSnapshot(ctx, lease.leaseId, snapshotId);
    if (lease.allowedActions.length && !lease.allowedActions.includes(action?.type)) {
      throw computerUseError(COMPUTER_USE_ERRORS.ACTION_BLOCKED_BY_POLICY, `Action blocked by lease policy: ${action?.type}`, {
        action: action?.type,
        allowedActions: lease.allowedActions,
      });
    }

    const provider = this._providers.require(lease.providerId);
    this._assertCapability(provider.capabilities, action);
    const providerAction = {
      ...action,
      snapshotId,
      snapshotDisplay: snapshot?.display || null,
    };
    if (action?.elementId) {
      const snapshotElement = findSnapshotElement(snapshot, action.elementId);
      if (!snapshotElement) {
        throw computerUseError(
          COMPUTER_USE_ERRORS.TARGET_NOT_FOUND,
          `Element not found in snapshot: ${action.elementId}`,
          { leaseId: lease.leaseId, snapshotId, elementId: action.elementId },
        );
      }
      providerAction.snapshotElement = snapshotElement;
    }
    return await provider.performAction(ctx, lease, providerAction);
  }

  getActionPresentation(ctx, leaseId, actionType) {
    const lease = leaseId
      ? this._leases.getLease(ctx, leaseId)
      : this._leases.getActiveLeaseFor?.(ctx);
    if (!lease) return {};
    const provider = this._providers.require(lease.providerId);
    const capabilityKey = ACTION_CAPABILITY[actionType];
    const capabilityValue = capabilityKey ? provider.capabilities?.[capabilityKey] : null;
    const requiresForeground = FOREGROUND_CAPABILITY_VALUES.has(capabilityValue);
    return {
      providerId: lease.providerId,
      inputMode: requiresForeground ? "foreground-input" : "background",
      requiresForeground,
      interruptKey: requiresForeground ? "Escape" : null,
      visualSurface: provider.capabilities?.nativeCursor === true ? "provider" : "renderer",
    };
  }

  async stop(ctx, leaseId) {
    const lease = leaseId
      ? this._leases.getLease(ctx, leaseId)
      : this._leases.getActiveLeaseFor?.(ctx);
    if (!lease) return false;
    const provider = this._providers.require(lease.providerId);
    await provider.stop?.(ctx, lease);
    return this._leases.releaseLease(ctx, lease.leaseId);
  }

  abortSession(sessionPath) {
    this._leases.releaseBySession(sessionPath);
  }

  async requestPermissions(ctx = {}, providerId = null) {
    const resolvedProviderId = this._resolveProviderId(ctx, { providerId });
    const provider = this._providers.require(resolvedProviderId);
    if (typeof provider.requestPermissions === "function") {
      return await provider.requestPermissions(ctx);
    }
    return provider.getStatus ? await provider.getStatus({ ...ctx, prompt: true }) : { available: true, permissions: [] };
  }

  _settings() {
    return normalizeComputerUseSettings(this._getSettings?.() || {});
  }

  _assertRuntimeAllowed(ctx = {}) {
    const settings = this._settings();
    if (settings.enabled !== true) {
      throw computerUseError(
        COMPUTER_USE_ERRORS.DISABLED,
        "Computer Use is turned off in global settings.",
        { reason: "global-disabled" },
      );
    }
    const primaryAgentId = this._getPrimaryAgentId?.() || null;
    if (primaryAgentId && ctx?.agentId && ctx.agentId !== primaryAgentId) {
      throw computerUseError(
        COMPUTER_USE_ERRORS.DISABLED,
        "Computer Use is only available to the main agent.",
        { reason: "not-primary-agent", agentId: ctx.agentId, primaryAgentId },
      );
    }
    const accessMode = normalizeAccessMode(ctx?.accessMode || this._getAccessMode?.(ctx?.sessionPath));
    if (accessMode === ACCESS_MODE_READ_ONLY) {
      throw computerUseError(
        COMPUTER_USE_ERRORS.DISABLED,
        "Computer Use is unavailable in read-only sessions.",
        { reason: "read-only-session", accessMode },
      );
    }
  }

  _resolveActiveLease(ctx = {}, leaseId) {
    if (leaseId) return this._leases.requireActiveLease(ctx, leaseId);
    const lease = this._leases.getActiveLeaseFor?.(ctx);
    if (lease) return lease;
    const lastLease = this._leases.getLastLeaseFor?.(ctx);
    if (lastLease && lastLease.status !== "active") {
      throw computerUseError(
        COMPUTER_USE_ERRORS.LEASE_RELEASED,
        `Computer lease is not active: ${lastLease.leaseId}`,
        { status: lastLease.status, leaseId: lastLease.leaseId },
      );
    }
    throw computerUseError(
      COMPUTER_USE_ERRORS.LEASE_NOT_FOUND,
      "Computer lease not found for current session.",
      {
        reason: "missing-lease-id",
        requestedSessionPath: ctx?.sessionPath || null,
        requestedAgentId: ctx?.agentId || null,
      },
    );
  }

  async _reuseOrReplaceActiveLease(ctx = {}, providerId, target = {}) {
    const activeLease = this._leases.getActiveLease?.();
    if (!activeLease) return;
    if (
      sameLeaseOwner(activeLease, ctx)
      && this._leaseMatchesTarget(activeLease, providerId, target)
    ) {
      return activeLease;
    }
    this._releaseLeaseForTakeover(activeLease);
    return null;
  }

  _releaseLeaseForTakeover(lease) {
    this._leases.releaseLeaseRecord?.(lease);
    let provider = null;
    try {
      provider = this._providers.require(lease.providerId);
    } catch {
      return;
    }
    const leaseCtx = {
      sessionPath: lease.sessionPath || null,
      agentId: lease.agentId || null,
    };
    void (async () => {
      try {
        await provider.stop?.(leaseCtx, lease);
      } catch {
        // Takeover is intentionally fail-open: the new one-shot Computer
        // Use request should not be blocked by cleanup of an older lease.
      }
      try {
        await provider.releaseLease?.(leaseCtx, lease);
      } catch {
        // Same fail-open policy as provider.stop above.
      }
    })();
  }

  _leaseMatchesTarget(lease, providerId, target = {}) {
    if (!lease || lease.providerId !== providerId) return false;
    const appId = targetAppId(target);
    if (appId && lease.appId !== appId) return false;
    const windowId = target.windowId ? String(target.windowId) : null;
    if (windowId && String(lease.windowId || "") !== windowId) return false;
    return Boolean(appId || windowId);
  }

  _assertCapability(capabilities, action) {
    const actionType = typeof action === "string" ? action : action?.type;
    const key = typeof action === "string"
      ? ACTION_CAPABILITY[actionType]
      : capabilityKeyForAction(capabilities, action);
    if (!key) return;
    const value = capabilities?.[key];
    if (CAPABILITY_ALLOWED_VALUES.has(value)) return;
    if (value === "foreground") {
      throw computerUseError(COMPUTER_USE_ERRORS.ACTION_REQUIRES_FOREGROUND, `Computer action requires foreground input: ${actionType}`, {
        action: actionType,
        capability: key,
        value,
      });
    }
    if (value === "requiresApproval") {
      throw computerUseError(COMPUTER_USE_ERRORS.ACTION_REQUIRES_INPUT_INJECTION_APPROVAL, `Computer action requires explicit input-injection approval: ${actionType}`, {
        action: actionType,
        capability: key,
        value,
      });
    }
    throw computerUseError(COMPUTER_USE_ERRORS.CAPABILITY_UNSUPPORTED, `Computer provider does not support action: ${actionType}`, {
      action: actionType,
      capability: key,
      value,
    });
  }

  _resolveProviderId(ctx = {}, target = {}) {
    return resolveComputerProviderId({
      explicitProviderId: target?.providerId || ctx?.providerId || null,
      settings: this._getSettings?.() || {},
      platform: this._platform,
      defaultProviderId: this._defaultProviderId,
      hasProvider: (providerId) => this._providers.has(providerId),
    });
  }

  _assertAppApproved(provider, providerId, target = {}) {
    if (provider.capabilities?.isolated === true) return;
    const appId = target.appId
      || (target.pid || target.processId ? `pid:${target.pid || target.processId}` : null)
      || target.name
      || target.appName
      || null;
    if (appId && isComputerUseAppApproved(this._getSettings?.() || {}, { providerId, appId })) return;
    throw computerUseError(
      COMPUTER_USE_ERRORS.APP_APPROVAL_REQUIRED,
      "Computer Use requires app approval before controlling this target.",
      { providerId, appId },
    );
  }
}
