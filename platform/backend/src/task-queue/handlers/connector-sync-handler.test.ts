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

const mockWithinResumeBudget = vi.hoisted(() => vi.fn());
vi.mock("./connector-resume-budget", () => ({
  withinResumeBudget: mockWithinResumeBudget,
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
    mockWithinResumeBudget.mockResolvedValue(true);
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

  test("enqueues a continuation on a partial result when within the run budget", async () => {
    mockExecuteSync.mockResolvedValue({ status: "partial" });
    mockWithinResumeBudget.mockResolvedValue(true);

    await handleConnectorSync({ connectorId });

    expect(mockWithinResumeBudget).toHaveBeenCalledWith(connectorId);
    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "connector_sync",
      payload: { connectorId },
    });
  });

  test("does not enqueue a continuation when the connector is over its run budget", async () => {
    mockExecuteSync.mockResolvedValue({ status: "partial" });
    mockWithinResumeBudget.mockResolvedValue(false);

    await handleConnectorSync({ connectorId });

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("throws when connectorId is missing", async () => {
    await expect(handleConnectorSync({})).rejects.toThrow(
      "Missing connectorId in connector_sync payload",
    );
  });
});
