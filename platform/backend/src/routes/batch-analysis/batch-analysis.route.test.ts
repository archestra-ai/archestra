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
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { handleBatchAnalysisRow } from "@/task-queue/handlers/batch-analysis-row-handler";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { generateTaggedText } from "@/utils/generate-tagged-text";

const columns = [
  { key: "topic", name: "Topic", prompt: "What is it about?", format: "text" },
  { key: "urgent", name: "Urgent", prompt: "Is it urgent?", format: "boolean" },
];

describe("batch analysis routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
  let agentId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeAgent }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    const agent = await makeAgent({ organizationId });
    agentId = agent.id;

    vi.mocked(generateTaggedText).mockResolvedValue(
      JSON.stringify({
        topic: { value: "renewals", quote: null },
        urgent: { value: "no", quote: null },
      }),
    );

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: batchAnalysisRoutes } = await import(
      "./batch-analysis.routes"
    );
    await app.register(batchAnalysisRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function createAnalysis() {
    const response = await app.inject({
      method: "POST",
      url: "/api/batch-analyses",
      payload: { name: "Vendor review", agentId, columns },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  async function addRows(analysisId: string, texts: string[]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/batch-analyses/${analysisId}/rows`,
      payload: {
        rows: texts.map((text, index) => ({
          label: `Row ${index}`,
          source: { type: "inline_text", text },
        })),
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json().rows;
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

  test("creates an analysis, adds rows, runs it, and returns the grid", async () => {
    const analysis = await createAnalysis();
    expect(analysis.name).toBe("Vendor review");
    expect(analysis.columns).toHaveLength(2);

    await addRows(analysis.id, ["Alpha body", "Beta body"]);

    const started = await app.inject({
      method: "POST",
      url: `/api/batch-analyses/${analysis.id}/runs`,
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().status).toBe("running");
    expect(started.json().totalCells).toBe(4);

    await drainQueue();

    const detail = await app.inject({
      method: "GET",
      url: `/api/batch-analyses/${analysis.id}`,
    });
    expect(detail.statusCode).toBe(200);

    const body = detail.json();
    expect(body.rows).toHaveLength(2);
    expect(body.cells).toHaveLength(4);
    expect(
      body.cells.every((cell: { status: string }) => cell.status === "done"),
    ).toBe(true);
    expect(body.latestRun.status).toBe("success");
  });

  test("lists analyses for the organization", async () => {
    await createAnalysis();

    const response = await app.inject({
      method: "GET",
      url: "/api/batch-analyses?limit=10&offset=0",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().pagination.total).toBe(1);
  });

  test("rejects an agent from another organization", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const otherOrg = await makeOrganization();
    const foreignAgent = await makeAgent({ organizationId: otherOrg.id });

    const response = await app.inject({
      method: "POST",
      url: "/api/batch-analyses",
      payload: { name: "Nope", agentId: foreignAgent.id, columns },
    });

    // The agent decides which model and credential a run spends against, so
    // borrowing one across a tenant boundary must not be possible.
    expect(response.statusCode).toBe(404);
  });

  test("rejects duplicate column keys", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/batch-analyses",
      payload: {
        name: "Dupes",
        agentId,
        columns: [columns[0], { ...columns[0], name: "Copy" }],
      },
    });

    // Cells are keyed by (row, column key); duplicates would collide on the
    // unique index and silently drop a column's results.
    expect(response.statusCode).toBe(400);
  });

  test("refuses a second concurrent run", async () => {
    const analysis = await createAnalysis();
    await addRows(analysis.id, ["Alpha body"]);

    const first = await app.inject({
      method: "POST",
      url: `/api/batch-analyses/${analysis.id}/runs`,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/api/batch-analyses/${analysis.id}/runs`,
    });
    expect(second.statusCode).toBe(409);
  });

  test("retries a single cell without disturbing its neighbours", async () => {
    const analysis = await createAnalysis();
    const rows = await addRows(analysis.id, ["Alpha body"]);

    await app.inject({
      method: "POST",
      url: `/api/batch-analyses/${analysis.id}/runs`,
    });
    await drainQueue();

    vi.mocked(generateTaggedText).mockResolvedValue(
      JSON.stringify({ topic: { value: "revised", quote: null } }),
    );

    const retry = await app.inject({
      method: "POST",
      url: `/api/batch-analyses/${analysis.id}/rows/${rows[0].id}/cells/topic/retry`,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().totalCells).toBe(1);

    await drainQueue();

    const detail = await app.inject({
      method: "GET",
      url: `/api/batch-analyses/${analysis.id}`,
    });
    const cells: Array<{ columnKey: string; content: string }> =
      detail.json().cells;
    expect(cells.find((c) => c.columnKey === "topic")?.content).toBe("revised");
    expect(cells.find((c) => c.columnKey === "urgent")?.content).toBe("no");
  });

  test("does not expose an analysis from another organization", async () => {
    const analysis = await createAnalysis();

    // Re-register the app under a different tenant.
    await app.close();
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = "some-other-org";
      (request as typeof request & { user: User }).user = user;
    });
    const { default: routes } = await import("./batch-analysis.routes");
    await app.register(routes);

    const response = await app.inject({
      method: "GET",
      url: `/api/batch-analyses/${analysis.id}`,
    });
    expect(response.statusCode).toBe(404);
  });
});
