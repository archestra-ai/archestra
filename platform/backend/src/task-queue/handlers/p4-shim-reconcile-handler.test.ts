// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The convergence backstop. The shim lifecycle is event-driven, and those
 * events cross a network from a process that can die between the database
 * write and the Kubernetes one — so what this sweep does with the difference
 * between "what the rows want" and "what the cluster holds" is the guarantee
 * that a lost call is not lost forever.
 */

let enabled = true;
const listShims = vi.fn(
  async () => [] as Array<{ scope: string; ageMs: number }>,
);
const reconcile = vi.fn(async (_connectorId: string) => {});
const findEnabled = vi.fn(async () => [] as Array<{ id: string }>);

vi.mock("@/k8s/p4-shim-runtime/manager", () => ({
  p4ShimRuntimeManager: {
    isEnabled: () => enabled,
    listShims: () => listShims(),
  },
}));

vi.mock("@/knowledge-base/connectors/perforce/p4-shim-service", () => ({
  reconcileP4ShimForConnector: (connectorId: string) => reconcile(connectorId),
}));

vi.mock("@/models", () => ({
  KnowledgeBaseConnectorModel: {
    findEnabledAutoSyncPermissions: () => findEnabled(),
  },
}));

import { handleP4ShimReconcile } from "./p4-shim-reconcile-handler";

const WANTED = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const ABANDONED = "11112222-3333-4444-5555-666677778888";
const HOUR_MS = 60 * 60_000;

/** Which connector ids the sweep decided to act on. */
function reconciled(): string[] {
  return reconcile.mock.calls.map((call) => call[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  enabled = true;
  listShims.mockResolvedValue([]);
  findEnabled.mockResolvedValue([]);
});

describe("handleP4ShimReconcile", () => {
  it("reconciles every connector that syncs Perforce permissions", async () => {
    findEnabled.mockResolvedValue([{ id: WANTED }]);

    await handleP4ShimReconcile();

    // Not gated on "is there already a Deployment": a shim can be present but
    // wrong — a retired token, settings an edit replaced, a Deployment scaled
    // by hand — and re-applying the desired state repairs all of those.
    expect(reconciled()).toEqual([WANTED]);
  });

  it("removes a shim no connector claims", async () => {
    listShims.mockResolvedValue([{ scope: ABANDONED, ageMs: HOUR_MS }]);

    await handleP4ShimReconcile();

    expect(reconciled()).toEqual([ABANDONED]);
  });

  it("spares a shim younger than the grace, whoever created it", async () => {
    // Test Connection provisions a shim to verify the permission-sync path,
    // for a connector that may not sync permissions at all — so a young
    // unclaimed shim is presumed to have an owner the sweep cannot see.
    listShims.mockResolvedValue([{ scope: ABANDONED, ageMs: 5_000 }]);

    await handleP4ShimReconcile();

    expect(reconciled()).toEqual([]);
  });

  it("leaves a claimed shim claimed however old it is", async () => {
    findEnabled.mockResolvedValue([{ id: WANTED }]);
    listShims.mockResolvedValue([{ scope: WANTED, ageMs: 30 * 24 * HOUR_MS }]);

    await handleP4ShimReconcile();

    // Once, as a connector that wants a shim — never a second time as an
    // abandoned one.
    expect(reconciled()).toEqual([WANTED]);
  });

  it("reads the connector rows before the cluster", async () => {
    // Read the other way round, a connector created between the two reads
    // looks like a shim nothing claims, and is deleted moments after it was
    // made.
    const order: string[] = [];
    findEnabled.mockImplementation(async () => {
      order.push("rows");
      return [];
    });
    listShims.mockImplementation(async () => {
      order.push("cluster");
      return [];
    });

    await handleP4ShimReconcile();

    expect(order).toEqual(["rows", "cluster"]);
  });

  it("does nothing at all without Kubernetes", async () => {
    enabled = false;

    await handleP4ShimReconcile();

    expect(findEnabled).not.toHaveBeenCalled();
    expect(listShims).not.toHaveBeenCalled();
  });
});
