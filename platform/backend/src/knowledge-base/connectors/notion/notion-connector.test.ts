import { describe, expect, it, vi } from "vitest";
import type { ConnectorSyncBatch } from "@/types";
import { NotionConnector } from "./notion-connector";

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
  return {
    ok: true,
    json: async () => ({
      object: "list",
      results: pages,
      has_more: opts?.hasMore ?? false,
      next_cursor: opts?.nextCursor ?? null,
    }),
  } as unknown as Response;
}

// Helper to build a mock blocks response
function makeBlocksResponse(
  texts: string[] = [],
  opts?: { hasMore?: boolean },
) {
  return {
    ok: true,
    json: async () => ({
      object: "list",
      results: texts.map((text) => ({
        object: "block",
        id: `block-${text.slice(0, 5)}`,
        type: "paragraph",
        has_children: false,
        paragraph: { rich_text: [{ plain_text: text }] },
      })),
      has_more: opts?.hasMore ?? false,
    }),
  } as unknown as Response;
}

// Helper to build a mock page fetch response
function makePageResponse(page: ReturnType<typeof makePage>) {
  return {
    ok: true,
    json: async () => page,
  } as unknown as Response;
}

const credentials = { apiToken: "secret_test-token" };

describe("NotionConnector", () => {
  it("has the correct type", () => {
    const connector = new NotionConnector();
    expect(connector.type).toBe("notion");
  });

  describe("validateConfig", () => {
    it("accepts empty config (no databaseIds required)", async () => {
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
      const result = await connector.validateConfig({
        pageIds: ["page-id-1"],
      });
      expect(result.valid).toBe(true);
    });

    it("accepts config with batchSize", async () => {
      const connector = new NotionConnector();
      const result = await connector.validateConfig({ batchSize: 25 });
      expect(result.valid).toBe(true);
    });
  });

  describe("testConnection", () => {
    it("returns failure on non-OK response", async () => {
      const connector = new NotionConnector();
      vi.spyOn(
        connector as unknown as { fetchWithRetry: unknown },
        "fetchWithRetry",
      ).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      } as Response);

      const result = await connector.testConnection({
        config: {},
        credentials: { apiToken: "invalid-token" },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("401");
    });

    it("returns success on OK response", async () => {
      const connector = new NotionConnector();
      vi.spyOn(
        connector as unknown as { fetchWithRetry: unknown },
        "fetchWithRetry",
      ).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ object: "user", id: "user-id" }),
      } as Response);

      const result = await connector.testConnection({
        config: {},
        credentials: { apiToken: "secret_valid-token" },
      });

      expect(result.success).toBe(true);
    });

    it("returns failure when fetch throws", async () => {
      const connector = new NotionConnector();
      vi.spyOn(
        connector as unknown as { fetchWithRetry: unknown },
        "fetchWithRetry",
      ).mockRejectedValueOnce(new Error("Network error"));

      const result = await connector.testConnection({
        config: {},
        credentials: { apiToken: "secret_valid-token" },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Network error");
    });
  });

  describe("sync — search mode (no pageIds)", () => {
    it("yields a batch of documents from search results", async () => {
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as { fetchWithRetry: unknown },
        "fetchWithRetry",
      );

      const pages = [
        makePage("page-1", "First Page"),
        makePage("page-2", "Second Page"),
      ];

      // search call
      fetchMock.mockResolvedValueOnce(makeSearchResponse(pages));
      // blocks for page-1
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["Hello world"]));
      // blocks for page-2
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["Some content"]));

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
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as { fetchWithRetry: unknown },
        "fetchWithRetry",
      );

      const page1 = makePage("page-1", "Page One");
      const page2 = makePage("page-2", "Page Two");

      // First search page — has more
      fetchMock.mockResolvedValueOnce(
        makeSearchResponse([page1], {
          hasMore: true,
          nextCursor: "cursor-abc",
        }),
      );
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["Content one"]));

      // Second search page — no more
      fetchMock.mockResolvedValueOnce(makeSearchResponse([page2]));
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["Content two"]));

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
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as { fetchWithRetry: unknown },
        "fetchWithRetry",
      );

      // Mix of page and database objects
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            makePage("page-1", "A Page"),
            { object: "database", id: "db-1" },
            makePage("page-2", "Another Page"),
          ],
          has_more: false,
          next_cursor: null,
        }),
      } as unknown as Response);
      fetchMock.mockResolvedValueOnce(makeBlocksResponse([]));
      fetchMock.mockResolvedValueOnce(makeBlocksResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(2);
      expect(batches[0].documents.every((d) => d.metadata.notionPageId)).toBe(
        true,
      );
    });

    it("continues sync when page content fetch fails", async () => {
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as { fetchWithRetry: unknown },
        "fetchWithRetry",
      );

      const pages = [
        makePage("page-1", "Good Page"),
        makePage("page-2", "Bad Page"),
        makePage("page-3", "Another Good Page"),
      ];

      fetchMock.mockResolvedValueOnce(makeSearchResponse(pages));
      // page-1 blocks — ok
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["Good content"]));
      // page-2 blocks — fails
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({}),
      } as unknown as Response);
      // page-3 blocks — ok
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["More content"]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // All 3 documents yielded — page-2 has empty content fallback
      expect(batches[0].documents).toHaveLength(3);
      expect(batches[0].documents[0].content).toContain("Good content");
      expect(batches[0].documents[1].content).toBe("# Bad Page");
      expect(batches[0].documents[2].content).toContain("More content");
    });

    it("throws when search endpoint returns error", async () => {
      const connector = new NotionConnector();
      vi.spyOn(
        connector as unknown as { fetchWithRetry: unknown },
        "fetchWithRetry",
      ).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      } as unknown as Response);

      const generator = connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      });

      await expect(generator.next()).rejects.toThrow("Notion search failed");
    });

    it("sets checkpoint lastSyncedAt from last result last_edited_time", async () => {
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as { fetchWithRetry: unknown },
        "fetchWithRetry",
      );

      const pages = [
        makePage("page-1", "First", {
          lastEditedTime: "2024-01-10T00:00:00.000Z",
        }),
        makePage("page-2", "Second", {
          lastEditedTime: "2024-01-20T00:00:00.000Z",
        }),
      ];

      fetchMock.mockResolvedValueOnce(makeSearchResponse(pages));
      fetchMock.mockResolvedValueOnce(makeBlocksResponse([]));
      fetchMock.mockResolvedValueOnce(makeBlocksResponse([]));

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

    it("preserves previous checkpoint when batch is empty", async () => {
      const connector = new NotionConnector();
      vi.spyOn(
        connector as unknown as { fetchWithRetry: unknown },
        "fetchWithRetry",
      ).mockResolvedValueOnce(makeSearchResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: {
          type: "notion",
          lastSyncedAt: "2024-01-01T00:00:00.000Z",
        },
      })) {
        batches.push(batch);
      }

      const cp = batches[0].checkpoint as Record<string, unknown>;
      expect(cp.lastSyncedAt).toBe("2024-01-01T00:00:00.000Z");
    });

    it("builds correct sourceUrl from page url", async () => {
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as { fetchWithRetry: unknown },
        "fetchWithRetry",
      );

      const page = makePage("abc-123", "My Page", {
        url: "https://www.notion.so/My-Page-abc123",
      });

      fetchMock.mockResolvedValueOnce(makeSearchResponse([page]));
      fetchMock.mockResolvedValueOnce(makeBlocksResponse([]));

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
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as { fetchWithRetry: unknown },
        "fetchWithRetry",
      );

      const page = makePage("page-id-1", "Test", {
        lastEditedTime: "2024-03-01T08:00:00.000Z",
      });

      fetchMock.mockResolvedValueOnce(makeSearchResponse([page]));
      fetchMock.mockResolvedValueOnce(makeBlocksResponse([]));

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
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as { fetchWithRetry: unknown },
        "fetchWithRetry",
      );

      const page1 = makePage("page-aaa", "Page AAA");
      const page2 = makePage("page-bbb", "Page BBB");

      // fetchPage for page-aaa
      fetchMock.mockResolvedValueOnce(makePageResponse(page1));
      // fetchPageContent for page-aaa
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["Content AAA"]));
      // fetchPage for page-bbb
      fetchMock.mockResolvedValueOnce(makePageResponse(page2));
      // fetchPageContent for page-bbb
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["Content BBB"]));

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
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as { fetchWithRetry: unknown },
        "fetchWithRetry",
      );

      // page-gone returns 404
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Not found",
      } as unknown as Response);

      // page-exists returns ok
      const page = makePage("page-exists", "Exists");
      fetchMock.mockResolvedValueOnce(makePageResponse(page));
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["Exists content"]));

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
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as { fetchWithRetry: unknown },
        "fetchWithRetry",
      );

      const page = makePage("page-1", "Formatted Page");
      fetchMock.mockResolvedValueOnce(makePageResponse(page));

      // Blocks with different types
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
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
      } as unknown as Response);

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

  describe("sync — invalid config", () => {
    it("throws when config is invalid", async () => {
      const connector = new NotionConnector();

      const generator = connector.sync({
        // batchSize as string is invalid
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
