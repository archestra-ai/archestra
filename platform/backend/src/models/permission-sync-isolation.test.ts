// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { and, count, eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { ConnectorRunModel, TaskModel } from "@/models";
import { TaskQueueService } from "@/task-queue/task-queue";
import { describe, expect, test } from "@/test";
import { TASK_LANES, type TaskType } from "@/types";

async function pendingCount(taskType: TaskType): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(schema.tasksTable)
    .where(
      and(
        eq(schema.tasksTable.taskType, taskType),
        eq(schema.tasksTable.status, "pending"),
      ),
    );
  return row?.value ?? 0;
}

describe("permission-sync runtime isolation", () => {
  describe("Guarantee 2: non-conflicting leases", () => {
    test("a content run and a permission run for the same connector can both be running", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const content = await ConnectorRunModel.claim({
        connectorId: connector.id,
        owner: "worker-a",
        leaseTtlSeconds: 300,
        runType: "content",
      });
      const permission = await ConnectorRunModel.claim({
        connectorId: connector.id,
        owner: "worker-b",
        leaseTtlSeconds: 300,
        runType: "permission",
      });

      expect(content.outcome).toBe("claimed");
      expect(permission.outcome).toBe("claimed");
    });

    test("two permission runs for the same connector still single-flight", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const first = await ConnectorRunModel.claim({
        connectorId: connector.id,
        owner: "worker-a",
        leaseTtlSeconds: 300,
        runType: "permission",
      });
      const second = await ConnectorRunModel.claim({
        connectorId: connector.id,
        owner: "worker-b",
        leaseTtlSeconds: 300,
        runType: "permission",
      });

      expect(first.outcome).toBe("claimed");
      expect(second.outcome).toBe("busy");
    });

    test("reapExpiredRuns only reaps runs of the given family", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      // Both runs claimed with an already-expired lease.
      await ConnectorRunModel.claim({
        connectorId: connector.id,
        owner: "w",
        leaseTtlSeconds: -1,
        runType: "content",
      });
      await ConnectorRunModel.claim({
        connectorId: connector.id,
        owner: "w",
        leaseTtlSeconds: -1,
        runType: "permission",
      });

      const reapedPermission =
        await ConnectorRunModel.reapExpiredRuns("permission");
      expect(reapedPermission).toHaveLength(1);

      // The content run must still be reapable — it was not touched above.
      const reapedContent = await ConnectorRunModel.reapExpiredRuns("content");
      expect(reapedContent).toHaveLength(1);
    });
  });

  describe("Guarantee 3: lane-scoped dequeue (no head-of-line blocking)", () => {
    test("a saturated content lane does not block a permission_sync dequeue", async () => {
      // Content-lane tasks enqueued first (older created_at) — a global FIFO
      // would hand these back before the permission task.
      await TaskModel.create({
        taskType: "connector_sync",
        payload: { connectorId: "c1" },
      });
      await TaskModel.create({
        taskType: "batch_embedding",
        payload: { documentIds: [], connectorRunId: "r1" },
      });
      await TaskModel.create({
        taskType: "permission_sync",
        payload: { connectorId: "c1" },
      });

      const permissionTask = await TaskModel.dequeue(TASK_LANES.permission);

      expect(permissionTask?.taskType).toBe("permission_sync");
    });

    test("the content lane never dequeues a permission task", async () => {
      await TaskModel.create({
        taskType: "permission_sync",
        payload: { connectorId: "c1" },
      });

      const contentTask = await TaskModel.dequeue(TASK_LANES.content);

      expect(contentTask).toBeNull();
    });

    test("per-lane worker caps are independent: a saturated content lane still lets a permission_sync run", async () => {
      // Cap each lane at 1 so a single in-flight content task saturates its lane.
      config.kb.taskWorkerMaxConcurrent = 1;
      config.kb.permissionSyncWorkerMaxConcurrent = 1;

      const service = new TaskQueueService();

      let releaseContent!: () => void;
      const contentBlock = new Promise<void>((resolve) => {
        releaseContent = resolve;
      });
      let contentStarted = 0;
      service.registerHandler("connector_sync", async () => {
        contentStarted += 1;
        await contentBlock; // hold the content lane's one slot
      });

      let permissionRan = false;
      service.registerHandler("permission_sync", async () => {
        permissionRan = true;
      });

      // Two content tasks (older) + one permission task (newest). A single
      // global FIFO with one shared cap would run only the first content task.
      await service.enqueue({
        taskType: "connector_sync",
        payload: { connectorId: "c1" },
      });
      await service.enqueue({
        taskType: "connector_sync",
        payload: { connectorId: "c2" },
      });
      await service.enqueue({
        taskType: "permission_sync",
        payload: { connectorId: "c1" },
      });

      // biome-ignore lint/suspicious/noExplicitAny: exercise the private poll.
      await (service as any).doPoll();

      // The permission lane ran its task even though the content lane is
      // saturated (one running, one still queued) — independent caps.
      expect(permissionRan).toBe(true);
      expect(contentStarted).toBe(1);
      // The content lane's cap was respected: the second content task is still
      // pending (it did NOT consume a slot).
      expect(await pendingCount("connector_sync")).toBe(1);

      // Release the held content task and let its processing settle.
      releaseContent();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    });
  });
});
