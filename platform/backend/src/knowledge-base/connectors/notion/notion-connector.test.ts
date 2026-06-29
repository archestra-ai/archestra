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
      type: "page_or_data_source",
      results: pages,
      has_more: opts?.hasMore ?? false,
      next_cursor: opts?.nextCursor ?? null,
    }),
  } as unknown as Response;
}

// Helper to build a mock database query response
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
      type: "block",
      block: {},
      results: texts.map((text) => ({
        object: "block",
        id: `block-${text.slice(0, 5)}`,
        type: "paragraph",
        has_children: false,
        paragraph: { rich_text: [{ plain_text: text }] },
      })),
      has_more: opts?.hasMore ?? false,
      next_cursor: null,
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
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
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
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
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
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
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

  describe("sync — search mode (no IDs)", () => {
    it("yields a batch of documents from search results", async () => {
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const pages = [
        makePage("page-1", "First Page"),
        makePage("page-2", "Second Page"),
      ];

      fetchMock.mockResolvedValueOnce(makeSearchResponse(pages));
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["Hello world"]));
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
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const page1 = makePage("page-1", "Page One");
      const page2 = makePage("page-2", "Page Two");

      fetchMock.mockResolvedValueOnce(
        makeSearchResponse([page1], {
          hasMore: true,
          nextCursor: "cursor-abc",
        }),
      );
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["Content one"]));

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

    it("skips non-page and partial-page objects in search results", async () => {
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          type: "page_or_data_source",
          object: "list",
          results: [
            makePage("page-1", "A Page"),
            { object: "database", id: "db-1" },
            { object: "page", id: "partial-page" }, // PartialPageObjectResponse — no properties
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

      // Only full PageObjectResponse items with properties are included
      expect(batches[0].documents).toHaveLength(2);
      expect(batches[0].documents.every((d) => d.metadata.notionPageId)).toBe(
        true,
      );
    });

    it("post-filters unchanged pages when checkpoint is present", async () => {
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      // lastSyncedAt is 2024-01-15T12:00:00Z, safety buffer subtracts 5 min
      // so effective cutoff is 2024-01-15T11:55:00Z
      const checkpoint = {
        type: "notion",
        lastSyncedAt: "2024-01-15T12:00:00.000Z",
      };

      const pages = [
        makePage("old-page", "Old", {
          lastEditedTime: "2024-01-10T00:00:00.000Z",
        }), // before cutoff — skip
        makePage("new-page", "New", {
          lastEditedTime: "2024-01-20T00:00:00.000Z",
        }), // after cutoff — process
      ];

      fetchMock.mockResolvedValueOnce(makeSearchResponse(pages));
      // only new-page should have its blocks fetched
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["Fresh content"]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint,
      })) {
        batches.push(batch);
      }

      // old-page is skipped, only new-page returned
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].id).toBe("new-page");
      // checkpoint advances to last result's time (old-page), not just processed ones
      const cp = batches[0].checkpoint as Record<string, unknown>;
      expect(cp.lastSyncedAt).toBe("2024-01-20T00:00:00.000Z");
      // fetchWithRetry called exactly twice: search + one blocks call
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("skips page and continues sync when block content fetch fails", async () => {
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const pages = [
        makePage("page-1", "Good Page"),
        makePage("page-2", "Bad Page"),
        makePage("page-3", "Another Good Page"),
      ];

      fetchMock.mockResolvedValueOnce(makeSearchResponse(pages));
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["Good content"]));
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      } as unknown as Response);
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["More content"]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // page-2 is skipped (block fetch failed), remaining pages still indexed
      expect(batches[0].documents).toHaveLength(2);
      expect(batches[0].documents[0].content).toContain("Good content");
      expect(batches[0].documents[1].content).toContain("More content");
      // page-2 failure recorded
      expect(batches[0].failures).toHaveLength(1);
      const failures = batches[0].failures ?? [];
      expect(failures[0]?.itemId).toBe("page-2");
    });

    it("throws when search endpoint returns error", async () => {
      const connector = new NotionConnector();
      vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
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
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
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
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
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
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
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
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
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

  describe("sync — database mode (databaseIds provided)", () => {
    it("queries /databases/:id/query instead of /search", async () => {
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const page = makePage("page-1", "DB Page");
      fetchMock.mockResolvedValueOnce(makeDatabaseQueryResponse([page]));
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["DB content"]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { databaseIds: ["db-abc"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].content).toContain("DB content");

      // First call must be the database query endpoint, not /search
      const firstCallUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
      expect(firstCallUrl).toContain("/databases/db-abc/query");
      expect(firstCallUrl).not.toContain("/search");
    });

    it("sends last_edited_time filter when checkpoint is present", async () => {
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const page = makePage("page-1", "Changed Page", {
        lastEditedTime: "2024-02-01T00:00:00.000Z",
      });
      fetchMock.mockResolvedValueOnce(makeDatabaseQueryResponse([page]));
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["New content"]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { databaseIds: ["db-abc"] },
        credentials,
        checkpoint: {
          type: "notion",
          lastSyncedAt: "2024-01-15T12:00:00.000Z",
        },
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);

      // Verify the request body includes the last_edited_time filter
      const requestBody = JSON.parse(
        (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1]
          .body,
      );
      expect(requestBody.filter).toBeDefined();
      expect(requestBody.filter.timestamp).toBe("last_edited_time");
      expect(requestBody.filter.last_edited_time.after).toBeDefined();
    });

    it("does not send filter on first sync (no checkpoint)", async () => {
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      fetchMock.mockResolvedValueOnce(makeDatabaseQueryResponse([]));

      for await (const _ of connector.sync({
        config: { databaseIds: ["db-abc"] },
        credentials,
        checkpoint: null,
      })) {
        // consume
      }

      const requestBody = JSON.parse(
        (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1]
          .body,
      );
      expect(requestBody.filter).toBeUndefined();
    });

    it("syncs multiple databases in sequence", async () => {
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const pageA = makePage("page-a", "DB A Page");
      const pageB = makePage("page-b", "DB B Page");

      // DB 1 query
      fetchMock.mockResolvedValueOnce(makeDatabaseQueryResponse([pageA]));
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["Content A"]));
      // DB 2 query
      fetchMock.mockResolvedValueOnce(makeDatabaseQueryResponse([pageB]));
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["Content B"]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { databaseIds: ["db-1", "db-2"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].hasMore).toBe(true); // more databases to go
      expect(batches[1].hasMore).toBe(false); // last database done
      expect(batches[0].documents[0].id).toBe("page-a");
      expect(batches[1].documents[0].id).toBe("page-b");

      const firstUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
      const thirdUrl = (fetchMock.mock.calls[2] as unknown[])[0] as string;
      expect(firstUrl).toContain("/databases/db-1/query");
      expect(thirdUrl).toContain("/databases/db-2/query");
    });

    it("paginates within a database using cursor", async () => {
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const page1 = makePage("page-1", "First");
      const page2 = makePage("page-2", "Second");

      fetchMock.mockResolvedValueOnce(
        makeDatabaseQueryResponse([page1], {
          hasMore: true,
          nextCursor: "cursor-xyz",
        }),
      );
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["First content"]));
      fetchMock.mockResolvedValueOnce(makeDatabaseQueryResponse([page2]));
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["Second content"]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { databaseIds: ["db-1"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].documents[0].id).toBe("page-1");
      expect(batches[1].documents[0].id).toBe("page-2");

      // Second call should include the cursor from the first response
      const secondCallBody = JSON.parse(
        (fetchMock.mock.calls[2] as unknown as [string, { body: string }])[1]
          .body,
      );
      expect(secondCallBody.start_cursor).toBe("cursor-xyz");
    });

    it("throws when database query returns error", async () => {
      const connector = new NotionConnector();
      vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      ).mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "Forbidden",
      } as unknown as Response);

      const generator = connector.sync({
        config: { databaseIds: ["db-secret"] },
        credentials,
        checkpoint: null,
      });

      await expect(generator.next()).rejects.toThrow(
        "Notion database query failed",
      );
    });
  });

  describe("sync — specific pages mode (pageIds provided)", () => {
    it("yields documents for specific pageIds", async () => {
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const page1 = makePage("page-aaa", "Page AAA");
      const page2 = makePage("page-bbb", "Page BBB");

      fetchMock.mockResolvedValueOnce(makePageResponse(page1));
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["Content AAA"]));
      fetchMock.mockResolvedValueOnce(makePageResponse(page2));
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
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Not found",
      } as unknown as Response);

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

    it("skips block content fetch for unchanged pages when checkpoint is present", async () => {
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      // checkpoint is 2024-01-15T12:00:00Z, safety buffer → cutoff 2024-01-15T11:55:00Z
      const checkpoint = {
        type: "notion",
        lastSyncedAt: "2024-01-15T12:00:00.000Z",
      };

      const oldPage = makePage("old-page", "Unchanged", {
        lastEditedTime: "2024-01-10T00:00:00.000Z",
      });
      const newPage = makePage("new-page", "Changed", {
        lastEditedTime: "2024-01-20T00:00:00.000Z",
      });

      // page fetches for both, blocks only for new-page
      fetchMock.mockResolvedValueOnce(makePageResponse(oldPage));
      fetchMock.mockResolvedValueOnce(makePageResponse(newPage));
      fetchMock.mockResolvedValueOnce(makeBlocksResponse(["New content"]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { pageIds: ["old-page", "new-page"] },
        credentials,
        checkpoint,
      })) {
        batches.push(batch);
      }

      // Unchanged page is skipped entirely to avoid overwriting stored content
      // with a title-only document. Only the changed page is returned.
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].content).toContain("New content");
      // fetchWithRetry: 2 page fetches + 1 blocks fetch = 3 total
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("produces correct markdown content from block types", async () => {
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const page = makePage("page-1", "Formatted Page");
      fetchMock.mockResolvedValueOnce(makePageResponse(page));

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          type: "block",
          block: {},
          object: "list",
          next_cursor: null,
          has_more: false,
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

    it("paginates block children when response has more pages", async () => {
      const connector = new NotionConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const page = makePage("page-1", "Long Page");
      fetchMock.mockResolvedValueOnce(makePageResponse(page));

      // First blocks page — has_more=true
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          object: "list",
          type: "block",
          block: {},
          results: [
            {
              object: "block",
              id: "b1",
              type: "paragraph",
              has_children: false,
              paragraph: { rich_text: [{ plain_text: "First batch" }] },
            },
          ],
          has_more: true,
          next_cursor: "block-cursor-abc",
        }),
      } as unknown as Response);

      // Second blocks page — final
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          object: "list",
          type: "block",
          block: {},
          results: [
            {
              object: "block",
              id: "b2",
              type: "paragraph",
              has_children: false,
              paragraph: { rich_text: [{ plain_text: "Second batch" }] },
            },
          ],
          has_more: false,
          next_cursor: null,
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
      expect(content).toContain("First batch");
      expect(content).toContain("Second batch");

      // Verify pagination cursor was used in second blocks call
      const thirdCallUrl = (fetchMock.mock.calls[2] as unknown[])[0] as string;
      expect(thirdCallUrl).toContain("start_cursor=block-cursor-abc");
    });
  });

  describe("sync — invalid config", () => {
    it("throws when config is invalid", async () => {
      const connector = new NotionConnector();

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
