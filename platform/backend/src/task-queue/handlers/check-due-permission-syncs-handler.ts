// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { PERMISSION_SYNC_FOLLOW_DOCUMENTS_SCHEDULE } from "@archestra/shared";
import { getPermissionSyncConnectorTypes } from "@/knowledge-base/connectors/registry";
import { nextPermissionSyncDueAt } from "@/knowledge-base/permission-sync-schedule";
import { isAutoSyncPermissionsActive } from "@/knowledge-base/source-access-control";
import logger from "@/logging";
import {
  ConnectorRunModel,
  KnowledgeBaseConnectorModel,
  TaskModel,
} from "@/models";
import { taskQueueService } from "@/task-queue";
import { withinResumeBudget } from "./connector-resume-budget";

/**
 * Runtime-isolated sibling of `check_due_connectors` for the permission-sync
 * family. Enqueues due `permission_sync` tasks per each connector's
 * permission-sync interval — independent of the connector's content
 * `schedule` — and reaps expired permission runs. Kept separate so
 * content-run recovery is never overloaded with permission work.
 */
export async function handleCheckDuePermissionSyncs(): Promise<void> {
  // Feature gate (beta flag + enterprise license): nothing is scheduled,
  // reaped, or requeued while the feature is off — the whole permission
  // family is dormant.
  if (!isAutoSyncPermissionsActive()) return;
  // Recovery order matters: a hard shutdown mid-pass leaves BOTH an
  // expired-lease run (still 'running') and its task stuck in 'processing'.
  // Reap the run first so the orphan requeue below sees no live run and
  // revives the task in the same tick; the requeue runs before the due loop
  // so a revived task counts as active instead of double-enqueuing.
  await reapExpiredPermissionRuns();

  const orphaned = await TaskModel.requeueOrphanedPermissionSyncTasks(
    ORPHANED_TASK_GRACE_SECONDS,
  );
  if (orphaned.length > 0) {
    logger.warn(
      { taskIds: orphaned },
      "Requeued permission-sync tasks orphaned by a worker restart",
    );
  }

  // Asked of the database rather than filtered in memory: the due-loop only
  // ever schedules enabled auto-sync connectors of a permission-syncing type,
  // so that is what it loads.
  const autoSyncConnectors =
    await KnowledgeBaseConnectorModel.findEnabledAutoSyncPermissions(
      getPermissionSyncConnectorTypes(),
    );
  if (autoSyncConnectors.length > 0) {
    const activeConnectorIds = await TaskModel.findActivePayloadValues(
      "permission_sync",
      "connectorId",
    );

    for (const connector of autoSyncConnectors) {
      // Follow mode: no interval-scheduled passes — the documents-sync
      // trigger (and manual runs) are this connector's only passes.
      if (
        connector.permissionSyncIntervalSeconds ===
        PERMISSION_SYNC_FOLLOW_DOCUMENTS_SCHEDULE
      ) {
        continue;
      }
      // Cadence semantics: due one interval after the last pass (manual,
      // content-ingest-triggered, or scheduled) — a manual pass pushes the
      // next scheduled one out instead of double-running minutes later.
      const dueAt = nextPermissionSyncDueAt({
        intervalSeconds: connector.permissionSyncIntervalSeconds,
        lastPermissionSyncAt: connector.lastPermissionSyncAt,
      });
      if (dueAt <= new Date() && !activeConnectorIds.has(connector.id)) {
        try {
          await taskQueueService.enqueue({
            taskType: "permission_sync",
            payload: { connectorId: connector.id },
          });
          logger.info(
            {
              connectorId: connector.id,
              connectorType: connector.connectorType,
            },
            "Enqueued scheduled permission sync",
          );
        } catch (error) {
          // One connector's enqueue failure must not starve the rest of the
          // loop (or the reaper below).
          logger.warn(
            {
              connectorId: connector.id,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to enqueue scheduled permission sync",
          );
        }
      }
    }
  }
}

// ===== Internal helpers =====

// Well past the dequeue → run-claim gap (seconds) so a task whose pass hasn't
// created its run row yet is never mistaken for an orphan.
const ORPHANED_TASK_GRACE_SECONDS = 120;

async function reapExpiredPermissionRuns(): Promise<void> {
  const expired = await ConnectorRunModel.reapExpiredRuns("permission");
  for (const run of expired) {
    logger.warn(
      { runId: run.id, connectorId: run.connectorId },
      "Reclaimed permission run with an expired lease; resuming from checkpoint",
    );
    await KnowledgeBaseConnectorModel.update(run.connectorId, {
      lastPermissionSyncStatus: "partial",
    });

    if (
      !(await withinResumeBudget({
        connectorId: run.connectorId,
        runType: "permission",
      }))
    ) {
      // Runaway: stop auto-resuming. The checkpoint is preserved, so the next
      // scheduled pass resumes the same generation from its cursor.
      logger.error(
        { connectorId: run.connectorId },
        "Permission sync is repeatedly interrupted; not auto-resuming — needs investigation",
      );
      continue;
    }

    // The orphan requeue above may have already revived this connector's
    // interrupted task; a second enqueue would burn resume budget on a
    // redundant pass.
    const alreadyQueued = await TaskModel.hasPendingOrProcessing(
      "permission_sync",
      run.connectorId,
    );
    if (alreadyQueued) continue;

    await taskQueueService.enqueue({
      taskType: "permission_sync",
      payload: { connectorId: run.connectorId },
    });
  }
}
