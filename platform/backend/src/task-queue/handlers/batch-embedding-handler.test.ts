import { vi } from "vitest";

const mockProcessDocuments = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ failedDocumentCount: 0, errorMessage: null }),
);
const mockEnqueuePermissionSync = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
vi.mock("@/knowledge-base", () => ({
  embeddingService: { processDocuments: mockProcessDocuments },
  enqueuePermissionSyncAfterContentSync: mockEnqueuePermissionSync,
}));

import { ConnectorRunModel, KnowledgeBaseConnectorModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { handleBatchEmbedding } from "./batch-embedding-handler";

describe("handleBatchEmbedding", () => {
  const OLD_DATE = new Date("2020-01-01T00:00:00.000Z");
  const RUN_STARTED_AT = new Date("2026-04-22T10:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessDocuments.mockResolvedValue({
      failedDocumentCount: 0,
      errorMessage: null,
    });
  });

  test("processes documents and completes a non-final batch", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    await KnowledgeBaseConnectorModel.update(connector.id, {
      lastSyncAt: OLD_DATE,
    });
    const run = await ConnectorRunModel.create({
      connectorId: connector.id,
      status: "running",
      startedAt: RUN_STARTED_AT,
      totalBatches: 3,
      completedBatches: 0,
    });

    await handleBatchEmbedding({
      documentIds: ["doc-1", "doc-2"],
      connectorRunId: run.id,
    });

    expect(mockProcessDocuments).toHaveBeenCalledWith(
      ["doc-1", "doc-2"],
      run.id,
    );
    // Batch advanced but the run is not finished, so the connector is untouched.
    const updatedRun = await ConnectorRunModel.findById(run.id);
    expect(updatedRun?.completedBatches).toBe(1);
    expect(updatedRun?.status).toBe("running");
    const updatedConnector = await KnowledgeBaseConnectorModel.findById(
      connector.id,
    );
    expect(updatedConnector?.lastSyncStatus).toBeNull();
  });

  test("finalizes connector when all batches are done", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    await KnowledgeBaseConnectorModel.update(connector.id, {
      lastSyncAt: OLD_DATE,
    });
    const run = await ConnectorRunModel.create({
      connectorId: connector.id,
      status: "running",
      startedAt: RUN_STARTED_AT,
      totalBatches: 3,
      completedBatches: 2,
    });

    await handleBatchEmbedding({
      documentIds: ["doc-1"],
      connectorRunId: run.id,
    });

    const updatedConnector = await KnowledgeBaseConnectorModel.findById(
      connector.id,
    );
    expect(updatedConnector?.lastSyncStatus).toBe("success");
    expect(updatedConnector?.lastSyncAt?.getTime()).toBeGreaterThan(
      OLD_DATE.getTime(),
    );
  });

  test("records the embedding failure cause on the connector run", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    mockProcessDocuments.mockResolvedValueOnce({
      failedDocumentCount: 2,
      errorMessage: "The embedding provider could not be reached.",
    });
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    const run = await ConnectorRunModel.create({
      connectorId: connector.id,
      status: "running",
      startedAt: RUN_STARTED_AT,
      totalBatches: 1,
      completedBatches: 0,
    });

    await handleBatchEmbedding({
      documentIds: ["doc-1", "doc-2"],
      connectorRunId: run.id,
    });

    // The failure count and cause are recorded on the run, and the terminal
    // status reflects the errors from this (final) batch.
    const updatedRun = await ConnectorRunModel.findById(run.id);
    expect(updatedRun?.itemErrors).toBe(2);
    expect(updatedRun?.error).toBe(
      "The embedding provider could not be reached.",
    );
    expect(updatedRun?.status).toBe("completed_with_errors");
  });

  test("skips connector update when a newer run has started", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const newerDate = new Date(RUN_STARTED_AT.getTime() + 60_000);
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    await KnowledgeBaseConnectorModel.update(connector.id, {
      lastSyncAt: newerDate,
    });
    const run = await ConnectorRunModel.create({
      connectorId: connector.id,
      status: "running",
      startedAt: RUN_STARTED_AT,
      totalBatches: 3,
      completedBatches: 2,
    });

    await handleBatchEmbedding({
      documentIds: ["doc-1"],
      connectorRunId: run.id,
    });

    // A newer run owns the connector status now, so this run must not touch it.
    const updatedConnector = await KnowledgeBaseConnectorModel.findById(
      connector.id,
    );
    expect(updatedConnector?.lastSyncStatus).toBeNull();
    expect(updatedConnector?.lastSyncAt?.getTime()).toBe(newerDate.getTime());
  });

  test("throws when documentIds is missing", async () => {
    await expect(
      handleBatchEmbedding({ connectorRunId: "run-1" }),
    ).rejects.toThrow("Missing documentIds in batch_embedding payload");
  });

  // connectorRunId is optional — some embedding paths embed documents directly
  test("processes documents without connectorRunId", async () => {
    const completeBatchSpy = vi.spyOn(ConnectorRunModel, "completeBatch");

    await handleBatchEmbedding({ documentIds: ["doc-1"] });

    expect(mockProcessDocuments).toHaveBeenCalledWith(["doc-1"], undefined);
    expect(completeBatchSpy).not.toHaveBeenCalled();
  });

  test("does not update connector status when run was superseded/failed", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    await KnowledgeBaseConnectorModel.update(connector.id, {
      lastSyncAt: OLD_DATE,
    });
    // A run already marked failed stays failed through completeBatch.
    const run = await ConnectorRunModel.create({
      connectorId: connector.id,
      status: "failed",
      startedAt: RUN_STARTED_AT,
      totalBatches: 3,
      completedBatches: 2,
    });

    await handleBatchEmbedding({
      documentIds: ["doc-1"],
      connectorRunId: run.id,
    });

    const updatedConnector = await KnowledgeBaseConnectorModel.findById(
      connector.id,
    );
    expect(updatedConnector?.lastSyncStatus).toBeNull();
  });

  test("propagates embedding errors and does not complete the batch", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    mockProcessDocuments.mockRejectedValue(new Error("Embedding failed"));
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    const run = await ConnectorRunModel.create({
      connectorId: connector.id,
      status: "running",
      startedAt: RUN_STARTED_AT,
      totalBatches: 3,
      completedBatches: 0,
    });

    await expect(
      handleBatchEmbedding({
        documentIds: ["doc-1"],
        connectorRunId: run.id,
      }),
    ).rejects.toThrow("Embedding failed");

    const updatedRun = await ConnectorRunModel.findById(run.id);
    expect(updatedRun?.completedBatches).toBe(0);
  });
});
