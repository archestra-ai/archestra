import { vi } from "vitest";

const mockEnqueue = vi.hoisted(() => vi.fn().mockResolvedValue("task-id"));
vi.mock("@/task-queue", () => ({
  taskQueueService: { enqueue: mockEnqueue },
}));

import { sql } from "drizzle-orm";
import db from "@/database";
import {
  ConnectorRunModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
  TaskModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { handleCheckDueConnectors } from "./check-due-connectors-handler";

const PAST = () => new Date(Date.now() - 120_000);

describe("handleCheckDueConnectors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("does nothing when no connectors are enabled", async () => {
    await handleCheckDueConnectors();

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("skips connectors without a schedule", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    // Empty schedule means "no cron" — the column is NOT NULL, so "" is the
    // real-world representation of an unscheduled connector.
    await makeKnowledgeBaseConnector(kb.id, org.id, {
      schedule: "",
      enabled: true,
    });

    await handleCheckDueConnectors();

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("enqueues connector sync when cron is due", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      schedule: "* * * * *",
      enabled: true,
    });
    await KnowledgeBaseConnectorModel.update(connector.id, {
      lastSyncAt: PAST(),
    });

    await handleCheckDueConnectors();

    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "connector_sync",
      payload: { connectorId: connector.id },
    });
  });

  test("does not enqueue when a pending/processing task already exists", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      schedule: "* * * * *",
      enabled: true,
    });
    await KnowledgeBaseConnectorModel.update(connector.id, {
      lastSyncAt: PAST(),
    });
    await TaskModel.create({
      taskType: "connector_sync",
      payload: { connectorId: connector.id },
      status: "pending",
    });

    await handleCheckDueConnectors();

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("continues processing other connectors when one fails", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const bad = await makeKnowledgeBaseConnector(kb.id, org.id, {
      schedule: "INVALID_CRON",
      enabled: true,
    });
    await KnowledgeBaseConnectorModel.update(bad.id, { lastSyncAt: PAST() });
    const good = await makeKnowledgeBaseConnector(kb.id, org.id, {
      schedule: "* * * * *",
      enabled: true,
    });
    await KnowledgeBaseConnectorModel.update(good.id, { lastSyncAt: PAST() });

    await handleCheckDueConnectors();

    // The good connector is still enqueued despite the bad one throwing.
    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "connector_sync",
      payload: { connectorId: good.id },
    });
  });

  test("reconciles a connector stuck 'running' to its latest run's terminal status", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeConnectorRun,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      enabled: false,
    });
    await KnowledgeBaseConnectorModel.update(connector.id, {
      lastSyncStatus: "running",
    });
    // The latest run finalized but the connector was left showing 'running'
    // (its finalizing status write was lost). Reconcile derives it from the run.
    await makeConnectorRun(connector.id, { status: "success" });

    await handleCheckDueConnectors();

    const updated = await KnowledgeBaseConnectorModel.findById(connector.id);
    expect(updated?.lastSyncStatus).toBe("success");
  });

  test("does not reset running status when a pending task exists", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      enabled: false,
    });
    await KnowledgeBaseConnectorModel.update(connector.id, {
      lastSyncStatus: "running",
    });
    await TaskModel.create({
      taskType: "connector_sync",
      payload: { connectorId: connector.id },
      status: "pending",
    });

    await handleCheckDueConnectors();

    const updated = await KnowledgeBaseConnectorModel.findById(connector.id);
    expect(updated?.lastSyncStatus).toBe("running");
  });

  test("does not reset running status when an active run exists", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      enabled: false,
    });
    await KnowledgeBaseConnectorModel.update(connector.id, {
      lastSyncStatus: "running",
    });
    await ConnectorRunModel.create({
      connectorId: connector.id,
      status: "running",
      startedAt: new Date(),
    });

    await handleCheckDueConnectors();

    const updated = await KnowledgeBaseConnectorModel.findById(connector.id);
    expect(updated?.lastSyncStatus).toBe("running");
  });

  describe("lease-based reaping", () => {
    const EXPIRED_LEASE = () => new Date(Date.now() - 60_000);
    const LIVE_LEASE = () => new Date(Date.now() + 60_000);

    test("reaps an expired-lease run: partial, mirrors connector, resumes", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        // No schedule, so the only enqueue can come from the reaper.
        schedule: "",
        enabled: true,
      });
      // A run whose worker stopped heartbeating (crashed/hung). The connector
      // reflects this run (Fix P: lastSyncAt = run.startedAt).
      const startedAt = PAST();
      await KnowledgeBaseConnectorModel.update(connector.id, {
        lastSyncStatus: "running",
        lastSyncAt: startedAt,
      });
      const run = await ConnectorRunModel.create({
        connectorId: connector.id,
        status: "running",
        startedAt,
        leaseExpiresAt: EXPIRED_LEASE(),
        documentsIngested: 116,
      });

      await handleCheckDueConnectors();

      const reaped = await ConnectorRunModel.findById(run.id);
      expect(reaped?.status).toBe("partial");
      expect(reaped?.completedAt).not.toBeNull();

      const updatedConnector = await KnowledgeBaseConnectorModel.findById(
        connector.id,
      );
      expect(updatedConnector?.lastSyncStatus).toBe("partial");

      // Resumes from checkpoint promptly rather than waiting for the cron.
      expect(mockEnqueue).toHaveBeenCalledWith({
        taskType: "connector_sync",
        payload: { connectorId: connector.id },
      });
    });

    test("leaves a live-lease run untouched (healthy, incl. mid-drain)", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        schedule: "",
        enabled: true,
      });
      // Started long ago but still heartbeating: there is no time-based
      // hard-fail — a live run is bounded by the sync work budget (it
      // checkpoints and continues), never aborted here on elapsed time alone.
      const run = await ConnectorRunModel.create({
        connectorId: connector.id,
        status: "running",
        startedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
        leaseExpiresAt: LIVE_LEASE(),
      });

      await handleCheckDueConnectors();

      const untouched = await ConnectorRunModel.findById(run.id);
      expect(untouched?.status).toBe("running");
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    test("does NOT reap an expired-lease run that still has embedding work queued", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        schedule: "",
        enabled: true,
      });
      // Ingest finished (lease last renewed during ingest, now lapsed) but the
      // embedding drain is still in flight — a pending batch_embedding task is the
      // liveness signal (even if it is queued behind a backlog rather than running
      // right now), so this healthy run must not be reaped.
      const run = await ConnectorRunModel.create({
        connectorId: connector.id,
        status: "running",
        startedAt: PAST(),
        leaseExpiresAt: EXPIRED_LEASE(),
        totalBatches: 2,
        completedBatches: 1,
      });
      await TaskModel.create({
        taskType: "batch_embedding",
        payload: { connectorRunId: run.id, documentIds: ["doc-1"] },
        maxAttempts: 5,
      });

      await handleCheckDueConnectors();

      const stillRunning = await ConnectorRunModel.findById(run.id);
      expect(stillRunning?.status).toBe("running");
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    test("stops auto-resuming a crash-looping connector", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        schedule: "",
        enabled: true,
      });
      // 12 recent terminal runs + 1 expired-lease running run = 13 in the window,
      // above the resume cap, so no continuation is enqueued.
      for (let i = 0; i < 12; i++) {
        await ConnectorRunModel.create({
          connectorId: connector.id,
          status: "failed",
          startedAt: new Date(),
        });
      }
      const run = await ConnectorRunModel.create({
        connectorId: connector.id,
        status: "running",
        startedAt: PAST(),
        leaseExpiresAt: EXPIRED_LEASE(),
      });

      await handleCheckDueConnectors();

      const reaped = await ConnectorRunModel.findById(run.id);
      expect(reaped?.status).toBe("partial");
      expect(mockEnqueue).not.toHaveBeenCalled();
    });
  });

  describe("stalled embedding recovery", () => {
    test("re-enqueues embedding for a document stuck pending past the threshold", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        schedule: "",
        enabled: true,
      });
      const doc = await KbDocumentModel.create({
        connectorId: connector.id,
        organizationId: org.id,
        title: "Stuck",
        content: "Stuck content",
        contentHash: "hash-stuck",
        embeddingStatus: "pending",
      });
      // Age it well past the stall threshold (its live task is long dead).
      await db.execute(
        sql`UPDATE kb_documents SET updated_at = now() - interval '2 hours' WHERE id = ${doc.id}`,
      );

      await handleCheckDueConnectors();

      expect(mockEnqueue).toHaveBeenCalledWith({
        taskType: "batch_embedding",
        payload: { documentIds: [doc.id], connectorRunId: null },
      });
    });

    test("recovers a document stalled for 20 minutes (default threshold is 15 min, not 30)", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        schedule: "",
        enabled: true,
      });
      const doc = await KbDocumentModel.create({
        connectorId: connector.id,
        organizationId: org.id,
        title: "Stuck 20m",
        content: "Stuck content",
        contentHash: "hash-stuck-20m",
        embeddingStatus: "processing",
      });
      // 20 min stale: past the 15-min default but within the old 30-min window, so
      // this pins the tightened latency — it would NOT have been swept before.
      await db.execute(
        sql`UPDATE kb_documents SET updated_at = now() - interval '20 minutes' WHERE id = ${doc.id}`,
      );

      await handleCheckDueConnectors();

      expect(mockEnqueue).toHaveBeenCalledWith({
        taskType: "batch_embedding",
        payload: { documentIds: [doc.id], connectorRunId: null },
      });
    });

    test("does not re-enqueue a document that is still fresh", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        schedule: "",
        enabled: true,
      });
      await KbDocumentModel.create({
        connectorId: connector.id,
        organizationId: org.id,
        title: "Fresh",
        content: "Fresh content",
        contentHash: "hash-fresh",
        embeddingStatus: "pending",
      });

      await handleCheckDueConnectors();

      expect(mockEnqueue).not.toHaveBeenCalled();
    });
  });
});
