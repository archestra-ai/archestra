import { beforeEach, describe, expect, test, vi } from "vitest";

const mockExecuteSync = vi.hoisted(() => vi.fn());
vi.mock("@/knowledge-base", () => ({
  connectorSyncService: { executeSync: mockExecuteSync },
}));

const mockEnqueue = vi.hoisted(() => vi.fn().mockResolvedValue("task-id"));
vi.mock("@/task-queue", () => ({
  taskQueueService: { enqueue: mockEnqueue },
}));

vi.mock("@/entrypoints/_shared/log-capture", () => ({
  createCapturingLogger: () => ({
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
      fatal: vi.fn(),
    },
    getLogOutput: () => "",
  }),
}));

vi.mock("@/logging", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/config", () => ({
  default: {
    kb: {
      connectorSyncMaxDurationSeconds: undefined,
    },
  },
}));

import { handleConnectorSync } from "./connector-sync-handler";

describe("handleConnectorSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("calls executeSync with the connector ID", async () => {
    mockExecuteSync.mockResolvedValue({ status: "complete" });

    await handleConnectorSync({ connectorId: "conn-1" });

    expect(mockExecuteSync).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({
        logger: expect.any(Object),
        getLogOutput: expect.any(Function),
      }),
    );
  });

  test("enqueues continuation with incremented count on partial result", async () => {
    mockExecuteSync.mockResolvedValue({ status: "partial" });

    await handleConnectorSync({ connectorId: "conn-1", continuationCount: 3 });

    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "connector_sync",
      payload: {
        connectorId: "conn-1",
        continuationCount: 4,
      },
    });
  });

  test("does not enqueue when continuation count >= 50", async () => {
    mockExecuteSync.mockResolvedValue({ status: "partial" });

    await handleConnectorSync({ connectorId: "conn-1", continuationCount: 50 });

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("throws when connectorId is missing", async () => {
    await expect(handleConnectorSync({})).rejects.toThrow(
      "Missing connectorId in connector_sync payload",
    );
  });
});
