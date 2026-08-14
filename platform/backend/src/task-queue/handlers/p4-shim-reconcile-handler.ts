// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { p4ShimRuntimeManager } from "@/k8s/p4-shim-runtime/manager";
import { reconcileP4ShimForConnector } from "@/knowledge-base/connectors/perforce/p4-shim-service";
import logger from "@/logging";
import { KnowledgeBaseConnectorModel } from "@/models";

/**
 * Converge the Perforce shims in the cluster onto the shims the connector rows
 * call for: create the missing, remove the abandoned.
 *
 * The shim lifecycle is event-driven — every surface that can change whether a
 * connector wants a pod reconciles it inside the request. That is what makes
 * the pod appear and disappear promptly, and on its own it is not enough:
 * those calls reach the cluster over a network, from a process that can be
 * killed between the database write and the Kubernetes one. A lost teardown
 * leaves a pod holding a tenant's bearer token and an open egress rule to
 * their Perforce server, with nothing left to notice — the connector it
 * belonged to no longer exists to be edited again.
 *
 * So the events are the fast path and this is the guarantee. It is a
 * convergence loop and nothing else: it reads no clock, tracks no idleness,
 * and never scales a Deployment. A connector that wants a shim has one running
 * whether or not it has ever synced.
 */
export async function handleP4ShimReconcile(): Promise<void> {
  if (!p4ShimRuntimeManager.isEnabled()) return;

  // Both sides of the comparison, before either is acted on, and the
  // connectors first. Read the other way round, a connector created between
  // the two reads looks like a shim nothing claims — and would be deleted
  // moments after it was made.
  const connectors =
    await KnowledgeBaseConnectorModel.findEnabledAutoSyncPermissions([
      "perforce",
    ]);
  const shims = await p4ShimRuntimeManager.listShims();

  // Reconciled by connector id, not by "is there a Deployment": a shim can
  // also be present but wrong — a retired token, settings an edit replaced, a
  // Deployment somebody scaled by hand — and applying the desired state
  // repairs all of those. Idempotent, so a connector already in the state it
  // wants costs a couple of API calls and changes nothing.
  const wanted = new Set(connectors.map((connector) => connector.id));
  const abandoned = shims
    .filter((shim) => !wanted.has(shim.scope))
    // Deleting is the one thing here that cannot be undone, and not every
    // caller that creates a shim is a connector row: Test Connection
    // provisions one to verify the permission-sync path, for a connector that
    // may not sync permissions at all. A shim that young is presumed to have
    // an owner the sweep cannot see; a genuinely abandoned one is still here
    // on a later tick, and nothing is leaked by waiting.
    .filter((shim) => shim.ageMs >= UNCLAIMED_SHIM_GRACE_MS)
    .map((shim) => shim.scope);

  for (const connectorId of [...wanted, ...abandoned]) {
    await reconcileP4ShimForConnector(connectorId);
  }
  if (abandoned.length > 0) {
    logger.info(
      { count: abandoned.length },
      "[P4Shim] removed shims no connector claims",
    );
  }
}

// ===== Internal =====

/**
 * How long a shim no connector claims is left alone. Comfortably longer than
 * the slowest Test Connection — which waits for a pod to schedule, pushes the
 * `p4` binary, then runs a login and a protections read — and far shorter than
 * anything genuinely abandoned will sit around for.
 */
const UNCLAIMED_SHIM_GRACE_MS = 10 * 60_000;
