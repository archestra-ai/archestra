// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { PERMISSION_SYNC_FOLLOW_DOCUMENTS_SCHEDULE } from "@archestra/shared";
import { sql } from "drizzle-orm";
import config from "@/config";
import db from "@/database";
import { enterpriseTier } from "@/enterprise-tier";
import {
  ConnectorRunModel,
  KnowledgeBaseConnectorModel,
  TaskModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { handleCheckDuePermissionSyncs } from "./check-due-permission-syncs-handler";

const PAST = () => new Date(Date.now() - 120_000);

// An interval so large a connector with any recent lastPermissionSyncAt is
// never due under it.
const HUGE_INTERVAL_SECONDS = 365 * 24 * 60 * 60;
// An interval PAST() has always outlived, so the connector is always due.
const TINY_INTERVAL_SECONDS = 60;

/** Count permission_sync tasks (any status) enqueued for a connector. */
async function countPermissionSyncTasks(connectorId: string): Promise<number> {
  const { rows } = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM tasks
    WHERE task_type = 'permission_sync'
      AND payload->>'connectorId' = ${connectorId}
  `);
  return rows[0]?.count ?? 0;
}

describe("handleCheckDuePermissionSyncs", () => {
  beforeEach(() => {
    config.kb.autoSyncPermissionsEnabled = true;
  });

  test("no-ops when the auto-sync permissions beta flag is off, even with a due connector", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    config.kb.autoSyncPermissionsEnabled = false;
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
      enabled: true,
    });
    await KnowledgeBaseConnectorModel.update(connector.id, {
      permissionSyncIntervalSeconds: TINY_INTERVAL_SECONDS,
      lastPermissionSyncAt: PAST(),
    });

    await handleCheckDuePermissionSyncs();

    expect(await countPermissionSyncTasks(connector.id)).toBe(0);
  });

  test("no-ops when the enterprise knowledge-base tier is inactive — a lapsed license makes auto-sync connectors dormant", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    // Over the small-team threshold with no license env flag → tier inactive.
    enterpriseTier.setUserCountForTesting(1000);
    try {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        visibility: "auto-sync-permissions",
        connectorType: "github",
        enabled: true,
      });
      await KnowledgeBaseConnectorModel.update(connector.id, {
        permissionSyncIntervalSeconds: TINY_INTERVAL_SECONDS,
        lastPermissionSyncAt: PAST(),
      });

      await handleCheckDuePermissionSyncs();

      expect(await countPermissionSyncTasks(connector.id)).toBe(0);
    } finally {
      enterpriseTier.setUserCountForTesting(0);
    }
  });

  test("a never-synced auto-sync connector is due immediately (safety net)", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
      enabled: true,
    });
    // lastPermissionSyncAt left null → due now regardless of interval.

    await handleCheckDuePermissionSyncs();

    const active = await TaskModel.findActivePayloadValues(
      "permission_sync",
      "connectorId",
    );
    expect(active.has(connector.id)).toBe(true);
  });

  describe("independence from the content schedule", () => {
    test("enqueues permission_sync even when the content schedule is NOT due", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        visibility: "auto-sync-permissions",
        connectorType: "github",
        enabled: true,
        schedule: "0 0 1 1 *", // content cadence: not due (once a year)
      });
      await KnowledgeBaseConnectorModel.update(connector.id, {
        // Content sync just ran; permission sync is stale.
        lastSyncAt: new Date(),
        permissionSyncIntervalSeconds: TINY_INTERVAL_SECONDS,
        lastPermissionSyncAt: PAST(),
      });

      await handleCheckDuePermissionSyncs();

      const active = await TaskModel.findActivePayloadValues(
        "permission_sync",
        "connectorId",
      );
      expect(active.has(connector.id)).toBe(true);
    });

    test("does NOT enqueue permission_sync when its interval has not elapsed, even if the content schedule IS due", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        visibility: "auto-sync-permissions",
        connectorType: "github",
        enabled: true,
        schedule: "* * * * *", // content cadence: always due
      });
      await KnowledgeBaseConnectorModel.update(connector.id, {
        permissionSyncIntervalSeconds: HUGE_INTERVAL_SECONDS,
        lastPermissionSyncAt: new Date(),
      });

      await handleCheckDuePermissionSyncs();

      expect(await countPermissionSyncTasks(connector.id)).toBe(0);
    });
  });

  test("follow mode: never enqueues on the interval tick, however overdue", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
      enabled: true,
    });
    // Interval 0 = follow the documents sync schedule: passes come from the
    // documents-sync trigger and manual runs only.
    await KnowledgeBaseConnectorModel.update(connector.id, {
      permissionSyncIntervalSeconds: PERMISSION_SYNC_FOLLOW_DOCUMENTS_SCHEDULE,
      lastPermissionSyncAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    });

    await handleCheckDuePermissionSyncs();

    expect(await countPermissionSyncTasks(connector.id)).toBe(0);
  });

  test("does NOT enqueue for a non-auto-sync connector (org-wide/team-scoped)", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "org-wide", // not auto-sync-permissions
      connectorType: "github",
      enabled: true,
    });
    // Overdue by every measure, so only visibility gates it.
    await KnowledgeBaseConnectorModel.update(connector.id, {
      permissionSyncIntervalSeconds: TINY_INTERVAL_SECONDS,
      lastPermissionSyncAt: PAST(),
    });

    await handleCheckDuePermissionSyncs();

    expect(await countPermissionSyncTasks(connector.id)).toBe(0);
  });

  test("does not double-run right after a manual pass: due one interval AFTER the last run", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
      enabled: true,
    });
    // A manual pass 16 minutes ago under the default 30-minute interval:
    // the next scheduled pass is due 30 minutes after it, so not yet.
    await KnowledgeBaseConnectorModel.update(connector.id, {
      permissionSyncIntervalSeconds: 30 * 60,
      lastPermissionSyncAt: new Date(Date.now() - 16 * 60 * 1000),
    });

    await handleCheckDuePermissionSyncs();

    expect(await countPermissionSyncTasks(connector.id)).toBe(0);
  });

  test("enqueues once a full interval has elapsed since the last pass", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
      enabled: true,
    });
    await KnowledgeBaseConnectorModel.update(connector.id, {
      permissionSyncIntervalSeconds: 30 * 60,
      lastPermissionSyncAt: new Date(Date.now() - 31 * 60 * 1000),
    });

    await handleCheckDuePermissionSyncs();

    expect(await countPermissionSyncTasks(connector.id)).toBe(1);
  });

  test("de-duplicates: does not enqueue a second permission_sync when one is already pending", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
      enabled: true,
    });
    await KnowledgeBaseConnectorModel.update(connector.id, {
      permissionSyncIntervalSeconds: TINY_INTERVAL_SECONDS,
      lastPermissionSyncAt: PAST(),
    });
    // A permission_sync is already in flight for this connector.
    await TaskModel.create({
      taskType: "permission_sync",
      payload: { connectorId: connector.id },
      status: "pending",
    });

    await handleCheckDuePermissionSyncs();

    // Still exactly one — the handler de-duped against the active task.
    expect(await countPermissionSyncTasks(connector.id)).toBe(1);
  });

  describe("lease-based reaping", () => {
    const EXPIRED_LEASE = () => new Date(Date.now() - 60_000);

    test("reaps an expired-lease permission run and enqueues a resume within budget", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        visibility: "auto-sync-permissions",
        connectorType: "github",
        enabled: true,
      });
      // Recent last pass + huge interval: the schedule branch stays quiet,
      // so any enqueue can only come from the reaper.
      await KnowledgeBaseConnectorModel.update(connector.id, {
        permissionSyncIntervalSeconds: HUGE_INTERVAL_SECONDS,
        lastPermissionSyncAt: PAST(),
      });
      const run = await ConnectorRunModel.create({
        connectorId: connector.id,
        runType: "permission",
        status: "running",
        startedAt: PAST(),
        leaseExpiresAt: EXPIRED_LEASE(),
      });

      await handleCheckDuePermissionSyncs();

      const reaped = await ConnectorRunModel.findById(run.id);
      expect(reaped?.status).toBe("partial");
      const updated = await KnowledgeBaseConnectorModel.findById(connector.id);
      expect(updated?.lastPermissionSyncStatus).toBe("partial");
      expect(await countPermissionSyncTasks(connector.id)).toBe(1);
    });

    test("does not auto-resume a repeatedly interrupted permission run over its budget", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        visibility: "auto-sync-permissions",
        connectorType: "github",
        enabled: true,
      });
      await KnowledgeBaseConnectorModel.update(connector.id, {
        permissionSyncIntervalSeconds: HUGE_INTERVAL_SECONDS,
        lastPermissionSyncAt: PAST(),
      });
      // Burn the whole resume window budget with recent permission runs (a
      // crash loop). Far above any threshold maxRunsPerResumeWindow derives.
      for (let i = 0; i < 60; i++) {
        await makeConnectorRun(connector.id, {
          startedAt: new Date(),
          runType: "permission",
        });
      }
      const run = await ConnectorRunModel.create({
        connectorId: connector.id,
        runType: "permission",
        status: "running",
        startedAt: PAST(),
        leaseExpiresAt: EXPIRED_LEASE(),
      });

      await handleCheckDuePermissionSyncs();

      // Reaped (checkpoint preserved for the next scheduled pass)…
      const reaped = await ConnectorRunModel.findById(run.id);
      expect(reaped?.status).toBe("partial");
      // …but NOT auto-resumed: the runaway breaker held the enqueue back.
      expect(await countPermissionSyncTasks(connector.id)).toBe(0);
    });
  });

  describe("orphaned processing tasks", () => {
    // A hard worker shutdown leaves the in-flight task stuck in 'processing'
    // with no drain; started_at anchors to the DB clock like dequeue does.
    async function wedgeIntoProcessing(taskId: string, ageSeconds: number) {
      await db.execute(sql`
        UPDATE tasks SET status = 'processing', attempt = 1,
          started_at = NOW() - make_interval(secs => ${ageSeconds})
        WHERE id = ${taskId}
      `);
    }

    async function taskStatus(taskId: string): Promise<string | undefined> {
      const { rows } = await db.execute<{ status: string }>(
        sql`SELECT status FROM tasks WHERE id = ${taskId}`,
      );
      return rows[0]?.status;
    }

    /** Auto-sync connector whose schedule branch stays quiet. */
    async function makeQuietConnector(fixtures: {
      makeOrganization: () => Promise<{ id: string }>;
      makeKnowledgeBase: (orgId: string) => Promise<{ id: string }>;
      makeKnowledgeBaseConnector: (
        kbId: string,
        orgId: string,
        overrides: Record<string, unknown>,
      ) => Promise<{ id: string }>;
    }) {
      const org = await fixtures.makeOrganization();
      const kb = await fixtures.makeKnowledgeBase(org.id);
      const connector = await fixtures.makeKnowledgeBaseConnector(
        kb.id,
        org.id,
        {
          visibility: "auto-sync-permissions",
          connectorType: "github",
          enabled: true,
        },
      );
      await KnowledgeBaseConnectorModel.update(connector.id, {
        permissionSyncIntervalSeconds: HUGE_INTERVAL_SECONDS,
        lastPermissionSyncAt: PAST(),
      });
      return connector;
    }

    test("requeues a processing task with no running run past the grace window", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const connector = await makeQuietConnector({
        makeOrganization,
        makeKnowledgeBase,
        makeKnowledgeBaseConnector,
      });
      const task = await TaskModel.create({
        taskType: "permission_sync",
        payload: { connectorId: connector.id },
      });
      await wedgeIntoProcessing(task.id, 5 * 60);

      await handleCheckDuePermissionSyncs();

      expect(await taskStatus(task.id)).toBe("pending");
      // Requeued, not duplicated: the revived task counts as active for the
      // due loop.
      expect(await countPermissionSyncTasks(connector.id)).toBe(1);
    });

    test("leaves a processing task alone while its pass holds a running run", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const connector = await makeQuietConnector({
        makeOrganization,
        makeKnowledgeBase,
        makeKnowledgeBaseConnector,
      });
      const task = await TaskModel.create({
        taskType: "permission_sync",
        payload: { connectorId: connector.id },
      });
      await wedgeIntoProcessing(task.id, 5 * 60);
      // The pass is genuinely alive: claimed run with an unexpired lease.
      await ConnectorRunModel.create({
        connectorId: connector.id,
        runType: "permission",
        status: "running",
        startedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });

      await handleCheckDuePermissionSyncs();

      expect(await taskStatus(task.id)).toBe("processing");
    });

    test("leaves a recently started processing task alone (dequeue → claim gap)", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const connector = await makeQuietConnector({
        makeOrganization,
        makeKnowledgeBase,
        makeKnowledgeBaseConnector,
      });
      const task = await TaskModel.create({
        taskType: "permission_sync",
        payload: { connectorId: connector.id },
      });
      await wedgeIntoProcessing(task.id, 10);

      await handleCheckDuePermissionSyncs();

      expect(await taskStatus(task.id)).toBe("processing");
    });

    test("a crash loop's pile of orphans revives only the newest; older ones are dead-lettered as superseded", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const connector = await makeQuietConnector({
        makeOrganization,
        makeKnowledgeBase,
        makeKnowledgeBaseConnector,
      });
      const older = await TaskModel.create({
        taskType: "permission_sync",
        payload: { connectorId: connector.id },
      });
      const newer = await TaskModel.create({
        taskType: "permission_sync",
        payload: { connectorId: connector.id },
      });
      await wedgeIntoProcessing(older.id, 12 * 60);
      await wedgeIntoProcessing(newer.id, 5 * 60);

      await handleCheckDuePermissionSyncs();

      // A pass is connector-level work — reviving both would run a redundant
      // full pass back-to-back.
      expect(await taskStatus(newer.id)).toBe("pending");
      expect(await taskStatus(older.id)).toBe("dead");
    });

    test("a crash mid-pass recovers to exactly one requeued task in one tick", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const connector = await makeQuietConnector({
        makeOrganization,
        makeKnowledgeBase,
        makeKnowledgeBaseConnector,
      });
      // The full crash aftermath: an expired-lease run AND its orphaned task.
      const run = await ConnectorRunModel.create({
        connectorId: connector.id,
        runType: "permission",
        status: "running",
        startedAt: PAST(),
        leaseExpiresAt: new Date(Date.now() - 60_000),
      });
      const task = await TaskModel.create({
        taskType: "permission_sync",
        payload: { connectorId: connector.id },
      });
      await wedgeIntoProcessing(task.id, 5 * 60);

      await handleCheckDuePermissionSyncs();

      // Run reaped, orphan revived, and the reaper's resume enqueue de-duped
      // against it — one task total, ready to resume from the checkpoint.
      const reaped = await ConnectorRunModel.findById(run.id);
      expect(reaped?.status).toBe("partial");
      expect(await taskStatus(task.id)).toBe("pending");
      expect(await countPermissionSyncTasks(connector.id)).toBe(1);
    });
  });
});
