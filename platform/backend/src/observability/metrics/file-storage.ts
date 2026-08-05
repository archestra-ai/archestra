/**
 * Prometheus metrics for stored file bytes that a delete could not remove.
 *
 * A permanent delete removes the `files` row and its external object in one
 * pass. When the object store refuses, the row goes anyway — it is destroyed by
 * the same transaction's cascade — so the bytes survive with nothing pointing
 * at them and no retry will ever revisit them. That loss is otherwise only a
 * log line; this counter makes it alertable.
 *
 * Any orphan at all is worth paging on, since each one is permanent:
 * sum by (provider, scope) (increase(file_storage_orphaned_objects_total[15m]))
 */

import client from "prom-client";
import logger from "@/logging";

let orphanedObjectsTotal: client.Counter<string>;

let initialized = false;

export function initializeFileStorageMetrics(): void {
  if (initialized) return;
  initialized = true;

  orphanedObjectsTotal = new client.Counter({
    name: "file_storage_orphaned_objects_total",
    help: "Total stored file objects left behind because their delete failed, by storage provider and owner scope",
    labelNames: ["provider", "scope"],
  });

  logger.info("File storage metrics initialized");
}

export function reportOrphanedObject(params: {
  provider: string;
  /** Owner scope whose purge dropped the object. */
  scope: "project";
}): void {
  if (!orphanedObjectsTotal) return;
  orphanedObjectsTotal.inc({
    provider: params.provider,
    scope: params.scope,
  });
}
