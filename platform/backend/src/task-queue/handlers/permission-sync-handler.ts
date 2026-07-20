// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { createCapturingLogger } from "@/entrypoints/_shared/log-capture";
import { permissionSyncService } from "@/knowledge-base";
import { isAutoSyncPermissionsActive } from "@/knowledge-base/source-access-control";
import logger from "@/logging";
import { KnowledgeBaseConnectorModel } from "@/models";
import { taskQueueService } from "@/task-queue";
import { withinResumeBudget } from "./connector-resume-budget";

export async function handlePermissionSync(
  payload: Record<string, unknown>,
): Promise<void> {
  // Checked, not cast: the payload is `jsonb` off the task row, so `as string`
  // asserts a shape nothing enforces. A non-string that satisfied the old
  // truthiness check (a number, an object) would sail into the pass and be
  // compared against uuid columns, which fails somewhere far from here.
  const { connectorId } = payload;
  if (typeof connectorId !== "string" || connectorId === "") {
    throw new Error(
      `permission_sync payload has no usable connectorId (got ${typeof connectorId})`,
    );
  }

  // Feature gate (beta flag + enterprise license): a task enqueued before
  // either flipped off completes as a no-op instead of running a pass for a
  // feature that is hidden or no longer licensed.
  if (!isAutoSyncPermissionsActive()) {
    logger.info(
      { connectorId },
      "Skipping permission_sync task: auto-sync permissions is disabled (beta flag or enterprise license)",
    );
    return;
  }

  const { logger: capturingLogger, getLogOutput } = createCapturingLogger();

  const result = await permissionSyncService.executePass(connectorId, {
    logger: capturingLogger,
    getLogOutput,
    ...(payload.mode === "full" ? { mode: "full" as const } : {}),
  });

  // A mapping-change follow-up (`refreshAudiences`) that lost the claim to an
  // already-running pass must NOT be dropped — that pass preloaded the OLD
  // mappings and may already be past its audience phase. Every delta pass
  // verifies audiences, so the retried pass needs no special flag; throwing
  // hands the retry to the task queue's backoff.
  if (result.status === "skipped" && payload.refreshAudiences === true) {
    throw new Error(
      "Audience refresh deferred: another permission pass is running; retrying via task backoff",
    );
  }

  // A partial run was interrupted mid-generation; re-enqueue so a fresh run
  // resumes the same generation from its checkpoint cursor. The claim()
  // single-flight makes a redundant enqueue harmless. Budget-gated like the
  // content family: a pass that persistently ends partial (e.g. dead
  // credentials failing fast) would otherwise re-enqueue itself in a hot loop
  // with no backoff until the connector is deleted.
  if (result.status === "partial") {
    // Read only to name the connector in the log lines below — the pass reads
    // its own connector and decides everything from that.
    const connector = await KnowledgeBaseConnectorModel.findById(connectorId);

    if (await withinResumeBudget({ connectorId, runType: "permission" })) {
      try {
        await taskQueueService.enqueue({
          taskType: "permission_sync",
          payload: { connectorId },
        });
      } catch (error) {
        // The pass itself finished (partial) — don't fail the task over a
        // lost continuation; the due-loop reaper resumes stuck-partial runs.
        logger.warn(
          {
            connectorId,
            connectorName: connector?.name,
            connectorType: connector?.connectorType,
            runId: result.runId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to enqueue permission-sync continuation; leaving the run for the reaper",
        );
        return;
      }
      logger.info(
        {
          connectorId,
          connectorName: connector?.name,
          connectorType: connector?.connectorType,
          runId: result.runId,
        },
        "Enqueued permission-sync continuation",
      );
    } else {
      logger.warn(
        {
          connectorId,
          connectorName: connector?.name,
          connectorType: connector?.connectorType,
          runId: result.runId,
        },
        "Connector exceeded its permission-run budget for the window; not continuing until next schedule",
      );
    }
  }
}
