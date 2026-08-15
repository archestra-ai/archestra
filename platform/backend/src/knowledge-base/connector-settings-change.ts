// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import logger from "@/logging";
import {
  ConnectorRunModel,
  KnowledgeBaseConnectorModel,
  TaskModel,
} from "@/models";
import { taskQueueService } from "@/task-queue";
import type { KnowledgeSourceVisibility } from "@/types";

/**
 * Shared update side-effects for a connector that syncs permissions, so the
 * REST update route and the Archestra MCP update tool behave identically —
 * the same reason `knowledge-source-deletion.ts` exists for the delete
 * surfaces.
 */

/**
 * Stop the permission pass that is running against the settings this update
 * just replaced, and queue a fresh one.
 *
 * A pass reads the connector row and its credentials once, at the start, and
 * replays them across every hook. An edit landing mid-pass therefore leaves a
 * run whose whole remaining work — upstream reads, ACL writes, and for
 * Perforce the shim it reconciles — is computed from settings the admin has
 * already retired. For a connector that provisions its own runtime, that pass
 * would actively undo the rotation: roll the pod back to the old
 * configuration, restore the retired token, and re-open egress to the old
 * server.
 *
 * Superseding bumps the run's fencing epoch, so its remaining writes no-op,
 * and frees the family's single-flight slot immediately. The follow-up pass is
 * what actually reconciles the new settings — without it the corpus would sit
 * half-reconciled (some documents fail-closed) until the next scheduled tick.
 */
export async function supersedePermissionSyncAfterSettingsChange(params: {
  connectorId: string;
  /** Visibility AFTER the update: a connector switched away syncs no more. */
  visibility: KnowledgeSourceVisibility;
  /** Enabled state AFTER the update; a disabled connector syncs no more. */
  enabled: boolean;
}): Promise<void> {
  const stopped = await ConnectorRunModel.supersedeRunningForConnector({
    connectorId: params.connectorId,
    runType: "permission",
    reason: "Permission sync stopped: the connector's settings changed.",
  });
  if (stopped > 0) {
    logger.info(
      { connectorId: params.connectorId, stopped },
      "Stopped an in-flight permission sync computed against the connector's previous settings",
    );
    // The stopped pass deliberately writes nothing on its way out — it has
    // lost its run and an older view of upstream than whoever comes next. But
    // it had already stamped the connector `running`, and nothing else would
    // clear that: the replacement below is often SKIPPED, because it tries to
    // claim while this supersede is still settling. Left alone, the Knowledge
    // tab shows a run that no longer exists until the next scheduled pass —
    // half an hour by default. Written before the enqueue so a replacement
    // that does start immediately overwrites this rather than racing it.
    await KnowledgeBaseConnectorModel.update(params.connectorId, {
      lastPermissionSyncStatus: "superseded",
    });
  }

  // A connector switched away from permission sync, or switched off, wants no
  // replacement pass — only the stop above. Its shim goes with it, so a pass
  // queued here would find no pod and fail for a connector nobody is waiting
  // on.
  if (params.visibility !== "auto-sync-permissions" || !params.enabled) return;

  // De-duplicated like every other permission-sync trigger: a burst of edits
  // queues one pass, and it reads the settings current when it runs.
  const alreadyQueued = await TaskModel.hasPendingOrProcessing(
    "permission_sync",
    params.connectorId,
  );
  if (alreadyQueued) return;

  await taskQueueService.enqueue({
    taskType: "permission_sync",
    payload: { connectorId: params.connectorId },
  });
  logger.info(
    { connectorId: params.connectorId },
    "Enqueued a permission sync for the connector's updated settings",
  );
}
