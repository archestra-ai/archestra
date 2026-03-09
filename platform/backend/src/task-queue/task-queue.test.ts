import { vi } from "vitest";

// Mock TaskModel
const mockCreate = vi.hoisted(() => vi.fn());
const mockDequeue = vi.hoisted(() => vi.fn());
const mockComplete = vi.hoisted(() => vi.fn());
const mockFail = vi.hoisted(() => vi.fn());
const mockResetStuckTasks = vi.hoisted(() => vi.fn().mockResolvedValue(0));
const mockHasPendingOrProcessingByType = vi.hoisted(() =>
  vi.fn().mockResolvedValue(false),
);
vi.mock("@/models", () => ({
  TaskModel: {
    create: mockCreate,
    dequeue: mockDequeue,
    complete: mockComplete,
    fail: mockFail,
    resetStuckTasks: mockResetStuckTasks,
    hasPendingOrProcessingByType: mockHasPendingOrProcessingByType,
  },
}));

// Mock config
vi.mock("@/config", () => ({
  default: {
    kb: {
      taskWorkerPollIntervalSeconds: 1,
      taskWorkerMaxConcurrent: 2,
    },
  },
}));

// Suppress logger output during tests
vi.mock("@/logging", () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocks are set up
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Task } from "@/types/task";
import { taskQueueService } from "./task-queue";

// Helper to create a fake task
function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    taskType: "connector_sync",
    status: "processing",
    payload: { connectorId: "conn-1" },
    attempt: 1,
    maxAttempts: 5,
    lastError: null,
    periodic: false,
    scheduledFor: new Date(),
    startedAt: new Date(),
    completedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("TaskQueueService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    taskQueueService.stopWorker();
    vi.useRealTimers();
  });

  describe("enqueue", () => {
    test("calls TaskModel.create with correct params and returns task id", async () => {
      mockCreate.mockResolvedValue({ id: "task-123" });

      const id = await taskQueueService.enqueue({
        taskType: "connector_sync",
        payload: { connectorId: "conn-1" },
      });

      expect(id).toBe("task-123");
      expect(mockCreate).toHaveBeenCalledWith({
        taskType: "connector_sync",
        payload: { connectorId: "conn-1" },
        maxAttempts: 5,
      });
    });

    test("passes custom maxAttempts when provided", async () => {
      mockCreate.mockResolvedValue({ id: "task-456" });

      await taskQueueService.enqueue({
        taskType: "batch_embedding",
        payload: { documentIds: ["d1"] },
        maxAttempts: 3,
      });

      expect(mockCreate).toHaveBeenCalledWith({
        taskType: "batch_embedding",
        payload: { documentIds: ["d1"] },
        maxAttempts: 3,
      });
    });
  });

  describe("handler registration and dispatch", () => {
    test("registered handler is called with task payload", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const task = fakeTask({
        taskType: "connector_sync",
        payload: { connectorId: "conn-99" },
      });
      mockDequeue.mockResolvedValueOnce(task);
      mockComplete.mockResolvedValue(undefined);

      taskQueueService.registerHandler("connector_sync", handler);
      taskQueueService.startWorker();

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(1000);

      expect(handler).toHaveBeenCalledWith({ connectorId: "conn-99" });
    });

    test("fails task when no handler is registered for task type", async () => {
      const task = fakeTask({ taskType: "batch_embedding" });
      mockDequeue.mockResolvedValueOnce(task);
      mockFail.mockResolvedValue(undefined);

      // Do not register a handler for "batch_embedding"
      taskQueueService.startWorker();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockFail).toHaveBeenCalledWith({
        id: task.id,
        error: "No handler registered for task type: batch_embedding",
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
      });
    });
  });

  describe("task completion", () => {
    test("completes task when handler succeeds", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const task = fakeTask();
      mockDequeue.mockResolvedValueOnce(task);
      mockComplete.mockResolvedValue(undefined);

      taskQueueService.registerHandler("connector_sync", handler);
      taskQueueService.startWorker();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockComplete).toHaveBeenCalledWith(task.id);
    });
  });

  describe("task failure", () => {
    test("fails task when handler throws an error", async () => {
      const handler = vi
        .fn()
        .mockRejectedValue(new Error("something went wrong"));
      const task = fakeTask({ attempt: 2, maxAttempts: 5 });
      mockDequeue.mockResolvedValueOnce(task);
      mockFail.mockResolvedValue(undefined);

      taskQueueService.registerHandler("connector_sync", handler);
      taskQueueService.startWorker();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockFail).toHaveBeenCalledWith({
        id: task.id,
        error: "something went wrong",
        attempt: 2,
        maxAttempts: 5,
      });
      expect(mockComplete).not.toHaveBeenCalled();
    });
  });

  describe("worker lifecycle", () => {
    test("startWorker sets up polling interval", async () => {
      mockDequeue.mockResolvedValue(null);

      taskQueueService.startWorker();

      // First poll after interval
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockDequeue).toHaveBeenCalledTimes(1);

      // Second poll
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockDequeue).toHaveBeenCalledTimes(2);
    });

    test("stopWorker clears intervals and stops polling", async () => {
      mockDequeue.mockResolvedValue(null);

      taskQueueService.startWorker();

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockDequeue).toHaveBeenCalledTimes(1);

      taskQueueService.stopWorker();

      // Further time advances should not trigger more polls
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockDequeue).toHaveBeenCalledTimes(1);
    });

    test("stopWorker is safe to call when worker is not started", () => {
      expect(() => taskQueueService.stopWorker()).not.toThrow();
    });
  });

  describe("poll", () => {
    test("resets stuck tasks before dequeuing", async () => {
      mockDequeue.mockResolvedValue(null);
      mockResetStuckTasks.mockResolvedValue(0);

      taskQueueService.startWorker();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockResetStuckTasks).toHaveBeenCalledWith(60 * 60 * 1000);
    });

    test("does nothing when no tasks are available", async () => {
      mockDequeue.mockResolvedValue(null);

      taskQueueService.startWorker();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockDequeue).toHaveBeenCalled();
      expect(mockComplete).not.toHaveBeenCalled();
      expect(mockFail).not.toHaveBeenCalled();
    });
  });

  describe("seedPeriodicTasks", () => {
    test("seeds periodic tasks when none exist", async () => {
      mockHasPendingOrProcessingByType.mockResolvedValue(false);
      mockCreate.mockResolvedValue({ id: "periodic-1" });

      await taskQueueService.seedPeriodicTasks();

      expect(mockHasPendingOrProcessingByType).toHaveBeenCalledWith(
        "check_due_connectors",
      );
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          taskType: "check_due_connectors",
          payload: {},
          maxAttempts: 1,
          periodic: true,
        }),
      );
    });

    test("skips seeding when periodic task already exists", async () => {
      mockHasPendingOrProcessingByType.mockResolvedValue(true);

      await taskQueueService.seedPeriodicTasks();

      expect(mockCreate).not.toHaveBeenCalled();
    });

    test("catches unique constraint violation during seeding", async () => {
      mockHasPendingOrProcessingByType.mockResolvedValue(false);
      const uniqueError = Object.assign(new Error("unique violation"), {
        code: "23505",
      });
      mockCreate.mockRejectedValue(uniqueError);

      // Should not throw
      await expect(
        taskQueueService.seedPeriodicTasks(),
      ).resolves.toBeUndefined();
    });
  });

  describe("rescheduleIfPeriodic", () => {
    test("reschedules periodic task after completion", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const task = fakeTask({
        taskType: "check_due_connectors",
        periodic: true,
        maxAttempts: 1,
        payload: {},
      });
      mockDequeue.mockResolvedValueOnce(task);
      mockComplete.mockResolvedValue(undefined);
      // First call for reschedule
      mockCreate.mockResolvedValue({ id: "rescheduled-1" });

      taskQueueService.registerHandler("check_due_connectors", handler);
      taskQueueService.startWorker();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockComplete).toHaveBeenCalledWith(task.id);
      // Verify reschedule was called with periodic: true and a future scheduledFor
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          taskType: "check_due_connectors",
          payload: {},
          maxAttempts: 1,
          periodic: true,
          scheduledFor: expect.any(Date),
        }),
      );
    });

    test("reschedules periodic task after terminal failure (dead)", async () => {
      const handler = vi
        .fn()
        .mockRejectedValue(new Error("periodic task failed"));
      const task = fakeTask({
        taskType: "check_due_connectors",
        periodic: true,
        attempt: 1,
        maxAttempts: 1,
        payload: {},
      });
      mockDequeue.mockResolvedValueOnce(task);
      mockFail.mockResolvedValue({ ...task, status: "dead" });
      mockCreate.mockResolvedValue({ id: "rescheduled-2" });

      taskQueueService.registerHandler("check_due_connectors", handler);
      taskQueueService.startWorker();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockFail).toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          taskType: "check_due_connectors",
          periodic: true,
        }),
      );
    });

    test("does not reschedule non-periodic tasks", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const task = fakeTask({
        taskType: "connector_sync",
        payload: { connectorId: "conn-1" },
      });
      mockDequeue.mockResolvedValueOnce(task);
      mockComplete.mockResolvedValue(undefined);

      taskQueueService.registerHandler("connector_sync", handler);
      taskQueueService.startWorker();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockComplete).toHaveBeenCalledWith(task.id);
      // mockCreate should not have been called for rescheduling
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test("catches unique constraint violation during rescheduling", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const task = fakeTask({
        taskType: "check_due_connectors",
        periodic: true,
        payload: {},
      });
      mockDequeue.mockResolvedValueOnce(task);
      mockComplete.mockResolvedValue(undefined);
      const uniqueError = Object.assign(new Error("unique violation"), {
        code: "23505",
      });
      mockCreate.mockRejectedValue(uniqueError);

      taskQueueService.registerHandler("check_due_connectors", handler);
      taskQueueService.startWorker();

      // Should not throw
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockComplete).toHaveBeenCalledWith(task.id);
    });
  });
});
