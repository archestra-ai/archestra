import { eq } from "drizzle-orm";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import ConnectorRunModel from "@/models/connector-run";
import KnowledgeBaseConnectorModel from "@/models/knowledge-base-connector";
import TaskModel from "@/models/task";
import { TaskQueueService } from "@/task-queue/task-queue";
import { expect, test } from "@/test";

test("a terminal embedding failure finalizes its connector before the task becomes dead", async ({
  makeOrganization,
  makeKnowledgeBase,
  makeKnowledgeBaseConnector,
}) => {
  const org = await makeOrganization();
  const kb = await makeKnowledgeBase(org.id);
  const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
  const run = await ConnectorRunModel.create({
    connectorId: connector.id,
    status: "running",
    startedAt: new Date(),
    totalBatches: 1,
    completedBatches: 0,
  });
  const task = await TaskModel.create({
    taskType: "batch_embedding",
    payload: { connectorRunId: run.id, documentIds: ["doc-1", "doc-2"] },
    maxAttempts: 1,
    scheduledFor: new Date(Date.now() - 60_000),
  });
  const worker = new TaskQueueService();
  const failBatch = vi.fn(async () => {
    throw new Error("embedding provider offline");
  });
  worker.registerHandler("batch_embedding", failBatch);
  config.kb.taskWorkerPollIntervalSeconds = 1;
  vi.useFakeTimers();
  try {
    worker.startWorker();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(failBatch).toHaveBeenCalledOnce());
    await worker.stopWorker();

    const [stored] = await db
      .select()
      .from(schema.tasksTable)
      .where(eq(schema.tasksTable.id, task.id));
    expect(stored?.status).toBe("dead");

    expect(await ConnectorRunModel.findById(run.id)).toMatchObject({
      status: "completed_with_errors",
      completedBatches: 1,
      itemErrors: 2,
      error: "embedding provider offline",
    });
    expect(
      await KnowledgeBaseConnectorModel.findById(connector.id),
    ).toMatchObject({ lastSyncStatus: "completed_with_errors" });
  } finally {
    await worker.stopWorker();
    vi.useRealTimers();
  }
});
