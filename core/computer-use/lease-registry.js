import crypto from "crypto";
import { COMPUTER_USE_ERRORS, computerUseError } from "./errors.js";

function leaseKey(sessionPath, agentId, leaseId) {
  return `${sessionPath || ""}\0${agentId || ""}\0${leaseId}`;
}

export class ComputerLeaseRegistry {
  constructor({
    now = () => Date.now(),
    idFactory = () => crypto.randomUUID(),
    snapshotIdFactory = () => crypto.randomUUID(),
  } = {}) {
    this._now = now;
    this._idFactory = idFactory;
    this._snapshotIdFactory = snapshotIdFactory;
    this._leases = new Map();
    this._snapshots = new Map();
  }

  createLease(ctx, target) {
    const leaseId = target?.leaseId || this._idFactory();
    const lease = {
      leaseId,
      sessionPath: ctx?.sessionPath || null,
      agentId: ctx?.agentId || null,
      providerId: target.providerId,
      appId: target.appId,
      windowId: target.windowId || null,
      createdAt: new Date(this._now()).toISOString(),
      expiresAt: target.expiresAt || null,
      status: "active",
      allowedActions: Array.isArray(target.allowedActions) ? [...target.allowedActions] : [],
      providerState: target.providerState && typeof target.providerState === "object"
        ? structuredClone(target.providerState)
        : {},
    };
    this._leases.set(leaseKey(lease.sessionPath, lease.agentId, lease.leaseId), lease);
    return lease;
  }

  getActiveLease() {
    for (const lease of this._leases.values()) {
      if (lease.status === "active") return lease;
    }
    return null;
  }

  getActiveLeaseFor(ctx) {
    for (const lease of this._leases.values()) {
      if (
        lease.status === "active"
        && lease.sessionPath === (ctx?.sessionPath || null)
        && lease.agentId === (ctx?.agentId || null)
      ) {
        return lease;
      }
    }
    return null;
  }

  getLastLeaseFor(ctx) {
    let found = null;
    for (const lease of this._leases.values()) {
      if (
        lease.sessionPath === (ctx?.sessionPath || null)
        && lease.agentId === (ctx?.agentId || null)
      ) {
        found = lease;
      }
    }
    return found;
  }

  getLease(ctx, leaseId) {
    return this._leases.get(leaseKey(ctx?.sessionPath || null, ctx?.agentId || null, leaseId)) || null;
  }

  requireActiveLease(ctx, leaseId) {
    const lease = this.getLease(ctx, leaseId);
    if (!lease) {
      throw computerUseError(COMPUTER_USE_ERRORS.LEASE_NOT_FOUND, `Computer lease not found: ${leaseId}`);
    }
    if (lease.status !== "active") {
      throw computerUseError(COMPUTER_USE_ERRORS.LEASE_RELEASED, `Computer lease is not active: ${leaseId}`, { status: lease.status });
    }
    return lease;
  }

  releaseLease(ctx, leaseId) {
    const lease = this.getLease(ctx, leaseId);
    if (!lease) return false;
    lease.status = "released";
    return true;
  }

  releaseLeaseRecord(lease) {
    if (!lease) return false;
    lease.status = "released";
    return true;
  }

  markStopping(ctx, leaseId) {
    const lease = this.requireActiveLease(ctx, leaseId);
    lease.status = "stopping";
    return lease;
  }

  recordSnapshot(ctx, leaseId, snapshot) {
    const lease = this.requireActiveLease(ctx, leaseId);
    const snapshotId = snapshot?.snapshotId || this._snapshotIdFactory();
    const record = {
      ...snapshot,
      snapshotId,
      leaseId,
      sessionPath: lease.sessionPath,
      agentId: lease.agentId,
      capturedAt: snapshot?.capturedAt || new Date(this._now()).toISOString(),
    };
    this._snapshots.set(leaseKey(lease.sessionPath, lease.agentId, snapshotId), record);
    lease.lastSnapshotId = snapshotId;
    return record;
  }

  validateSnapshot(ctx, leaseId, snapshotId) {
    const lease = this.requireActiveLease(ctx, leaseId);
    const snapshot = this._snapshots.get(leaseKey(lease.sessionPath, lease.agentId, snapshotId));
    if (!snapshot || snapshot.leaseId !== leaseId) {
      throw computerUseError(COMPUTER_USE_ERRORS.STALE_SNAPSHOT, `Snapshot is stale or unknown: ${snapshotId}`, { leaseId, snapshotId });
    }
    if (lease.lastSnapshotId && lease.lastSnapshotId !== snapshotId) {
      throw computerUseError(COMPUTER_USE_ERRORS.STALE_SNAPSHOT, `Snapshot is not the latest snapshot for lease: ${leaseId}`, {
        leaseId,
        snapshotId,
        latestSnapshotId: lease.lastSnapshotId,
      });
    }
    return snapshot;
  }

  releaseBySession(sessionPath) {
    for (const lease of this._leases.values()) {
      if (lease.sessionPath === sessionPath && lease.status === "active") {
        lease.status = "released";
      }
    }
  }
}
