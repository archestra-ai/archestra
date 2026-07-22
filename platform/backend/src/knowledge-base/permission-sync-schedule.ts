// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

/**
 * When the next scheduled permission pass is due for a connector.
 *
 * The per-connector interval is a CADENCE anchored at the last pass — manual,
 * content-ingest-triggered, or scheduled — so any pass pushes the next
 * scheduled one a full interval out (a manual run at :48 under a 30-minute
 * interval is next due at :18). A connector that has never had a pass is due
 * immediately: content ingest and manual triggers normally run the first pass,
 * so this is the safety net that keeps a connector from being stranded
 * fail-closed if those were missed (e.g. visibility switched to auto-sync
 * long after its content was ingested).
 */
export function nextPermissionSyncDueAt(params: {
  intervalSeconds: number;
  lastPermissionSyncAt: Date | null;
}): Date {
  const last = params.lastPermissionSyncAt;
  if (!last) {
    return new Date();
  }
  return new Date(last.getTime() + params.intervalSeconds * 1000);
}
