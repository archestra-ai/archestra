import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";

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

import { handleConnectorSync } from "./connector-sync-handler";

describe("handleConnectorSync", () => {
  let connectorId: string;

  beforeEach(() => {
    connectorId = randomUUID();
    vi.clearAllMocks();
  });

  test("calls executeSync with the connector ID", async () => {
    mockExecuteSync.mockResolvedValue({ status: "complete" });

    await handleConnectorSync({ connectorId });

    expect(mockExecuteSync).toHaveBeenCalledWith(
      connectorId,
      expect.objectContaining({
        logger: expect.any(Object),
        getLogOutput: expect.any(Function),
      }),
    );
  });

  test("enqueues continuation with incremented count on partial result", async () => {
    mockExecuteSync.mockResolvedValue({ status: "partial" });

    await handleConnectorSync({ connectorId, continuationCount: 3 });

    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "connector_sync",
      payload: {
        connectorId,
        continuationCount: 4,
      },
    });
  });

  test("does not enqueue when continuation count >= 50", async () => {
    mockExecuteSync.mockResolvedValue({ status: "partial" });

    await handleConnectorSync({ connectorId, continuationCount: 50 });

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("throws when connectorId is missing", async () => {
    await expect(handleConnectorSync({})).rejects.toThrow(
      "Missing connectorId in connector_sync payload",
    );
  });
});
