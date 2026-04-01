import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, it, test } from "@/test";
import type { ConnectorSyncBatch } from "@/types";
import { NotionConnector } from "./notion-connector";

// Stub global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Helper to build a mock Notion page object
function makePage(
  id: string,
  title: string,
  opts?: { lastEditedTime?: string; url?: string; archived?: boolean },
) {
  return {
    object: "page",
    id,
    url: opts?.url ?? `https://www.notion.so/${id.replace(/-/g, "")}`,
    last_edited_time: opts?.lastEditedTime ?? "2024-01-15T10:00:00.000Z",
    created_time: "2024-01-01T00:00:00.000Z",
    archived: opts?.archived ?? false,
    properties: {
      title: {
        type: "title",
        title: [{ plain_text: title }],
      },
    },
  };
}

// Helper to build a mock search response
function makeSearchResponse(
  pages: ReturnType<typeof makePage>[],
  opts?: { hasMore?: boolean; nextCursor?: string },
) {
  return new Response(
    JSON.stringify({
      object: "list",
      results: pages,
      has_more: opts?.hasMore ?? false,
      next_cursor: opts?.nextCursor ?? null,
    }),
    { status: 200 },
  );
}

// Helper to build a mock blocks response
function makeBlocksResponse(texts: string[] = []) {
  return new Response(
    JSON.stringify({
      object: "list",
      results: texts.map((text) => ({
        object: "block",
        id: `block-${text.slice(0, 5)}`,
        type: "paragraph",
        has_children: false,
        paragraph: { rich_text: [{ plain_text: text }] },
      })),
      has_more: false,
    }),
    { status: 200 },
  );
}

// Helper to build a mock page fetch response
function makePageResponse(page: ReturnType<typeof makePage>) {
  return new Response(JSON.stringify(page), { status: 200 });
}

// Helper to build a mock database query response
function makeDatabaseQueryResponse(
  pages: ReturnType<typeof makePage>[],
  opts?: { hasMore?: boolean; nextCursor?: string },
) {
  return new Response(
    JSON.stringify({
      object: "list",
      results: pages,
      has_more: opts?.hasMore ?? false,
      next_cursor: opts?.nextCursor ?? null,
    }),
    { status: 200 },
  );
}

// Helper to build a mock error response
function makeErrorResponse(status: number, message = "Error") {
  return new Response(JSON.stringify({ message }), { status });
}

const credentials = { apiToken: "secret_test-token" };

describe("NotionConnector", () => {
  let connector: NotionConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new NotionConnector();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  test("has the correct type", () => {
    expect(connector.type).toBe("notion");
  });

  describe("validateConfig", () => {
    test("accepts empty config", async () => {
      const result = await connector.validateConfig({});
      expect(result.valid).toBe(true);
    });

    test("accepts config with databaseIds", async () => {
      const result = await connector.validateConfig({
        databaseIds: ["abc123", "def456"],
      });
      expect(result.valid).toBe(true);
    });

    test("accepts config with pageIds", async () => {
      const result = await connector.validateConfig({
        pageIds: ["page-id-1"],
      });
      expect(result.valid).toBe(true);
    });

    test("accepts config with batchSize", async () => {
      const result = await connector.validateConfig({ batchSize: 25 });
      expect(result.valid).toBe(true);
    });
  });

  describe("testConnection", () => {
    test("returns failure on non-OK response", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(401, "Unauthorized"));

      const result = await connector.testConnection({
        config: {},
        credentials: { apiToken: "invalid-token" },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("401");
    });

    test("returns success when API responds OK", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ object: "user", id: "user-id" }), {
          status: 200,
        }),
      );

      const result = await connector.testConnection({
        config: {},
        credentials: { apiToken: "secret_valid-token" },
      });

      expect(result.success).toBe(true);
    });

    test("returns failure when fetch throws", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await connector.testConnection({
        config: {},
        credentials: { apiToken: "secret_valid-token" },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Network error");
    });
  });

  describe("sync — workspace search mode (no databaseIds or pageIds)", () => {
    it("yields a batch of documents from search results", async () => {
      const pages = [
        makePage("page-1", "First Page"),
        makePage("page-2", "Second Page"),
      ];

      mockFetch.mockResolvedValueOnce(makeSearchResponse(pages));
      mockFetch.mockResolvedValueOnce(makeBlocksResponse(["Hello world"]));
      mockFetch.mockResolvedValueOnce(makeBlocksResponse(["Some content"]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(2);
      expect(batches[0].documents[0].id).toBe("page-1");
      expect(batches[0].documents[0].title).toBe("First Page");
      expect(batches[0].documents[0].content).toContain("Hello world");
      expect(batches[0].documents[1].id).toBe("page-2");
    });

    it("paginates through multiple search pages using cursor", async () => {
      const page1 = makePage("page-1", "Page One");
      const page2 = makePage("page-2", "Page Two");

      mockFetch.mockResolvedValueOnce(
        makeSearchResponse([page1], {
          hasMore: true,
          nextCursor: "cursor-abc",
        }),
      );
      mockFetch.mockResolvedValueOnce(makeBlocksResponse(["Content one"]));

      mockFetch.mockResolvedValueOnce(makeSearchResponse([page2]));
      mockFetch.mockResolvedValueOnce(makeBlocksResponse(["Content two"]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].hasMore).toBe(true);
      expect(batches[0].documents[0].id).toBe("page-1");
      expect(batches[1].hasMore).toBe(false);
      expect(batches[1].documents[0].id).toBe("page-2");
    });

    it("skips non-page objects in search results", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              makePage("page-1", "A Page"),
              { object: "database", id: "db-1" },
              makePage("page-2", "Another Page"),
            ],
            has_more: false,
            next_cursor: null,
          }),
          { status: 200 },
        ),
      );
      mockFetch.mockResolvedValueOnce(makeBlocksResponse([]));
      mockFetch.mockResolvedValueOnce(makeBlocksResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(2);
      expect(batches[0].documents.every((d) => d.metadata.notionPageId))
        .toBe(true);
    });

    it("continues sync when page content fetch fails", async () => {
      const pages = [
        makePage("page-1", "Good Page"),
        makePage("page-2", "Bad Page"),
        makePage("page-3", "Another Good Page"),
      ];

      mockFetch.mockResolvedValueOnce(makeSearchResponse(pages));
      mockFetch.mockResolvedValueOnce(makeBlocksResponse(["Good content"]));
      mockFetch.mockResolvedValueOnce(makeErrorResponse(500, "Server Error"));
      mockFetch.mockResolvedValueOnce(makeBlocksResponse(["More content"]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(3);
      expect(batches[0].documents[0].content).toContain("Good content");
      expect(batches[0].documents[1].content).toBe("# Bad Page");
      expect(batches[0].documents[2].content).toContain("More content");
    });

    it("throws when search endpoint returns error", async () => {
      mockFetch.mockResolvedValueOnce(
        makeErrorResponse(500, "Internal Server Error"),
      );

      const generator = connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      });

      await expect(generator.next()).rejects.toThrow("Notion search failed");
    });

    it("sets checkpoint lastSyncedAt from last result last_edited_time", async () => {
      const pages = [
        makePage("page-1", "First", {
          lastEditedTime: "2024-01-10T00:00:00.000Z",
        }),
        makePage("page-2", "Second", {
          lastEditedTime: "2024-01-20T00:00:00.000Z",
        }),
      ];

      mockFetch.mockResolvedValueOnce(makeSearchResponse(pages));
      mockFetch.mockResolvedValueOnce(makeBlocksResponse([]));
      mockFetch.mockResolvedValueOnce(makeBlocksResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const cp = batches[0].checkpoint as Record<string, unknown>;
      expect(cp.type).toBe("notion");
      expect(cp.lastSyncedAt).toBe("2024-01-20T00:00:00.000Z");
    });

    it("builds correct sourceUrl from page url", async () => {
      const page = makePage("abc-123", "My Page", {
        url: "https://www.notion.so/My-Page-abc123",
      });

      mockFetch.mockResolvedValueOnce(makeSearchResponse([page]));
      mockFetch.mockResolvedValueOnce(makeBlocksResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents[0].sourceUrl).toBe(
        "https://www.notion.so/My-Page-abc123",
      );
    });

    it("includes metadata in document", async () => {
      const page = makePage("page-id-1", "Test", {
        lastEditedTime: "2024-03-01T08:00:00.000Z",
      });

      mockFetch.mockResolvedValueOnce(makeSearchResponse([page]));
      mockFetch.mockResolvedValueOnce(makeBlocksResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const metadata = batches[0].documents[0].metadata;
      expect(metadata.notionPageId).toBe("page-id-1");
      expect(metadata.lastEditedTime).toBe("2024-03-01T08:00:00.000Z");
      expect(metadata.archived).toBe(false);
    });
  });

  describe("sync — specific pages mode (with pageIds)", () => {
    it("yields documents for specific pageIds", async () => {
      const page1 = makePage("page-aaa", "Page AAA");
      const page2 = makePage("page-bbb", "Page BBB");

      mockFetch.mockResolvedValueOnce(makePageResponse(page1));
      mockFetch.mockResolvedValueOnce(makeBlocksResponse(["Content AAA"]));
      mockFetch.mockResolvedValueOnce(makePageResponse(page2));
      mockFetch.mockResolvedValueOnce(makeBlocksResponse(["Content BBB"]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { pageIds: ["page-aaa", "page-bbb"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(2);
      expect(batches[0].documents[0].title).toBe("Page AAA");
      expect(batches[0].documents[0].content).toContain("Content AAA");
      expect(batches[0].documents[1].title).toBe("Page BBB");
    });

    it("skips page that returns 404", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(404, "Not found"));
      const page = makePage("page-exists", "Exists");
      mockFetch.mockResolvedValueOnce(makePageResponse(page));
      mockFetch.mockResolvedValueOnce(makeBlocksResponse(["Exists content"]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { pageIds: ["page-gone", "page-exists"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].id).toBe("page-exists");
    });

    it("produces correct markdown content from block types", async () => {
      const page = makePage("page-1", "Formatted Page");
      mockFetch.mockResolvedValueOnce(makePageResponse(page));

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                object: "block",
                id: "b1",
                type: "heading_1",
                has_children: false,
                heading_1: { rich_text: [{ plain_text: "Main Title" }] },
              },
              {
                object: "block",
                id: "b2",
                type: "heading_2",
                has_children: false,
                heading_2: { rich_text: [{ plain_text: "Sub Title" }] },
              },
              {
                object: "block",
                id: "b3",
                type: "bulleted_list_item",
                has_children: false,
                bulleted_list_item: { rich_text: [{ plain_text: "List item" }] },
              },
              {
                object: "block",
                id: "b4",
                type: "quote",
                has_children: false,
                quote: { rich_text: [{ plain_text: "A quote" }] },
              },
              {
                object: "block",
                id: "b5",
                type: "code",
                has_children: false,
                code: { rich_text: [{ plain_text: "const x = 1" }] },
              },
            ],
            has_more: false,
          }),
          { status: 200 },
        ),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { pageIds: ["page-1"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const content = batches[0].documents[0].content;
      expect(content).toContain("# Main Title");
      expect(content).toContain("## Sub Title");
      expect(content).toContain("- List item");
      expect(content).toContain("> A quote");
      expect(content).toContain("```\nconst x = 1\n```");
    });
  });

  describe("sync — database mode (with databaseIds)", () => {
    it("yields documents from database query", async () => {
      const pages = [
        makePage("db-page-1", "DB Page 1"),
        makePage("db-page-2", "DB Page 2"),
      ];

      mockFetch.mockResolvedValueOnce(makeDatabaseQueryResponse(pages));
      mockFetch.mockResolvedValueOnce(makeBlocksResponse(["DB content 1"]));
      mockFetch.mockResolvedValueOnce(makeBlocksResponse(["DB content 2"]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { databaseIds: ["database-abc"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(2);
      expect(batches[0].documents[0].id).toBe("db-page-1");
      expect(batches[0].documents[0].content).toContain("DB content 1");
    });

    it("paginates through database query results", async () => {
      const page1 = makePage("db-page-1", "DB Page 1");
      const page2 = makePage("db-page-2", "DB Page 2");

      mockFetch.mockResolvedValueOnce(
        makeDatabaseQueryResponse([page1], {
          hasMore: true,
          nextCursor: "cursor-xyz",
        }),
      );
      mockFetch.mockResolvedValueOnce(makeBlocksResponse(["Content 1"]));

      mockFetch.mockResolvedValueOnce(makeDatabaseQueryResponse([page2]));
      mockFetch.mockResolvedValueOnce(makeBlocksResponse(["Content 2"]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { databaseIds: ["database-abc"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].hasMore).toBe(true);
      expect(batches[1].hasMore).toBe(false);
    });
  });

  describe("sync — invalid config", () => {
    it("throws when config is invalid", async () => {
      const generator = connector.sync({
        config: { batchSize: "not-a-number" },
        credentials,
        checkpoint: null,
      });

      await expect(generator.next()).rejects.toThrow(
        "Invalid Notion configuration",
      );
    });
  });
});
