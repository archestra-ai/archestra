import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import TaskModel from "./task";

describe("TaskModel", () => {
  describe("create", () => {
    test("creates a task with correct defaults", async () => {
      const task = await TaskModel.create({
        taskType: "connector_sync",
        payload: { connectorId: "conn-1" },
      });

      expect(task.id).toBeDefined();
      expect(task.taskType).toBe("connector_sync");
      expect(task.payload).toEqual({ connectorId: "conn-1" });
      expect(task.status).toBe("pending");
      expect(task.attempt).toBe(0);
      expect(task.maxAttempts).toBe(5);
      expect(task.scheduledFor).toBeInstanceOf(Date);
      expect(task.startedAt).toBeNull();
      expect(task.completedAt).toBeNull();
      expect(task.lastError).toBeNull();
    });
  });

  describe("dequeue", () => {
    test("dequeues a pending task", async () => {
      const created = await TaskModel.create({
        taskType: "connector_sync",
        payload: { connectorId: "conn-1" },
      });

      const dequeued = await TaskModel.dequeue();

      expect(dequeued).not.toBeNull();
      expect(dequeued?.id).toBe(created.id);
      expect(dequeued?.status).toBe("processing");
      expect(dequeued?.attempt).toBe(1);
      expect(dequeued?.startedAt).not.toBeNull();
    });

    test("returns null when no tasks are pending", async () => {
      const result = await TaskModel.dequeue();
      expect(result).toBeNull();
    });

    test("does not dequeue tasks scheduled in the future", async () => {
      const futureDate = new Date(Date.now() + 60_000);
      await TaskModel.create({
        taskType: "connector_sync",
        payload: { connectorId: "conn-1" },
        scheduledFor: futureDate,
      });

      const result = await TaskModel.dequeue();
      expect(result).toBeNull();
    });
  });

  describe("complete", () => {
    test("sets status to completed with completedAt", async () => {
      const task = await TaskModel.create({
        taskType: "connector_sync",
        payload: { connectorId: "conn-1" },
      });

      const completed = await TaskModel.complete(task.id);

      expect(completed).not.toBeNull();
      expect(completed?.status).toBe("completed");
      expect(completed?.completedAt).toBeInstanceOf(Date);
    });
  });

  describe("fail", () => {
    test("sets status back to pending with backoff when attempt < maxAttempts", async () => {
      const task = await TaskModel.create({
        taskType: "connector_sync",
        payload: { connectorId: "conn-1" },
        maxAttempts: 3,
      });

      const failed = await TaskModel.fail({
        id: task.id,
        error: "Something went wrong",
        attempt: 1,
        maxAttempts: 3,
      });

      expect(failed).not.toBeNull();
      expect(failed?.status).toBe("pending");
      expect(failed?.lastError).toBe("Something went wrong");
      expect(failed?.scheduledFor.getTime()).toBeGreaterThan(Date.now());
    });

    test("sets status to dead when attempt >= maxAttempts", async () => {
      const task = await TaskModel.create({
        taskType: "connector_sync",
        payload: { connectorId: "conn-1" },
        maxAttempts: 3,
      });

      const failed = await TaskModel.fail({
        id: task.id,
        error: "Final failure",
        attempt: 3,
        maxAttempts: 3,
      });

      expect(failed).not.toBeNull();
      expect(failed?.status).toBe("dead");
      expect(failed?.lastError).toBe("Final failure");
      expect(failed?.completedAt).toBeInstanceOf(Date);
    });
  });

  describe("resetStuckTasks", () => {
    test("resets tasks stuck in processing past the timeout", async () => {
      // Create a task and manually set it to processing with an old startedAt
      const task = await TaskModel.create({
        taskType: "connector_sync",
        payload: { connectorId: "conn-1" },
        maxAttempts: 5,
      });

      // Simulate a stuck task: set status to processing with startedAt in the past
      const twoMinutesAgo = new Date(Date.now() - 120_000);
      await db
        .update(schema.tasksTable)
        .set({
          status: "processing",
          startedAt: twoMinutesAgo,
          attempt: 1,
        })
        .where(eq(schema.tasksTable.id, task.id));

      // Reset tasks stuck for more than 60 seconds
      const count = await TaskModel.resetStuckTasks(60_000);

      expect(count).toBe(1);
    });
  });

  describe("hasPendingOrProcessing", () => {
    test("returns true when a matching task exists", async () => {
      await TaskModel.create({
        taskType: "connector_sync",
        payload: { connectorId: "conn-123" },
      });

      const result = await TaskModel.hasPendingOrProcessing(
        "connector_sync",
        "conn-123",
      );
      expect(result).toBe(true);
    });

    test("returns false when no matching task exists", async () => {
      const result = await TaskModel.hasPendingOrProcessing(
        "connector_sync",
        "conn-nonexistent",
      );
      expect(result).toBe(false);
    });
  });

  describe("hasPendingOrProcessingByType", () => {
    test("returns true when a pending task of that type exists", async () => {
      await TaskModel.create({
        taskType: "check_due_connectors",
        payload: {},
      });

      const result = await TaskModel.hasPendingOrProcessingByType(
        "check_due_connectors",
      );
      expect(result).toBe(true);
    });

    test("returns false when no task of that type exists", async () => {
      const result = await TaskModel.hasPendingOrProcessingByType(
        "check_due_connectors",
      );
      expect(result).toBe(false);
    });

    test("returns false when task of that type is completed", async () => {
      const task = await TaskModel.create({
        taskType: "check_due_connectors",
        payload: {},
      });
      await TaskModel.complete(task.id);

      const result = await TaskModel.hasPendingOrProcessingByType(
        "check_due_connectors",
      );
      expect(result).toBe(false);
    });
  });
});
