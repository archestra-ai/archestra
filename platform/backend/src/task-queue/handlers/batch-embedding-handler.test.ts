import { beforeEach, describe, expect, test, vi } from "vitest";

const mockProcessDocuments = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
vi.mock("@/knowledge-base", () => ({
  embeddingService: { processDocuments: mockProcessDocuments },
}));

const mockCompleteBatch = vi.hoisted(() => vi.fn());
const mockUpdateConnector = vi.hoisted(() => vi.fn());
const mockFindByIdConnector = vi.hoisted(() => vi.fn());
vi.mock("@/models", () => ({
  ConnectorRunModel: { completeBatch: mockCompleteBatch },
  KnowledgeBaseConnectorModel: {
    update: mockUpdateConnector,
    findById: mockFindByIdConnector,
  },
}));

vi.mock("@/logging", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { handleBatchEmbedding } from "./batch-embedding-handler";

describe("handleBatchEmbedding", () => {
  const OLD_DATE = new Date("2020-01-01T00:00:00.000Z");
  const RUN_STARTED_AT = new Date("2026-04-22T10:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessDocuments.mockResolvedValue(undefined);
    // Default: connector's lastSyncAt is old → no newer run → update proceeds
    mockFindByIdConnector.mockResolvedValue({ lastSyncAt: OLD_DATE });
  });

  test("processes documents and completes batch", async () => {
    mockCompleteBatch.mockResolvedValue({
      connectorId: "conn-1",
      completedBatches: 1,
      totalBatches: 3,
    });

    await handleBatchEmbedding({
      documentIds: ["doc-1", "doc-2"],
      connectorRunId: "run-1",
    });

    expect(mockProcessDocuments).toHaveBeenCalledWith(
      ["doc-1", "doc-2"],
      "run-1",
    );
    expect(mockCompleteBatch).toHaveBeenCalledWith("run-1");
    expect(mockUpdateConnector).not.toHaveBeenCalled();
  });

  test("finalizes connector when all batches are done", async () => {
    mockCompleteBatch.mockResolvedValue({
      connectorId: "conn-1",
      completedBatches: 3,
      totalBatches: 3,
      status: "success",
      startedAt: RUN_STARTED_AT,
    });

    await handleBatchEmbedding({
      documentIds: ["doc-1"],
      connectorRunId: "run-1",
    });

    expect(mockUpdateConnector).toHaveBeenCalledWith("conn-1", {
      lastSyncStatus: "success",
      lastSyncAt: expect.any(Date),
    });
  });

  test("skips connector update when a newer run has started", async () => {
    const newerDate = new Date(RUN_STARTED_AT.getTime() + 60_000);
    mockFindByIdConnector.mockResolvedValue({ lastSyncAt: newerDate });
    mockCompleteBatch.mockResolvedValue({
      connectorId: "conn-1",
      completedBatches: 3,
      totalBatches: 3,
      status: "success",
      startedAt: RUN_STARTED_AT,
    });

    await handleBatchEmbedding({
      documentIds: ["doc-1"],
      connectorRunId: "run-1",
    });

    expect(mockUpdateConnector).not.toHaveBeenCalled();
  });

  test("throws when documentIds is missing", async () => {
    await expect(
      handleBatchEmbedding({ connectorRunId: "run-1" }),
    ).rejects.toThrow(
      "Missing documentIds or connectorRunId in batch_embedding payload",
    );
  });

  test("throws when connectorRunId is missing", async () => {
    await expect(
      handleBatchEmbedding({ documentIds: ["doc-1"] }),
    ).rejects.toThrow(
      "Missing documentIds or connectorRunId in batch_embedding payload",
    );
  });

  test("does not update connector status when run was superseded", async () => {
    mockCompleteBatch.mockResolvedValue({
      connectorId: "conn-1",
      completedBatches: 3,
      totalBatches: 3,
      status: "failed",
      startedAt: RUN_STARTED_AT,
    });

    await handleBatchEmbedding({
      documentIds: ["doc-1"],
      connectorRunId: "run-1",
    });

    expect(mockUpdateConnector).not.toHaveBeenCalled();
  });

  test("propagates embedding errors", async () => {
    mockProcessDocuments.mockRejectedValue(new Error("Embedding failed"));

    await expect(
      handleBatchEmbedding({
        documentIds: ["doc-1"],
        connectorRunId: "run-1",
      }),
    ).rejects.toThrow("Embedding failed");

    expect(mockCompleteBatch).not.toHaveBeenCalled();
  });
});
