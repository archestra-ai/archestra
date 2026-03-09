import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFindAllEnabled = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockFindAllWithStatus = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockConnectorUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockHasPendingOrProcessing = vi.hoisted(() =>
  vi.fn().mockResolvedValue(false),
);
const mockHasActiveRun = vi.hoisted(() => vi.fn().mockResolvedValue(false));
vi.mock("@/models", () => ({
  KnowledgeBaseConnectorModel: {
    findAllEnabled: mockFindAllEnabled,
    findAllWithStatus: mockFindAllWithStatus,
    update: mockConnectorUpdate,
  },
  TaskModel: { hasPendingOrProcessing: mockHasPendingOrProcessing },
  ConnectorRunModel: { hasActiveRun: mockHasActiveRun },
}));

const mockEnqueue = vi.hoisted(() => vi.fn().mockResolvedValue("task-id"));
vi.mock("@/task-queue", () => ({
  taskQueueService: { enqueue: mockEnqueue },
}));

vi.mock("@/logging", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { handleCheckDueConnectors } from "./check-due-connectors-handler";

describe("handleCheckDueConnectors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("does nothing when no connectors are enabled", async () => {
    mockFindAllEnabled.mockResolvedValue([]);

    await handleCheckDueConnectors();

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("skips connectors without a schedule", async () => {
    mockFindAllEnabled.mockResolvedValue([
      { id: "conn-1", schedule: null, lastSyncAt: null },
    ]);

    await handleCheckDueConnectors();

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("enqueues connector sync when cron is due", async () => {
    const pastDate = new Date(Date.now() - 120_000);
    mockFindAllEnabled.mockResolvedValue([
      {
        id: "conn-1",
        schedule: "* * * * *", // every minute
        lastSyncAt: pastDate,
      },
    ]);
    mockHasPendingOrProcessing.mockResolvedValue(false);

    await handleCheckDueConnectors();

    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "connector_sync",
      payload: { connectorId: "conn-1" },
    });
  });

  test("does not enqueue when a pending/processing task already exists", async () => {
    const pastDate = new Date(Date.now() - 120_000);
    mockFindAllEnabled.mockResolvedValue([
      {
        id: "conn-1",
        schedule: "* * * * *",
        lastSyncAt: pastDate,
      },
    ]);
    mockHasPendingOrProcessing.mockResolvedValue(true);

    await handleCheckDueConnectors();

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("continues processing other connectors when one fails", async () => {
    const pastDate = new Date(Date.now() - 120_000);
    mockFindAllEnabled.mockResolvedValue([
      {
        id: "conn-bad",
        schedule: "INVALID_CRON",
        lastSyncAt: pastDate,
      },
      {
        id: "conn-good",
        schedule: "* * * * *",
        lastSyncAt: pastDate,
      },
    ]);
    mockHasPendingOrProcessing.mockResolvedValue(false);

    await handleCheckDueConnectors();

    // The good connector should still be enqueued despite the bad one failing
    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "connector_sync",
      payload: { connectorId: "conn-good" },
    });
  });

  test("resets orphaned running status to failed when no task or run exists", async () => {
    mockFindAllWithStatus.mockResolvedValue([{ id: "conn-orphan" }]);
    mockHasPendingOrProcessing.mockResolvedValue(false);
    mockHasActiveRun.mockResolvedValue(false);

    await handleCheckDueConnectors();

    expect(mockConnectorUpdate).toHaveBeenCalledWith("conn-orphan", {
      lastSyncStatus: "failed",
      lastSyncError: "Sync task was lost",
    });
  });

  test("does not reset running status when a pending task exists", async () => {
    mockFindAllWithStatus.mockResolvedValue([{ id: "conn-pending" }]);
    mockHasPendingOrProcessing.mockResolvedValue(true);

    await handleCheckDueConnectors();

    expect(mockConnectorUpdate).not.toHaveBeenCalled();
  });

  test("does not reset running status when an active run exists", async () => {
    mockFindAllWithStatus.mockResolvedValue([{ id: "conn-active" }]);
    mockHasPendingOrProcessing.mockResolvedValue(false);
    mockHasActiveRun.mockResolvedValue(true);

    await handleCheckDueConnectors();

    expect(mockConnectorUpdate).not.toHaveBeenCalled();
  });
});
