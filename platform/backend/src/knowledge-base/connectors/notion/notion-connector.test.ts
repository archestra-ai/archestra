import { describe, expect, it, vi } from "vitest";
import type { ConnectorSyncBatch } from "@/types";
import { NotionConnector } from "./notion-connector";

// ===== Mock helpers =====

function makePage(
  id: string,
  title: string,
  opts?: {
    lastEditedTime?: string;
    url?: string;
    archived?: boolean;
    createdTime?: string;
  },
) {
  return {
    object: "page",
    id,
    url: opts?.url ?? `https://www.notion.so/${id.replace(/-/g, "")}`,
    last_edited_time: opts?.lastEditedTime ?? "2024-01-15T10:00:00.000Z",
    created_time: opts?.createdTime ?? "2024-01-01T00:00:00.000Z",
    archived: opts?.archived ?? false,
    properties: {
      title: {
        type: "title",
        title: [{ plain_text: title }],
      },
    },
  };
}

function makeSearchResponse(
  pages: ReturnType<typeof makePage>[],
  opts?: { hasMore?: boolean; nextCursor?: string },
) {
  return {
    ok: true,
    json: async () => ({
      object: "list",
      results: pages,
      has_more: opts?.hasMore ?? false,
      next_cursor: opts?.nextCursor ?? null,
    }),
    text: async () => "",
  } as unknown as Response;
}

function makeBlocksResponse(
  blocks: Array<{ type: string; text: string; hasChildren?: boolean }>,
  opts?: { hasMore?: boolean },
) {
  return {
    ok: true,
    json: async () => ({
      object: "list",
      results: blocks.map((b) => ({
        object: "block",
        id: `block-${b.text.slice(0, 8)}`,
        type: b.type,
        has_children: b.hasChildren ?? false,
        [b.type]: {
          rich_text: [{ plain_text: b.text }],
        },
      })),
      has_more: opts?.hasMore ?? false,
      next_cursor: null,
    }),
    text: async () => "",
  } as unknown as Response;
}

function makePageResponse(page: ReturnType<typeof makePage>) {
  return {
    ok: true,
    json: async () => page,
    text: async () => "",
  } as unknown as Response;
}

function makeDatabaseQueryResponse(
  pages: ReturnType<typeof makePage>[],
  opts?: { hasMore?: boolean; nextCursor?: string },
) {
  return {
    ok: true,
    json: async () => ({
      object: "list",
      results: pages,
      has_more: opts?.hasMore ?? false,
      next_cursor: opts?.nextCursor ?? null,
    }),
    text: async () => "",
  } as unknown as Response;
}

function makeErrorResponse(status: number, message: string) {
  return {
    ok: false,
    status,
    json: async () => ({ message }),
    text: async () => message,
  } as unknown as Response;
}

const credentials = { apiToken: "secret_test-token" };

// ===== Tests =====

describe("NotionConnector", () => {
  it("has the correct type", () => {
    const connector = new NotionConnector();
    expect(connector.type).toBe("notion");
  });

  // ===== validateConfig =====

  describe("validateConfig", () => {
    it("accepts empty config (workspace-wide sync)", async () => {
      const connector = new NotionConnector();
      const result = await connector.validateConfig({});
      expect(result.valid).toBe(true);
    });

    it("accepts config with databaseIds", async () => {
      const connector = new NotionConnector();
      const result = await connector.validateConfig({
        databaseIds: ["abc123", "def456"],
      });
      expect(result.valid).toBe(true);
    });

    it("accepts config with pageIds", async () => {
      const connector = new NotionConnector();
      const result = await connector.validateConfig({ pageIds: ["page-id-1"] });
      expect(result.valid).toBe(true);
    });

    it("accepts config with batchSize", async () => {
      const connector = new NotionConnector();
      const result = await connector.validateConfig({ batchSize: 25 });
      expect(result.valid).toBe(true);
    });

    it("accepts config with all optional fields", async () => {
      const connector = new NotionConnector();
      const result = await connector.validateConfig({
        databaseIds: ["db1"],
        pageIds: ["pg1"],
        batchSize: 10,
      });
      expect(result.valid).toBe(true);
    });
  });

  // ===== testConnection =====

  describe("testConnection", () => {
    it("returns success when API responds 200", async () => {
      const connector = new NotionConnector();
      vi.spyOn(connector as any, "fetchWithRetry").mockResolvedValueOnce({
        ok: true,
        json: async () => ({ object: "user", id: "user-id" }),
        text: async () => "",
      } as unknown as Response);

      const result = await connector.testConnection({
        config: {},
        credentials,
      });
      expect(result.success).toBe(true);
    });

    it("returns error when API responds with non-ok status", async () => {
      const connector = new NotionConnector();
      vi.spyOn(connector as any, "fetchWithRetry").mockResolvedValueOnce(
        makeErrorResponse(401, "Unauthorized"),
      );

      const result = await connector.testConnection({
        config: {},
        credentials,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("401");
    });

    it("returns error when fetch throws", async () => {
      const connector = new NotionConnector();
      vi.spyOn(connector as any, "fetchWithRetry").mockRejectedValueOnce(
        new Error("Network error"),
      );

      const result = await connector.testConnection({
        config: {},
        credentials,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Network error");
    });
  });

  // ===== estimateTotalItems =====

  describe("estimateTotalItems", () => {
    it("returns page count when explicit pageIds provided", async () => {
      const connector = new NotionConnector();
      const count = await connector.estimateTotalItems({
        config: { pageIds: ["p1", "p2", "p3"] },
        credentials,
        checkpoint: null,
      });
      expect(count).toBe(3);
    });

    it("returns null for workspace-wide sync (cannot estimate)", async () => {
      const connector = new NotionConnector();
      const count = await connector.estimateTotalItems({
        config: {},
        credentials,
        checkpoint: null,
      });
      expect(count).toBeNull();
    });

    it("returns null for database sync", async () => {
      const connector = new NotionConnector();
      const count = await connector.estimateTotalItems({
        config: { databaseIds: ["db1"] },
        credentials,
        checkpoint: null,
      });
      expect(count).toBeNull();
    });
  });

  // ===== sync: full workspace =====

  describe("sync (full workspace)", () => {
    it("yields documents from /search", async () => {
      const connector = new NotionConnector();
      const pages = [makePage("p1", "Page One"), makePage("p2", "Page Two")];

      const fetch = vi.spyOn(connector as any, "fetchWithRetry");
      // /search response
      fetch.mockResolvedValueOnce(makeSearchResponse(pages));
      // blocks for p1
      fetch.mockResolvedValueOnce(
        makeBlocksResponse([{ type: "paragraph", text: "Content of page one" }]),
      );
      // blocks for p2
      fetch.mockResolvedValueOnce(
        makeBlocksResponse([{ type: "paragraph", text: "Content of page two" }]),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches.length).toBeGreaterThan(0);
      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(2);
      expect(allDocs[0].title).toBe("Page One");
      expect(allDocs[1].title).toBe("Page Two");
    });

    it("sets correct source URLs", async () => {
      const connector = new NotionConnector();
      const page = makePage("p1", "My Page", {
        url: "https://www.notion.so/mypage",
      });

      const fetch = vi.spyOn(connector as any, "fetchWithRetry");
      fetch.mockResolvedValueOnce(makeSearchResponse([page]));
      fetch.mockResolvedValueOnce(makeBlocksResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const doc = batches.flatMap((b) => b.documents)[0];
      expect(doc.sourceUrl).toBe("https://www.notion.so/mypage");
    });

    it("skips archived pages", async () => {
      const connector = new NotionConnector();
      const pages = [
        makePage("p1", "Active Page"),
        makePage("p2", "Archived Page", { archived: true }),
      ];

      const fetch = vi.spyOn(connector as any, "fetchWithRetry");
      fetch.mockResolvedValueOnce(makeSearchResponse(pages));
      // Only one block call for the active page
      fetch.mockResolvedValueOnce(makeBlocksResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(1);
      expect(allDocs[0].title).toBe("Active Page");
    });

    it("handles pagination with next_cursor", async () => {
      const connector = new NotionConnector();
      const page1 = makePage("p1", "Page 1");
      const page2 = makePage("p2", "Page 2");

      const fetch = vi.spyOn(connector as any, "fetchWithRetry");
      // First page of results
      fetch.mockResolvedValueOnce(
        makeSearchResponse([page1], { hasMore: true, nextCursor: "cursor-1" }),
      );
      fetch.mockResolvedValueOnce(makeBlocksResponse([]));
      // Second page
      fetch.mockResolvedValueOnce(makeSearchResponse([page2]));
      fetch.mockResolvedValueOnce(makeBlocksResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(2);
    });

    it("sets hasMore=false in final batch", async () => {
      const connector = new NotionConnector();
      const fetch = vi.spyOn(connector as any, "fetchWithRetry");
      fetch.mockResolvedValueOnce(
        makeSearchResponse([makePage("p1", "Only Page")]),
      );
      fetch.mockResolvedValueOnce(makeBlocksResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const last = batches[batches.length - 1];
      expect(last.hasMore).toBe(false);
    });

    it("yields empty batch when no pages found", async () => {
      const connector = new NotionConnector();
      const fetch = vi.spyOn(connector as any, "fetchWithRetry");
      fetch.mockResolvedValueOnce(makeSearchResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(0);
    });
  });

  // ===== sync: incremental =====

  describe("sync (incremental via checkpoint)", () => {
    it("skips pages not modified since checkpoint", async () => {
      const connector = new NotionConnector();
      const oldPage = makePage("p1", "Old Page", {
        lastEditedTime: "2024-01-10T00:00:00.000Z",
      });
      const newPage = makePage("p2", "New Page", {
        lastEditedTime: "2024-01-20T00:00:00.000Z",
      });

      const fetch = vi.spyOn(connector as any, "fetchWithRetry");
      fetch.mockResolvedValueOnce(makeSearchResponse([oldPage, newPage]));
      // Only new page gets blocks fetched
      fetch.mockResolvedValueOnce(makeBlocksResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: {
          type: "notion",
          lastSyncedAt: "2024-01-15T00:00:00.000Z",
        },
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(1);
      expect(allDocs[0].title).toBe("New Page");
    });

    it("updates checkpoint lastSyncedAt to newest page timestamp", async () => {
      const connector = new NotionConnector();
      const page = makePage("p1", "Updated Page", {
        lastEditedTime: "2024-02-01T12:00:00.000Z",
      });

      const fetch = vi.spyOn(connector as any, "fetchWithRetry");
      fetch.mockResolvedValueOnce(makeSearchResponse([page]));
      fetch.mockResolvedValueOnce(makeBlocksResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const lastCheckpoint = batches[batches.length - 1].checkpoint;
      expect((lastCheckpoint as { lastSyncedAt?: string }).lastSyncedAt).toBe(
        "2024-02-01T12:00:00.000Z",
      );
    });
  });

  // ===== sync: targeted (explicit pageIds) =====

  describe("sync (targeted: explicit pageIds)", () => {
    it("fetches only specified pages", async () => {
      const connector = new NotionConnector();
      const page1 = makePage("page-id-1", "Explicit Page 1");
      const page2 = makePage("page-id-2", "Explicit Page 2");

      const fetch = vi.spyOn(connector as any, "fetchWithRetry");
      // fetch page-id-1
      fetch.mockResolvedValueOnce(makePageResponse(page1));
      fetch.mockResolvedValueOnce(makeBlocksResponse([]));
      // fetch page-id-2
      fetch.mockResolvedValueOnce(makePageResponse(page2));
      fetch.mockResolvedValueOnce(makeBlocksResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { pageIds: ["page-id-1", "page-id-2"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(2);
      expect(allDocs[0].title).toBe("Explicit Page 1");
      expect(allDocs[1].title).toBe("Explicit Page 2");
    });

    it("skips pages that return null (e.g., 404)", async () => {
      const connector = new NotionConnector();
      const fetch = vi.spyOn(connector as any, "fetchWithRetry");
      fetch.mockResolvedValueOnce({ ok: false, text: async () => "" } as Response);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { pageIds: ["missing-page"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(0);
    });

    it("yields final batch with hasMore=false", async () => {
      const connector = new NotionConnector();
      const fetch = vi.spyOn(connector as any, "fetchWithRetry");
      fetch.mockResolvedValueOnce(makePageResponse(makePage("p1", "Page")));
      fetch.mockResolvedValueOnce(makeBlocksResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { pageIds: ["p1"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[batches.length - 1].hasMore).toBe(false);
    });
  });

  // ===== sync: database-filtered =====

  describe("sync (database-filtered: explicit databaseIds)", () => {
    it("queries each database and yields documents", async () => {
      const connector = new NotionConnector();
      const pages = [makePage("p1", "DB Page 1"), makePage("p2", "DB Page 2")];

      const fetch = vi.spyOn(connector as any, "fetchWithRetry");
      // Database query
      fetch.mockResolvedValueOnce(makeDatabaseQueryResponse(pages));
      fetch.mockResolvedValueOnce(makeBlocksResponse([]));
      fetch.mockResolvedValueOnce(makeBlocksResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { databaseIds: ["db-123"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(2);
    });

    it("handles multiple databases", async () => {
      const connector = new NotionConnector();
      const fetch = vi.spyOn(connector as any, "fetchWithRetry");

      // db1
      fetch.mockResolvedValueOnce(
        makeDatabaseQueryResponse([makePage("p1", "DB1 Page")]),
      );
      fetch.mockResolvedValueOnce(makeBlocksResponse([]));
      // db2
      fetch.mockResolvedValueOnce(
        makeDatabaseQueryResponse([makePage("p2", "DB2 Page")]),
      );
      fetch.mockResolvedValueOnce(makeBlocksResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { databaseIds: ["db1", "db2"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(2);
    });

    it("handles database query error gracefully", async () => {
      const connector = new NotionConnector();
      const fetch = vi.spyOn(connector as any, "fetchWithRetry");
      fetch.mockResolvedValueOnce(makeErrorResponse(403, "Forbidden"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { databaseIds: ["db-forbidden"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // No documents but no throw
      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(0);
    });

    it("paginates database results", async () => {
      const connector = new NotionConnector();
      const fetch = vi.spyOn(connector as any, "fetchWithRetry");

      // First page
      fetch.mockResolvedValueOnce(
        makeDatabaseQueryResponse([makePage("p1", "Page 1")], {
          hasMore: true,
          nextCursor: "db-cursor",
        }),
      );
      fetch.mockResolvedValueOnce(makeBlocksResponse([]));
      // Second page
      fetch.mockResolvedValueOnce(
        makeDatabaseQueryResponse([makePage("p2", "Page 2")]),
      );
      fetch.mockResolvedValueOnce(makeBlocksResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { databaseIds: ["db1"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(2);
    });
  });

  // ===== block content conversion =====

  describe("block content conversion", () => {
    async function syncSinglePage(
      connector: NotionConnector,
      blocks: Array<{ type: string; text: string; hasChildren?: boolean }>,
    ): Promise<string> {
      const fetch = vi.spyOn(connector as any, "fetchWithRetry");
      fetch.mockResolvedValueOnce(
        makeSearchResponse([makePage("p1", "Test Page")]),
      );
      fetch.mockResolvedValueOnce(makeBlocksResponse(blocks));

      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        const doc = batch.documents[0];
        if (doc) return doc.content;
      }
      return "";
    }

    it("renders paragraph blocks as plain text", async () => {
      const connector = new NotionConnector();
      const content = await syncSinglePage(connector, [
        { type: "paragraph", text: "Hello world" },
      ]);
      expect(content).toContain("Hello world");
    });

    it("renders heading_1 as # heading", async () => {
      const connector = new NotionConnector();
      const content = await syncSinglePage(connector, [
        { type: "heading_1", text: "Big Heading" },
      ]);
      expect(content).toContain("# Big Heading");
    });

    it("renders heading_2 as ## heading", async () => {
      const connector = new NotionConnector();
      const content = await syncSinglePage(connector, [
        { type: "heading_2", text: "Medium Heading" },
      ]);
      expect(content).toContain("## Medium Heading");
    });

    it("renders heading_3 as ### heading", async () => {
      const connector = new NotionConnector();
      const content = await syncSinglePage(connector, [
        { type: "heading_3", text: "Small Heading" },
      ]);
      expect(content).toContain("### Small Heading");
    });

    it("renders bulleted_list_item as - item", async () => {
      const connector = new NotionConnector();
      const content = await syncSinglePage(connector, [
        { type: "bulleted_list_item", text: "Bullet point" },
      ]);
      expect(content).toContain("- Bullet point");
    });

    it("renders numbered_list_item as 1. item", async () => {
      const connector = new NotionConnector();
      const content = await syncSinglePage(connector, [
        { type: "numbered_list_item", text: "Step one" },
      ]);
      expect(content).toContain("1. Step one");
    });

    it("renders quote blocks with > prefix", async () => {
      const connector = new NotionConnector();
      const content = await syncSinglePage(connector, [
        { type: "quote", text: "Famous quote" },
      ]);
      expect(content).toContain("> Famous quote");
    });

    it("renders divider as ---", async () => {
      const connector = new NotionConnector();
      const content = await syncSinglePage(connector, [
        { type: "divider", text: "" },
      ]);
      expect(content).toContain("---");
    });

    it("joins multiple blocks with newlines", async () => {
      const connector = new NotionConnector();
      const content = await syncSinglePage(connector, [
        { type: "paragraph", text: "First paragraph" },
        { type: "paragraph", text: "Second paragraph" },
      ]);
      expect(content).toContain("First paragraph");
      expect(content).toContain("Second paragraph");
    });
  });

  // ===== metadata =====

  describe("document metadata", () => {
    it("includes pageId, createdTime, lastEditedTime in metadata", async () => {
      const connector = new NotionConnector();
      const page = makePage("page-abc", "Meta Page", {
        lastEditedTime: "2024-03-10T09:00:00.000Z",
        createdTime: "2024-01-01T00:00:00.000Z",
      });

      const fetch = vi.spyOn(connector as any, "fetchWithRetry");
      fetch.mockResolvedValueOnce(makeSearchResponse([page]));
      fetch.mockResolvedValueOnce(makeBlocksResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const doc = batches[0].documents[0];
      expect(doc.metadata.pageId).toBe("page-abc");
      expect(doc.metadata.createdTime).toBe("2024-01-01T00:00:00.000Z");
      expect(doc.metadata.lastEditedTime).toBe("2024-03-10T09:00:00.000Z");
    });

    it("sets updatedAt from page last_edited_time", async () => {
      const connector = new NotionConnector();
      const page = makePage("p1", "Page", {
        lastEditedTime: "2024-06-15T14:30:00.000Z",
      });

      const fetch = vi.spyOn(connector as any, "fetchWithRetry");
      fetch.mockResolvedValueOnce(makeSearchResponse([page]));
      fetch.mockResolvedValueOnce(makeBlocksResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const doc = batches[0].documents[0];
      expect(doc.updatedAt?.toISOString()).toBe("2024-06-15T14:30:00.000Z");
    });
  });

  // ===== error resilience =====

  describe("error resilience", () => {
    it("continues after blocks fetch failure", async () => {
      const connector = new NotionConnector();
      const pages = [makePage("p1", "Page 1"), makePage("p2", "Page 2")];

      const fetch = vi.spyOn(connector as any, "fetchWithRetry");
      fetch.mockResolvedValueOnce(makeSearchResponse(pages));
      // p1 blocks fail
      fetch.mockRejectedValueOnce(new Error("Block fetch failed"));
      // p2 blocks succeed
      fetch.mockResolvedValueOnce(
        makeBlocksResponse([{ type: "paragraph", text: "Page 2 content" }]),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Both pages still appear (p1 has empty content from fallback)
      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(2);
      expect(allDocs[0].content).toBe("");
      expect(allDocs[1].content).toContain("Page 2 content");
    });

    it("stops search on API error and yields what was collected", async () => {
      const connector = new NotionConnector();
      const fetch = vi.spyOn(connector as any, "fetchWithRetry");
      fetch.mockRejectedValueOnce(new Error("Network failure"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Should yield nothing, not throw
      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(0);
    });

    it("records failures for block fetch errors", async () => {
      const connector = new NotionConnector();
      const page = makePage("p1", "Page with Block Error");

      const fetch = vi.spyOn(connector as any, "fetchWithRetry");
      fetch.mockResolvedValueOnce(makeSearchResponse([page]));
      fetch.mockRejectedValueOnce(new Error("Blocks unavailable"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allFailures = batches.flatMap((b) => b.failures ?? []);
      expect(allFailures.length).toBeGreaterThan(0);
      expect(allFailures[0].resource).toBe("blocks");
    });
  });

  // ===== invalid config =====

  describe("sync with invalid config", () => {
    it("throws on invalid config", async () => {
      const connector = new NotionConnector();

      await expect(async () => {
        for await (const _ of connector.sync({
          config: { type: "invalid_type" },
          credentials,
          checkpoint: null,
        })) {
          // consume
        }
      }).rejects.toThrow("Invalid Notion configuration");
    });
  });
});
