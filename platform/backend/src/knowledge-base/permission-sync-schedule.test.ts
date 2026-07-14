// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { describe, expect, test } from "@/test";
import { nextPermissionSyncDueAt } from "./permission-sync-schedule";

describe("nextPermissionSyncDueAt", () => {
  test("anchors the interval at the last pass, not a wall-clock slot", () => {
    // A manual pass at :48 under a 30-minute interval is next due at :18 —
    // NOT at the :00 boundary 12 minutes later.
    const dueAt = nextPermissionSyncDueAt({
      intervalSeconds: 30 * 60,
      lastPermissionSyncAt: new Date("2026-07-08T15:48:00.000Z"),
    });
    expect(dueAt.toISOString()).toBe("2026-07-08T16:18:00.000Z");
  });

  test("an hourly interval defers a full hour from the last pass", () => {
    const dueAt = nextPermissionSyncDueAt({
      intervalSeconds: 60 * 60,
      lastPermissionSyncAt: new Date("2026-07-08T15:48:00.000Z"),
    });
    expect(dueAt.toISOString()).toBe("2026-07-08T16:48:00.000Z");
  });

  test("a never-synced connector is due immediately", () => {
    const dueAt = nextPermissionSyncDueAt({
      intervalSeconds: 30 * 60,
      lastPermissionSyncAt: null,
    });
    expect(dueAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
