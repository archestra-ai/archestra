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
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { handleBatchAnalysisRow } from "@/task-queue/handlers/batch-analysis-row-handler";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { generateTaggedText } from "@/utils/generate-tagged-text";

const columns = [
  { key: "topic", name: "Topic", prompt: "What is it about?", format: "text" },
  {
    key: "risk",
    name: "Risk",
    prompt: "How risky is this?",
    format: "text",
    flag: true,
  },
];

describe("cell verification", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
  let agentId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeAgent }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser({ email: "reviewer@example.com" });
    const agent = await makeAgent({ organizationId });
    agentId = agent.id;

    vi.mocked(generateTaggedText).mockResolvedValue(
      JSON.stringify({
        topic: { value: "renewals", quote: "renewals are annual" },
        risk: { value: "high churn risk", quote: null, flag: "red" },
      }),
    );

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });
    registerAuditLogHook(app);
    const { default: batchAnalysisRoutes } = await import(
      "./batch-analysis.routes"
    );
    await app.register(batchAnalysisRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function createAnalysisWithDoneCells() {
    const created = await app.inject({
      method: "POST",
      url: "/api/batch-analyses",
      payload: { name: "Vendor review", agentId, columns },
    });
    expect(created.statusCode).toBe(200);
    const analysisId = created.json().id;

    const added = await app.inject({
      method: "POST",
      url: `/api/batch-analyses/${analysisId}/rows`,
      payload: {
        rows: [
          {
            label: "Doc A",
            source: { type: "inline_text", text: "renewals are annual" },
          },
        ],
      },
    });
    const rowId = added.json().rows[0].id;

    const run = await app.inject({
      method: "POST",
      url: `/api/batch-analyses/${analysisId}/runs`,
      payload: {},
    });
    expect(run.statusCode).toBe(200);
    await drainQueue();
    return { analysisId, rowId };
  }

  async function drainQueue() {
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
  }

  const settleAuditWrites = () =>
    new Promise((resolve) => setTimeout(resolve, 50));

  test("verifies and unverifies done cells, stamping the reviewer", async () => {
    const { analysisId, rowId } = await createAnalysisWithDoneCells();

    const verified = await app.inject({
      method: "PATCH",
      url: `/api/batch-analyses/${analysisId}/cells/verification`,
      payload: {
        entries: [{ rowId, columnKey: "topic", verified: true }],
      },
    });
    expect(verified.statusCode).toBe(200);
    const [cell] = verified.json().cells;
    expect(cell.verifiedBy).toBe(user.id);
    expect(cell.verifiedAt).not.toBeNull();

    // The detail response resolves the reviewer to a display name.
    const detail = await app.inject({
      method: "GET",
      url: `/api/batch-analyses/${analysisId}`,
    });
    const detailCell = detail
      .json()
      .cells.find(
        (c: { columnKey: string }) => c.columnKey === "topic",
      );
    expect(detailCell.verifiedByName).toBe(user.name);

    const unverified = await app.inject({
      method: "PATCH",
      url: `/api/batch-analyses/${analysisId}/cells/verification`,
      payload: {
        entries: [{ rowId, columnKey: "topic", verified: false }],
      },
    });
    expect(unverified.json().cells[0].verifiedBy).toBeNull();
    expect(unverified.json().cells[0].verifiedAt).toBeNull();
  });

  test("refuses to verify a cell without a completed answer, mutating nothing", async () => {
    const { analysisId, rowId } = await createAnalysisWithDoneCells();
    // Reset one cell back to pending via retry, then try to verify BOTH cells
    // in one request: the pending one must fail the whole batch.
    await app.inject({
      method: "POST",
      url: `/api/batch-analyses/${analysisId}/rows/${rowId}/cells/risk/retry`,
      payload: {},
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/batch-analyses/${analysisId}/cells/verification`,
      payload: {
        entries: [
          { rowId, columnKey: "topic", verified: true },
          { rowId, columnKey: "risk", verified: true },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("risk");

    // All-or-nothing: the valid entry must not have been applied.
    const detail = await app.inject({
      method: "GET",
      url: `/api/batch-analyses/${analysisId}`,
    });
    for (const cell of detail.json().cells) {
      expect(cell.verifiedAt).toBeNull();
    }
  });

  test("refuses cells belonging to another analysis", async () => {
    const { analysisId } = await createAnalysisWithDoneCells();
    const other = await createAnalysisWithDoneCells();
    const otherRow = other.rowId;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/batch-analyses/${analysisId}/cells/verification`,
      payload: {
        entries: [{ rowId: otherRow, columnKey: "topic", verified: true }],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  test("regeneration clears verification and the triage flag", async () => {
    const { analysisId, rowId } = await createAnalysisWithDoneCells();
    await app.inject({
      method: "PATCH",
      url: `/api/batch-analyses/${analysisId}/cells/verification`,
      payload: { entries: [{ rowId, columnKey: "risk", verified: true }] },
    });

    // Retry resets the cell to pending — sign-off and flag must go with it.
    await app.inject({
      method: "POST",
      url: `/api/batch-analyses/${analysisId}/rows/${rowId}/cells/risk/retry`,
      payload: {},
    });
    const detail = await app.inject({
      method: "GET",
      url: `/api/batch-analyses/${analysisId}`,
    });
    const cell = detail
      .json()
      .cells.find((c: { columnKey: string }) => c.columnKey === "risk");
    expect(cell.status).toBe("pending");
    expect(cell.verifiedAt).toBeNull();
    expect(cell.flag).toBeNull();
  });

  test("stores the model's triage flag only for opted-in columns", async () => {
    const { analysisId } = await createAnalysisWithDoneCells();
    const detail = await app.inject({
      method: "GET",
      url: `/api/batch-analyses/${analysisId}`,
    });
    const cells = detail.json().cells;
    const risk = cells.find(
      (c: { columnKey: string }) => c.columnKey === "risk",
    );
    const topic = cells.find(
      (c: { columnKey: string }) => c.columnKey === "topic",
    );
    expect(risk.flag).toBe("red");
    // `topic` did not opt in; a volunteered flag would be discarded.
    expect(topic.flag).toBeNull();
  });

  test("audits verification with a digest that moves even when counts do not", async () => {
    const { analysisId, rowId } = await createAnalysisWithDoneCells();
    await app.inject({
      method: "PATCH",
      url: `/api/batch-analyses/${analysisId}/cells/verification`,
      payload: { entries: [{ rowId, columnKey: "topic", verified: true }] },
    });
    // Count-neutral mutation: unverify topic, verify risk in one request.
    await app.inject({
      method: "PATCH",
      url: `/api/batch-analyses/${analysisId}/cells/verification`,
      payload: {
        entries: [
          { rowId, columnKey: "topic", verified: false },
          { rowId, columnKey: "risk", verified: true },
        ],
      },
    });
    await settleAuditWrites();

    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceType: "batchAnalysis",
      sortDirection: "desc",
      limit: 10,
      offset: 0,
    });
    const verificationRecords = data.filter(
      (record) =>
        record.action === "batchAnalysis.updated" &&
        record.after !== null &&
        "verificationDigest" in (record.after as Record<string, unknown>),
    );
    expect(verificationRecords.length).toBeGreaterThanOrEqual(2);
    const [second, first] = verificationRecords;
    expect(second.resourceId).toBe(analysisId);
    // Both mutations verified one cell in total, but the digests differ —
    // the audit trail distinguishes count-neutral changes.
    expect(
      (second.after as Record<string, unknown>).verificationDigest,
    ).not.toBe((first.after as Record<string, unknown>).verificationDigest);
    expect(
      (second.after as Record<string, unknown>).verificationDigest,
    ).not.toBe((second.before as Record<string, unknown>)?.verificationDigest);
  });
});
