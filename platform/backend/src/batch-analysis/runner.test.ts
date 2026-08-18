import { vi } from "vitest";

vi.mock("@/utils/generate-tagged-text", () => ({
  generateTaggedText: vi.fn(),
}));
vi.mock("@/clients/llm-client", () => ({
  createLLMModel: vi.fn(() => ({})),
  isApiKeyRequired: vi.fn(() => false),
}));
vi.mock("@/utils/llm-resolution", () => ({
  resolveAgentLlmOrDefault: vi.fn(async () => ({
    provider: "anthropic",
    modelName: "claude-test",
    apiKey: "test-key",
    baseUrl: null,
    chatApiKeyId: "key-row-1",
  })),
}));

import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { BatchAnalysisModel } from "@/models";
import { handleBatchAnalysisRow } from "@/task-queue/handlers/batch-analysis-row-handler";
import { beforeEach, describe, expect, test } from "@/test";
import {
  type BatchAnalysis,
  type BatchAnalysisColumn,
  TASK_LANES,
} from "@/types";
import { generateTaggedText } from "@/utils/generate-tagged-text";
import { retryBatchAnalysisCell, startBatchAnalysisRun } from "./runner";

const columns: BatchAnalysisColumn[] = [
  { key: "topic", name: "Topic", prompt: "What is it about?", format: "text" },
  { key: "urgent", name: "Urgent", prompt: "Is it urgent?", format: "boolean" },
];

/** Answer whatever the prompt asked for, so resume behaviour is observable. */
function answerRequestedColumns() {
  vi.mocked(generateTaggedText).mockImplementation(async ({ prompt }) => {
    const answers: Record<string, { value: string; quote: null }> = {};
    for (const column of columns) {
      if (prompt.includes(`key: ${column.key}`)) {
        answers[column.key] = { value: `${column.key}-answer`, quote: null };
      }
    }
    return JSON.stringify(answers);
  });
}

/** Drain every queued batch_analysis_row task, as the worker would. */
async function drainQueue(): Promise<number> {
  const tasks = await db
    .select()
    .from(schema.tasksTable)
    .where(eq(schema.tasksTable.taskType, "batch_analysis_row"));

  for (const task of tasks) {
    await handleBatchAnalysisRow(task.payload as Record<string, unknown>);
  }
  await db
    .delete(schema.tasksTable)
    .where(eq(schema.tasksTable.taskType, "batch_analysis_row"));
  return tasks.length;
}

async function cellsFor(analysisId: string) {
  const rows = await BatchAnalysisModel.findRows(analysisId);
  const cells = await BatchAnalysisModel.findCellsByRows(
    rows.map((row) => row.id),
  );
  return { rows, cells };
}

describe("batch analysis runner", () => {
  let analysis: BatchAnalysis;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeAgent }) => {
    answerRequestedColumns();

    const org = await makeOrganization();
    organizationId = org.id;
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });

    analysis = await BatchAnalysisModel.create({
      organizationId: org.id,
      name: "Test analysis",
      agentId: agent.id,
      columns,
      createdBy: user.id,
    });

    await BatchAnalysisModel.addRows(analysis.id, [
      {
        label: "Row A",
        source: { type: "inline_text", text: "Alpha document body" },
        sortIndex: 0,
      },
      {
        label: "Row B",
        source: { type: "inline_text", text: "Beta document body" },
        sortIndex: 1,
      },
    ]);
  });

  test("lane wiring keeps analysis work off the content lane", () => {
    // The whole point of the separate lane: a large embedding backlog must not
    // stall an interactive run, and vice versa.
    expect(TASK_LANES.analysis).toContain("batch_analysis_row");
    expect(TASK_LANES.content).not.toContain("batch_analysis_row");
  });

  test("runs every cell and finalizes the run", async () => {
    const run = await startBatchAnalysisRun({
      analysisId: analysis.id,
      organizationId,
    });

    expect(run.status).toBe("running");
    expect(run.totalRows).toBe(2);
    expect(run.totalCells).toBe(4);

    const dispatched = await drainQueue();
    // One task per row, not per cell.
    expect(dispatched).toBe(2);
    expect(generateTaggedText).toHaveBeenCalledTimes(2);

    const finished = await BatchAnalysisModel.findRunById(run.id);
    expect(finished?.status).toBe("success");
    expect(finished?.completedRows).toBe(2);
    expect(finished?.doneCells).toBe(4);
    expect(finished?.erroredCells).toBe(0);
    expect(finished?.completedAt).not.toBeNull();

    const { cells } = await cellsFor(analysis.id);
    expect(cells).toHaveLength(4);
    expect(cells.every((cell) => cell.status === "done")).toBe(true);
    expect(
      cells.filter((cell) => cell.content === "topic-answer"),
    ).toHaveLength(2);
  });

  test("the run stays running until the last row lands", async () => {
    const run = await startBatchAnalysisRun({
      analysisId: analysis.id,
      organizationId,
    });

    const tasks = await db
      .select()
      .from(schema.tasksTable)
      .where(eq(schema.tasksTable.taskType, "batch_analysis_row"));

    await handleBatchAnalysisRow(tasks[0].payload as Record<string, unknown>);
    const midway = await BatchAnalysisModel.findRunById(run.id);
    expect(midway?.status).toBe("running");
    expect(midway?.completedRows).toBe(1);

    await handleBatchAnalysisRow(tasks[1].payload as Record<string, unknown>);
    const done = await BatchAnalysisModel.findRunById(run.id);
    // Last child finalizes the parent — no separate sweeper needed.
    expect(done?.status).toBe("success");
  });

  test("resuming skips cells that are already done", async () => {
    await startBatchAnalysisRun({ analysisId: analysis.id, organizationId });
    await drainQueue();
    vi.mocked(generateTaggedText).mockClear();

    // Knock out one cell, as a transient provider failure would have.
    const { rows } = await cellsFor(analysis.id);
    await BatchAnalysisModel.writeCellError({
      rowId: rows[0].id,
      columnKeys: ["urgent"],
      error: "transient failure",
    });

    const second = await startBatchAnalysisRun({
      analysisId: analysis.id,
      organizationId,
    });

    // Only the affected row is dispatched, and only its unfinished column.
    expect(second.totalRows).toBe(1);
    expect(second.totalCells).toBe(1);

    const dispatched = await drainQueue();
    expect(dispatched).toBe(1);
    expect(generateTaggedText).toHaveBeenCalledTimes(1);

    const prompt = vi.mocked(generateTaggedText).mock.calls[0][0].prompt;
    expect(prompt).toContain("key: urgent");
    // Re-asking a finished question would double-bill the user for an answer
    // already on the grid.
    expect(prompt).not.toContain("key: topic");

    const { cells } = await cellsFor(analysis.id);
    expect(cells.every((cell) => cell.status === "done")).toBe(true);
    expect((await BatchAnalysisModel.findRunById(second.id))?.status).toBe(
      "success",
    );
  });

  test("a duplicate dispatch of the same row generates nothing twice", async () => {
    // A task queue guarantees at-least-once delivery, so the same row can be
    // handed to two workers. Claiming is what stops both from calling the model
    // for the same cells — double spend, and two writers racing one result.
    const run = await startBatchAnalysisRun({
      analysisId: analysis.id,
      organizationId,
    });
    const { rows } = await cellsFor(analysis.id);
    const rowId = rows[0].id;
    const columnKeys = analysis.columns.map((column) => column.key);

    const first = await BatchAnalysisModel.claimCellsForGeneration({
      rowId,
      columnKeys,
    });
    const second = await BatchAnalysisModel.claimCellsForGeneration({
      rowId,
      columnKeys,
    });

    expect(first.sort()).toEqual([...columnKeys].sort());
    // The second worker wins nothing: every cell is already in flight.
    expect(second).toEqual([]);
    expect(run.id).toBeDefined();
  });

  test("a single cell can be retried on its own", async () => {
    await startBatchAnalysisRun({ analysisId: analysis.id, organizationId });
    await drainQueue();
    vi.mocked(generateTaggedText).mockClear();

    const { rows } = await cellsFor(analysis.id);
    vi.mocked(generateTaggedText).mockResolvedValue(
      JSON.stringify({ topic: { value: "revised-answer", quote: null } }),
    );

    const run = await retryBatchAnalysisCell({
      analysisId: analysis.id,
      organizationId,
      rowId: rows[1].id,
      columnKey: "topic",
    });

    expect(run.totalCells).toBe(1);
    await drainQueue();

    expect(generateTaggedText).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(generateTaggedText).mock.calls[0][0].prompt;
    expect(prompt).toContain("key: topic");
    expect(prompt).not.toContain("key: urgent");

    const { cells } = await cellsFor(analysis.id);
    const retried = cells.find(
      (cell) => cell.rowId === rows[1].id && cell.columnKey === "topic",
    );
    const untouched = cells.find(
      (cell) => cell.rowId === rows[0].id && cell.columnKey === "topic",
    );
    expect(retried?.content).toBe("revised-answer");
    // The neighbours are genuinely untouched, which is what makes a grid safe
    // to poke at cell by cell.
    expect(untouched?.content).toBe("topic-answer");
  });

  test("records per-cell failures and completes with errors", async () => {
    vi.mocked(generateTaggedText).mockResolvedValue("this is not json");

    const run = await startBatchAnalysisRun({
      analysisId: analysis.id,
      organizationId,
    });
    await drainQueue();

    const finished = await BatchAnalysisModel.findRunById(run.id);
    // A run whose model misbehaved must still reach a terminal state, or the
    // grid shows a spinner forever.
    expect(finished?.status).toBe("completed_with_errors");
    expect(finished?.completedRows).toBe(2);
    expect(finished?.erroredCells).toBe(4);
    expect(finished?.doneCells).toBe(0);

    const { cells } = await cellsFor(analysis.id);
    expect(cells.every((cell) => cell.status === "error")).toBe(true);
    expect(cells[0].error).toContain("JSON");
  });

  test("a cancelled run drops its outstanding work", async () => {
    const run = await startBatchAnalysisRun({
      analysisId: analysis.id,
      organizationId,
    });
    await BatchAnalysisModel.cancelRun(run.id);

    await drainQueue();

    expect(generateTaggedText).not.toHaveBeenCalled();
    const after = await BatchAnalysisModel.findRunById(run.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.completedRows).toBe(0);

    const { cells } = await cellsFor(analysis.id);
    expect(cells.every((cell) => cell.status === "pending")).toBe(true);
  });

  test("re-running a finished analysis records a completed run with nothing to do", async () => {
    await startBatchAnalysisRun({ analysisId: analysis.id, organizationId });
    await drainQueue();
    vi.mocked(generateTaggedText).mockClear();

    const second = await startBatchAnalysisRun({
      analysisId: analysis.id,
      organizationId,
    });

    expect(second.totalRows).toBe(0);
    expect(await drainQueue()).toBe(0);
    expect(generateTaggedText).not.toHaveBeenCalled();

    const settled = await BatchAnalysisModel.findRunById(second.id);
    expect(settled?.status).toBe("success");
    expect(settled?.completedAt).not.toBeNull();
  });

  test("refuses a second concurrent run", async () => {
    await startBatchAnalysisRun({ analysisId: analysis.id, organizationId });

    await expect(
      startBatchAnalysisRun({ analysisId: analysis.id, organizationId }),
    ).rejects.toThrow(/already in progress/);
  });

  test("refuses to run an analysis from another organization", async ({
    makeOrganization,
  }) => {
    const other = await makeOrganization();

    await expect(
      startBatchAnalysisRun({
        analysisId: analysis.id,
        organizationId: other.id,
      }),
    ).rejects.toThrow(/not found/);
  });

  test("refuses an analysis with no rows", async ({ makeAgent, makeUser }) => {
    const user = await makeUser();
    const agent = await makeAgent({ organizationId });
    const empty = await BatchAnalysisModel.create({
      organizationId,
      name: "Empty",
      agentId: agent.id,
      columns,
      createdBy: user.id,
    });

    await expect(
      startBatchAnalysisRun({ analysisId: empty.id, organizationId }),
    ).rejects.toThrow(/no rows/);
  });

  test("skips a row whose run vanished, without writing cells", async () => {
    const run = await startBatchAnalysisRun({
      analysisId: analysis.id,
      organizationId,
    });
    const { rows } = await cellsFor(analysis.id);

    await db
      .delete(schema.batchAnalysisRunsTable)
      .where(eq(schema.batchAnalysisRunsTable.id, run.id));

    await handleBatchAnalysisRow({ runId: run.id, rowId: rows[0].id });

    expect(generateTaggedText).not.toHaveBeenCalled();
    const { cells } = await cellsFor(analysis.id);
    expect(cells.every((cell) => cell.status === "pending")).toBe(true);
  });

  test("rejects a payload missing its identifiers", async () => {
    await expect(handleBatchAnalysisRow({})).rejects.toThrow(/Missing/);
  });
});
