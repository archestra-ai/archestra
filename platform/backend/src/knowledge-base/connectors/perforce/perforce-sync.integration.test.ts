import { vi } from "vitest";

// End-to-end pipeline test for the Perforce connector: the REAL
// PerforceConnector, sync service, chunker, embedding service, task records,
// and database run together. Mocked: the HTTP boundary to the P4 REST API
// (global fetch) and the embedding provider (the openai client plus the
// org-level embedding-config lookup — the latter is internal but resolves
// external provider credentials; mocking it follows embedder.test.ts).

const fetchState: {
  handler: undefined | ((url: URL) => Response);
} = { handler: undefined };

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (!fetchState.handler) {
      throw new Error("fetchState.handler not configured in test");
    }
    return fetchState.handler(url);
  }),
);

const mockEmbeddingsCreate = vi.hoisted(() => vi.fn());
vi.mock("openai", () => {
  class MockOpenAI {
    static APIError = class APIError extends Error {
      status: number;
      constructor(status: number, message: string) {
        super(message);
        this.status = status;
      }
    };
    embeddings = { create: mockEmbeddingsCreate };
  }
  return { default: MockOpenAI };
});

const mockGetDefaultOrgEmbeddingConfig = vi.hoisted(() => vi.fn());
vi.mock("@/knowledge-base/kb-llm-client", () => ({
  getDefaultOrgEmbeddingConfig: mockGetDefaultOrgEmbeddingConfig,
}));

import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { connectorSyncService } from "@/knowledge-base/connector-sync";
import {
  ConnectorRunModel,
  KbChunkModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
} from "@/models";
import { handleBatchEmbedding } from "@/task-queue/handlers/batch-embedding-handler";
import { beforeEach, describe, expect, test } from "@/test";

function jsonl(records: Array<Record<string, unknown>>): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

interface FakeDepotFile {
  depotFile: string;
  content: string;
  change: number;
  type?: string;
}

/**
 * Simulate the P4 REST API: the newest-revision probe (sort=date) reports the
 * depot head, `/v0/file/revisions` lists files matching the extension
 * filespecs (honoring `@from,@to` changelist windows), and
 * `/v0/file/contents` serves content.
 */
function fakeDepot(state: { headChange: number; files: FakeDepotFile[] }) {
  fetchState.handler = (url) => {
    if (url.pathname === "/api/v0/file/revisions") {
      if (url.searchParams.get("sort") === "date") {
        return new Response(
          jsonl([
            {
              depotFile: "//depot/docs/newest.md",
              headRev: "1",
              headChange: String(state.headChange),
              headAction: "edit",
              headType: "text",
              headTime: "2023-11-14T22:13:20.000Z",
            },
          ]),
          { status: 200 },
        );
      }
      const specs = url.searchParams.getAll("fileSpec");
      const matched = state.files.filter((file) =>
        specs.some((spec) => {
          const atIndex = spec.indexOf("@");
          const pathPart = atIndex === -1 ? spec : spec.slice(0, atIndex);
          const revPart = atIndex === -1 ? "" : spec.slice(atIndex + 1);
          const extension = pathPart.slice(pathPart.indexOf("/...") + 4);
          if (!file.depotFile.endsWith(extension)) return false;
          if (revPart.includes(",")) {
            const [from, to] = revPart
              .split(",")
              .map((rev) => Number(rev.replace("@", "")));
            return file.change >= from && file.change <= to;
          }
          return true;
        }),
      );
      if (matched.length === 0) {
        return new Response(
          JSON.stringify({
            errors: [{ message: "... - no such file(s).", statusCode: 404 }],
          }),
          { status: 404 },
        );
      }
      return new Response(
        jsonl(
          matched.map((file) => ({
            depotFile: file.depotFile,
            headRev: "1",
            headChange: String(file.change),
            headAction: "edit",
            headType: file.type ?? "text",
          })),
        ),
        { status: 200 },
      );
    }
    if (url.pathname === "/api/v0/file/contents") {
      const filespec = url.searchParams.get("fileSpec") ?? "";
      const depotFile = filespec.split("@")[0];
      const file = state.files.find((f) => f.depotFile === depotFile);
      if (!file) throw new Error(`fake depot has no file ${depotFile}`);
      return new Response(file.content, { status: 200 });
    }
    throw new Error(`Unexpected P4 REST API request: ${url.pathname}`);
  };
}

async function createPerforceConnector(params: {
  makeOrganization: () => Promise<{ id: string }>;
  makeKnowledgeBase: (orgId: string) => Promise<{ id: string }>;
  makeKnowledgeBaseConnector: (
    kbId: string,
    orgId: string,
    overrides: Record<string, unknown>,
  ) => Promise<{ id: string }>;
}) {
  const org = await params.makeOrganization();
  const kb = await params.makeKnowledgeBase(org.id);
  const connector = await params.makeKnowledgeBaseConnector(kb.id, org.id, {
    connectorType: "perforce",
    config: {
      type: "perforce",
      serverUrl: "https://perforce.example.com:8080",
      depotPaths: ["//depot/docs"],
    },
  });
  const [secret] = await db
    .insert(schema.secretsTable)
    .values({ secret: { email: "svc-knowledge", apiToken: "ticket-123" } })
    .returning();
  await KnowledgeBaseConnectorModel.update(connector.id, {
    secretId: secret.id,
  });
  return connector;
}

async function findDocumentsByConnector(connectorId: string) {
  return db
    .select()
    .from(schema.kbDocumentsTable)
    .where(eq(schema.kbDocumentsTable.connectorId, connectorId));
}

/**
 * Align connector.lastSyncAt with the run's startedAt before finalization.
 * handleBatchEmbedding's "newer run has started" guard compares the two, and
 * executeSync writes its optimistic lastSyncAt a few milliseconds after
 * creating the run row — under load that drift makes the guard skip the
 * connector-status update (pre-existing upstream behavior, unrelated to this
 * connector). Pinning the timestamps keeps finalization deterministic here.
 */
async function alignRunTimestamps(connectorId: string, runId: string) {
  const run = await ConnectorRunModel.findById(runId);
  await KnowledgeBaseConnectorModel.update(connectorId, {
    lastSyncAt: run?.startedAt,
  });
}

/** Run every queued batch_embedding task, as the task worker would. */
async function drainEmbeddingTasks(): Promise<number> {
  const tasks = await db
    .select()
    .from(schema.tasksTable)
    .where(
      and(
        eq(schema.tasksTable.taskType, "batch_embedding"),
        eq(schema.tasksTable.status, "pending"),
      ),
    );
  for (const task of tasks) {
    await handleBatchEmbedding(task.payload as Record<string, unknown>);
    await db
      .update(schema.tasksTable)
      .set({ status: "completed" })
      .where(eq(schema.tasksTable.id, task.id));
  }
  return tasks.length;
}

describe("Perforce connector end-to-end sync", () => {
  beforeEach(() => {
    fetchState.handler = undefined;
    vi.clearAllMocks();

    mockGetDefaultOrgEmbeddingConfig.mockResolvedValue({
      organizationId: "org-embedding",
      config: {
        apiKey: "test-key",
        baseUrl: null,
        model: "text-embedding-3-small",
        dimensions: 1536,
        provider: "openai",
        inputModalities: null,
      },
    });
    mockEmbeddingsCreate.mockImplementation(
      async ({ input }: { input: string[] }) => ({
        object: "list",
        data: input.map((_, index) => ({
          object: "embedding",
          embedding: Array.from({ length: 1536 }, (_, i) => (index + i) * 1e-4),
          index,
        })),
        model: "text-embedding-3-small",
        usage: { prompt_tokens: 0, total_tokens: 0 },
      }),
    );
  });

  test("ingests and embeds depot files, then syncs only incremental changes", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const connector = await createPerforceConnector({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    });

    fakeDepot({
      headChange: 120,
      files: [
        {
          depotFile: "//depot/docs/guide.md",
          content: "# Guide\n\nHow to deploy the service.\n",
          change: 100,
        },
        {
          depotFile: "//depot/docs/pipeline.yaml",
          content: "stages:\n  - build\n  - test\n",
          change: 110,
        },
      ],
    });

    // --- Initial full sync ---
    const result = await connectorSyncService.executeSync(connector.id);
    expect(result.status).toBe("success");

    const documents = await findDocumentsByConnector(connector.id);
    expect(documents.map((doc) => doc.sourceId).sort()).toEqual([
      "//depot/docs/guide.md",
      "//depot/docs/pipeline.yaml",
    ]);
    const guide = documents.find(
      (doc) => doc.sourceId === "//depot/docs/guide.md",
    );
    expect(guide?.content).toBe("# Guide\n\nHow to deploy the service.\n");
    expect(guide?.embeddingStatus).toBe("pending");

    // --- Embedding (as the task worker would run it) ---
    await alignRunTimestamps(connector.id, result.runId);
    expect(await drainEmbeddingTasks()).toBeGreaterThan(0);

    for (const document of documents) {
      const embedded = await KbDocumentModel.findById(document.id);
      expect(embedded?.embeddingStatus).toBe("completed");
      const chunks = await KbChunkModel.findByDocument(document.id);
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(chunk.embedding).toHaveLength(1536);
      }
    }

    const run = await ConnectorRunModel.findById(result.runId);
    expect(run?.status).toBe("success");
    const synced = await KnowledgeBaseConnectorModel.findById(connector.id);
    expect(synced?.lastSyncStatus).toBe("success");
    expect(synced?.checkpoint).toEqual({
      type: "perforce",
      lastSyncedAt: "2023-11-14T22:13:20.000Z",
      lastChangelist: 120,
    });

    // --- Incremental sync: one file changed in changelist 130 ---
    fakeDepot({
      headChange: 130,
      files: [
        {
          depotFile: "//depot/docs/guide.md",
          content:
            "# Guide\n\nHow to deploy the service.\n\nNow with rollbacks.\n",
          change: 130,
        },
      ],
    });

    const incremental = await connectorSyncService.executeSync(connector.id);
    expect(incremental.status).toBe("success");

    const incrementalRun = await ConnectorRunModel.findById(incremental.runId);
    expect(incrementalRun?.documentsProcessed).toBe(1);

    const updatedGuide = await KbDocumentModel.findById(guide!.id);
    expect(updatedGuide?.content).toContain("Now with rollbacks.");
    expect(updatedGuide?.embeddingStatus).toBe("pending");

    await alignRunTimestamps(connector.id, incremental.runId);
    await drainEmbeddingTasks();
    expect((await KbDocumentModel.findById(guide!.id))?.embeddingStatus).toBe(
      "completed",
    );

    const committed = await KnowledgeBaseConnectorModel.findById(connector.id);
    expect(committed?.checkpoint).toMatchObject({ lastChangelist: 130 });

    // --- No-op sync: nothing new submitted ---
    const noop = await connectorSyncService.executeSync(connector.id);
    expect(noop.status).toBe("success");
    const noopRun = await ConnectorRunModel.findById(noop.runId);
    expect(noopRun?.documentsProcessed).toBe(0);
  });

  test("time-boxed run persists the in-flight sweep cursor and the next run resumes it", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const connector = await createPerforceConnector({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    });

    fakeDepot({
      headChange: 200,
      files: Array.from({ length: 60 }, (_, i) => ({
        depotFile: `//depot/docs/file-${String(i).padStart(3, "0")}.md`,
        content: `# File ${i}\n`,
        change: 150,
      })),
    });

    // 60 files = 2 connector batches; a 1ms budget stops after the first.
    const partial = await connectorSyncService.executeSync(connector.id, {
      maxDurationMs: 1,
    });
    expect(partial.status).toBe("partial");

    const midSweep = await KnowledgeBaseConnectorModel.findById(connector.id);
    expect(midSweep?.checkpoint).toEqual({
      type: "perforce",
      lastChangelist: undefined,
      lastSyncedAt: undefined,
      targetChangelist: 200,
      targetChangeTime: "2023-11-14T22:13:20.000Z",
      filesOffset: 50,
    });
    expect(await KbDocumentModel.countByConnector(connector.id)).toBe(50);

    // Continuation run picks the sweep back up and commits the cursor.
    const resumed = await connectorSyncService.executeSync(connector.id);
    expect(resumed.status).toBe("success");
    expect(await KbDocumentModel.countByConnector(connector.id)).toBe(60);

    const committed = await KnowledgeBaseConnectorModel.findById(connector.id);
    expect(committed?.checkpoint).toEqual({
      type: "perforce",
      lastSyncedAt: "2023-11-14T22:13:20.000Z",
      lastChangelist: 200,
    });
  });
});
