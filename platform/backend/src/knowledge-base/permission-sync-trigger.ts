// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import logger from "@/logging";
import { TaskModel } from "@/models";
import { taskQueueService } from "@/task-queue";
import type { KnowledgeBaseConnector } from "@/types";
import { getConnector } from "./connectors/registry";
import { isAutoSyncPermissionsActive } from "./source-access-control";

/**
 * Documents-sync trigger for the permission-sync pass: EVERY completed
 * documents sync of an `auto-sync-permissions` connector enqueues a
 * `permission_sync` for that connector — ingests or not. Newly-ingested
 * content is tagged promptly instead of waiting for the next scheduled tick
 * (new auto-sync docs are created fail-closed, so they stay invisible until a
 * pass runs), and an ingest-free sync still sweeps up documents stranded by an
 * earlier interrupted run whose own trigger was lost. For a connector in
 * follow-documents mode this trigger is the ONLY automatic pass. The enqueued
 * pass is a cheap delta: a clean probe with nothing awaiting adoption is a
 * few requests and zero writes.
 *
 * Runtime-isolation invariants still hold: the enqueued task runs in the
 * `permission` lane under its own `permission` runType lease, so it can neither
 * block nor be blocked by documents sync (Guarantees 2–3).
 *
 * The enqueue is de-duplicated — a single pass fully reconciles every pending
 * new document, so if a `permission_sync` is already pending/processing for the
 * connector we skip (one pass covers all of them). A non-auto-sync connector
 * never enqueues.
 */
export async function enqueuePermissionSyncAfterContentSync(params: {
  connector: Pick<
    KnowledgeBaseConnector,
    "id" | "visibility" | "connectorType"
  >;
  documentsIngested: number;
}): Promise<void> {
  const { connector, documentsIngested } = params;

  // Feature gate (beta flag + enterprise license): with the feature off no
  // pass is ever enqueued, so existing auto-sync connectors go dormant
  // instead of syncing behind hidden or unlicensed UI.
  if (!isAutoSyncPermissionsActive()) return;
  if (connector.visibility !== "auto-sync-permissions") return;
  // Defensive: a connector type without permission-sync support has no pass to
  // run (the route also forbids auto-sync for such types).
  if (!getConnector(connector.connectorType).supportsPermissionSync) return;

  const alreadyQueued = await TaskModel.hasPendingOrProcessing(
    "permission_sync",
    connector.id,
  );
  if (alreadyQueued) return;

  await taskQueueService.enqueue({
    taskType: "permission_sync",
    payload: { connectorId: connector.id },
  });
  logger.info(
    { connectorId: connector.id, documentsIngested },
    "Enqueued permission sync after completed documents sync (auto-sync-permissions connector)",
  );
}
