import { beforeEach, describe, expect, test, vi } from "vitest";

const mockProcessDocuments = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
vi.mock("@/knowledge-base", () => ({
  embeddingService: { processDocuments: mockProcessDocuments },
}));

const mockCompleteBatch = vi.hoisted(() => vi.fn());
const mockUpdateConnector = vi.hoisted(() => vi.fn());
vi.mock("@/models", () => ({
  ConnectorRunModel: { completeBatch: mockCompleteBatch },
  KnowledgeBaseConnectorModel: { update: mockUpdateConnector },
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessDocuments.mockResolvedValue(undefined);
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

    expect(mockProcessDocuments).toHaveBeenCalledWith(["doc-1", "doc-2"]);
    expect(mockCompleteBatch).toHaveBeenCalledWith("run-1");
    expect(mockUpdateConnector).not.toHaveBeenCalled();
  });

  test("finalizes connector when all batches are done", async () => {
    mockCompleteBatch.mockResolvedValue({
      connectorId: "conn-1",
      completedBatches: 3,
      totalBatches: 3,
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
