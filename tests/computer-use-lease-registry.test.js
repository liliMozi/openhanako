import { describe, expect, it } from "vitest";
import { ComputerLeaseRegistry } from "../core/computer-use/lease-registry.js";
import { COMPUTER_USE_ERRORS } from "../core/computer-use/errors.js";

const ctx = { sessionPath: "/tmp/a.jsonl", agentId: "hana" };

describe("ComputerLeaseRegistry", () => {
  it("creates leases keyed by sessionPath and agentId", () => {
    const registry = new ComputerLeaseRegistry({ now: () => 1000, idFactory: () => "lease-1" });
    const lease = registry.createLease(ctx, {
      providerId: "mock",
      appId: "app.notes",
      windowId: "win-1",
      allowedActions: ["click_element"],
      providerState: { pid: 42 },
    });

    expect(lease).toMatchObject({
      leaseId: "lease-1",
      sessionPath: "/tmp/a.jsonl",
      agentId: "hana",
      providerId: "mock",
      appId: "app.notes",
      windowId: "win-1",
      status: "active",
      allowedActions: ["click_element"],
      providerState: { pid: 42 },
    });
    expect(registry.getLease(ctx, "lease-1")).toEqual(lease);
  });

  it("does not let another session read a lease", () => {
    const registry = new ComputerLeaseRegistry({ idFactory: () => "lease-1" });
    registry.createLease(ctx, { providerId: "mock", appId: "app.notes" });

    expect(() => registry.requireActiveLease({
      sessionPath: "/tmp/b.jsonl",
      agentId: "hana",
    }, "lease-1")).toThrow(COMPUTER_USE_ERRORS.LEASE_NOT_FOUND);
  });

  it("records snapshot ownership and rejects stale snapshot ids", () => {
    const registry = new ComputerLeaseRegistry({
      idFactory: () => "lease-1",
      snapshotIdFactory: () => "snapshot-1",
    });
    registry.createLease(ctx, { providerId: "mock", appId: "app.notes" });
    const snapshot = registry.recordSnapshot(ctx, "lease-1", { appId: "app.notes" });

    expect(snapshot.snapshotId).toBe("snapshot-1");
    expect(() => registry.validateSnapshot(ctx, "lease-1", "snapshot-1")).not.toThrow();
    expect(() => registry.validateSnapshot(ctx, "lease-1", "old-snapshot")).toThrow(COMPUTER_USE_ERRORS.STALE_SNAPSHOT);
  });

  it("releases a lease and rejects later active access", () => {
    const registry = new ComputerLeaseRegistry({ idFactory: () => "lease-1" });
    registry.createLease(ctx, { providerId: "mock", appId: "app.notes" });
    registry.releaseLease(ctx, "lease-1");

    expect(() => registry.requireActiveLease(ctx, "lease-1")).toThrow(COMPUTER_USE_ERRORS.LEASE_RELEASED);
  });
});
