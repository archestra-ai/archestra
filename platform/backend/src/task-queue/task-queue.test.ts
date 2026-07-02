import { vi } from "vitest";

// Mock config (poll interval / concurrency / shutdown timeout are read at
// startWorker/stopWorker time; the canonical factory keeps the rest of config
// real). Config is a process-boundary concern, not a database interface.
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    kb: {
      taskWorkerPollIntervalSeconds: 1,
      taskWorkerMaxConcurrent: 2,
      taskWorkerShutdownTimeoutSeconds: 5,
    },
  }),
);

// Mock observability metrics (avoid importing tracing which requires config.observability.otel)
vi.mock("@/observability/metrics", () => ({
  taskQueue: {
    reportTaskEnqueued: vi.fn(),
    reportTaskCompleted: vi.fn(),
    reportTaskFailed: vi.fn(),
    reportTaskDead: vi.fn(),
    reportActiveTaskChange: vi.fn(),
    reportStuckTasksReset: vi.fn(),
  },
}));

// Import after mocks are set up
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import db, { schema } from "@/database";
import { TaskModel } from "@/models";
import type { InsertTask, Task } from "@/types";
import { taskQueueService } from "./task-queue";

// Seeds a real task row. scheduledFor defaults to the past so the worker's
// `scheduled_for <= NOW()` dequeue picks it up immediately.
async function seedTask(overrides: Partial<InsertTask> = {}): Promise<Task> {
  return await TaskModel.create({
    taskType: "connector_sync",
    payload: { connectorId: "conn-1" },
    scheduledFor: new Date(Date.now() - 60_000),
    ...overrides,
  });
}

async function getTask(id: string): Promise<Task | undefined> {
  const [row] = await db
    .select()
    .from(schema.tasksTable)
    .where(eq(schema.tasksTable.id, id));
  return row;
}

async function countTasks(
  where: Partial<Pick<Task, "taskType" | "status">>,
): Promise<number> {
  const rows = await db.select().from(schema.tasksTable);
  return rows.filter(
    (r) =>
      (where.taskType === undefined || r.taskType === where.taskType) &&
      (where.status === undefined || r.status === where.status),
  ).length;
}

describe("TaskQueueService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await taskQueueService.stopWorker();
    vi.useRealTimers();
    // Restore any vi.spyOn(TaskModel, ...) fault-injection so a rejecting
    // create() doesn't leak into later (shuffled-order) tests.
    vi.restoreAllMocks();
  });

  describe("enqueue", () => {
    test("persists a task with the given params and returns its id", async () => {
      const id = await taskQueueService.enqueue({
        taskType: "connector_sync",
        payload: { connectorId: "conn-1" },
      });

      const task = await getTask(id);
      expect(task?.taskType).toBe("connector_sync");
      expect(task?.payload).toEqual({ connectorId: "conn-1" });
      expect(task?.maxAttempts).toBe(5);
    });

    test("persists custom maxAttempts when provided", async () => {
      const id = await taskQueueService.enqueue({
        taskType: "batch_embedding",
        payload: { documentIds: ["d1"] },
        maxAttempts: 3,
      });

      const task = await getTask(id);
      expect(task?.maxAttempts).toBe(3);
      expect(task?.payload).toEqual({ documentIds: ["d1"] });
    });
  });

  describe("handler registration and dispatch", () => {
    test("registered handler is called with task payload and task completes", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const task = await seedTask({
        taskType: "connector_sync",
        payload: { connectorId: "conn-99" },
      });

      taskQueueService.registerHandler("connector_sync", handler);
      taskQueueService.startWorker();

      await vi.advanceTimersByTimeAsync(1000);

      expect(handler).toHaveBeenCalledWith({ connectorId: "conn-99" });
      expect((await getTask(task.id))?.status).toBe("completed");
    });

    test("fails task when no handler is registered for task type", async () => {
      const task = await seedTask({ taskType: "batch_embedding" });

      // Do not register a handler for "batch_embedding"
      taskQueueService.startWorker();

      await vi.advanceTimersByTimeAsync(1000);

      const updated = await getTask(task.id);
      expect(updated?.lastError).toBe(
        "No handler registered for task type: batch_embedding",
      );
      expect(updated?.status).not.toBe("completed");
    });
  });

  describe("task completion", () => {
    test("completes task when handler succeeds", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const task = await seedTask();

      taskQueueService.registerHandler("connector_sync", handler);
      taskQueueService.startWorker();

      await vi.advanceTimersByTimeAsync(1000);

      expect((await getTask(task.id))?.status).toBe("completed");
    });
  });

  describe("task failure", () => {
    test("fails task when handler throws an error", async () => {
      const handler = vi
        .fn()
        .mockRejectedValue(new Error("something went wrong"));
      const task = await seedTask({ attempt: 2, maxAttempts: 5 });

      taskQueueService.registerHandler("connector_sync", handler);
      taskQueueService.startWorker();

      await vi.advanceTimersByTimeAsync(1000);

      const updated = await getTask(task.id);
      expect(updated?.lastError).toBe("something went wrong");
      // attempt (2) < maxAttempts (5) → retried, not completed
      expect(updated?.status).toBe("pending");
    });
  });

  describe("worker lifecycle", () => {
    test("startWorker polls repeatedly", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      taskQueueService.registerHandler("connector_sync", handler);

      const first = await seedTask();
      taskQueueService.startWorker();
      await vi.advanceTimersByTimeAsync(1000);
      expect((await getTask(first.id))?.status).toBe("completed");

      // A second task enqueued later is picked up on a subsequent poll,
      // proving the interval keeps firing.
      const second = await seedTask();
      await vi.advanceTimersByTimeAsync(1000);
      expect((await getTask(second.id))?.status).toBe("completed");
    });

    test("stopWorker stops polling", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      taskQueueService.registerHandler("connector_sync", handler);

      const first = await seedTask();
      taskQueueService.startWorker();
      await vi.advanceTimersByTimeAsync(1000);
      expect((await getTask(first.id))?.status).toBe("completed");

      await taskQueueService.stopWorker();

      // A task enqueued after stop is never processed.
      const second = await seedTask();
      await vi.advanceTimersByTimeAsync(5000);
      expect((await getTask(second.id))?.status).toBe("pending");
    });

    test("stopWorker is safe to call when worker is not started", async () => {
      await expect(taskQueueService.stopWorker()).resolves.toBeUndefined();
    });

    test("stopWorker resolves immediately when no in-flight tasks", async () => {
      taskQueueService.startWorker();
      await vi.advanceTimersByTimeAsync(1000);

      await expect(taskQueueService.stopWorker()).resolves.toBeUndefined();
    });

    test("stopWorker waits for in-flight tasks to drain", async () => {
      let resolveHandler!: () => void;
      const handlerPromise = new Promise<void>((resolve) => {
        resolveHandler = resolve;
      });
      const handler = vi.fn().mockReturnValue(handlerPromise);
      const task = await seedTask();

      taskQueueService.registerHandler("connector_sync", handler);
      taskQueueService.startWorker();

      // Trigger poll to pick up the task
      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).toHaveBeenCalled();

      // Start stopping — should not resolve until the handler finishes
      const stopPromise = taskQueueService.stopWorker();
      resolveHandler();
      await stopPromise;

      // Drained normally → task completed, not released back to pending.
      expect((await getTask(task.id))?.status).toBe("completed");
    });

    test("stopWorker releases tasks back to pending when drain times out", async () => {
      const handler = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
      const task = await seedTask();

      taskQueueService.registerHandler("connector_sync", handler);
      taskQueueService.startWorker();

      // Trigger poll to pick up the task
      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).toHaveBeenCalled();

      // Start stopping and advance past the timeout (5s configured in mock)
      const stopPromise = taskQueueService.stopWorker();
      await vi.advanceTimersByTimeAsync(5000);
      await stopPromise;

      // The in-flight task was released back to the queue.
      expect((await getTask(task.id))?.status).toBe("pending");
    });
  });

  describe("poll", () => {
    test("resets stuck tasks before dequeuing", async () => {
      // A task stuck in processing for over an hour.
      const stuck = await seedTask({
        status: "processing",
        startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      });

      taskQueueService.startWorker();
      await vi.advanceTimersByTimeAsync(1000);

      // resetStuckTasks (1h threshold) recovered it back to pending.
      expect((await getTask(stuck.id))?.status).toBe("pending");
    });

    test("does nothing when no tasks are available", async () => {
      taskQueueService.startWorker();

      await vi.advanceTimersByTimeAsync(1000);

      expect(await countTasks({ status: "completed" })).toBe(0);
    });
  });

  describe("seedPeriodicTasks", () => {
    test("seeds periodic tasks when none exist", async () => {
      await taskQueueService.seedPeriodicTasks();

      const rows = await db
        .select()
        .from(schema.tasksTable)
        .where(eq(schema.tasksTable.taskType, "check_due_connectors"));
      expect(rows).toHaveLength(1);
      expect(rows[0].periodic).toBe(true);
      expect(rows[0].maxAttempts).toBe(1);
      expect(rows[0].payload).toEqual({});
    });

    test("skips seeding when periodic task already exists", async () => {
      await seedTask({
        taskType: "check_due_connectors",
        payload: {},
        periodic: true,
        maxAttempts: 1,
        status: "pending",
      });

      await taskQueueService.seedPeriodicTasks();

      // Not duplicated for the already-present type.
      expect(await countTasks({ taskType: "check_due_connectors" })).toBe(1);
    });

    test("catches unique constraint violation during seeding", async () => {
      const uniqueError = Object.assign(new Error("unique violation"), {
        code: "23505",
      });
      vi.spyOn(TaskModel, "create").mockRejectedValue(uniqueError);

      // Should not throw
      await expect(
        taskQueueService.seedPeriodicTasks(),
      ).resolves.toBeUndefined();
    });
  });

  describe("rescheduleIfPeriodic", () => {
    test("reschedules periodic task after completion", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const task = await seedTask({
        taskType: "check_due_connectors",
        periodic: true,
        maxAttempts: 1,
        payload: {},
      });

      taskQueueService.registerHandler("check_due_connectors", handler);
      taskQueueService.startWorker();

      await vi.advanceTimersByTimeAsync(1000);

      expect((await getTask(task.id))?.status).toBe("completed");
      // A fresh periodic task was enqueued for the next interval.
      const pending = await countTasks({
        taskType: "check_due_connectors",
        status: "pending",
      });
      expect(pending).toBe(1);
    });

    test("reschedules periodic task after terminal failure (dead)", async () => {
      const handler = vi
        .fn()
        .mockRejectedValue(new Error("periodic task failed"));
      const task = await seedTask({
        taskType: "check_due_connectors",
        periodic: true,
        attempt: 1,
        maxAttempts: 1,
        payload: {},
      });

      taskQueueService.registerHandler("check_due_connectors", handler);
      taskQueueService.startWorker();

      await vi.advanceTimersByTimeAsync(1000);

      // attempt (1) >= maxAttempts (1) → dead, and a replacement was scheduled.
      expect((await getTask(task.id))?.status).toBe("dead");
      expect(
        await countTasks({
          taskType: "check_due_connectors",
          status: "pending",
        }),
      ).toBe(1);
    });

    test("does not reschedule non-periodic tasks", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const task = await seedTask({
        taskType: "connector_sync",
        payload: { connectorId: "conn-1" },
      });

      taskQueueService.registerHandler("connector_sync", handler);
      taskQueueService.startWorker();

      await vi.advanceTimersByTimeAsync(1000);

      expect((await getTask(task.id))?.status).toBe("completed");
      // No new task was created.
      expect(await countTasks({ status: "pending" })).toBe(0);
    });

    test("catches unique constraint violation during rescheduling", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const task = await seedTask({
        taskType: "check_due_connectors",
        periodic: true,
        payload: {},
      });

      taskQueueService.registerHandler("check_due_connectors", handler);
      // Force the reschedule enqueue (TaskModel.create) to hit a unique
      // violation; complete() uses a different method so the task still finishes.
      const uniqueError = Object.assign(new Error("unique violation"), {
        code: "23505",
      });
      vi.spyOn(TaskModel, "create").mockRejectedValue(uniqueError);

      taskQueueService.startWorker();

      // Should not throw
      await vi.advanceTimersByTimeAsync(1000);

      expect((await getTask(task.id))?.status).toBe("completed");
    });
  });
});
