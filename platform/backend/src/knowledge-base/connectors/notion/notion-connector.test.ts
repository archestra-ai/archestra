import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { ConnectorSyncBatch } from "@/types";
import { NotionConnector } from "./notion-connector";
import { blockToMarkdown, richTextToPlain } from "./notion-connector";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("NotionConnector", () => {
  let connector: NotionConnector;

  const credentials = {
    apiToken: "secret_test-token-123",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new NotionConnector();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ===== Helper factories =====

  function makePage(
    id: string,
    title: string,
    opts?: { lastEditedTime?: string; parentType?: string; parentId?: string },
  ) {
    return {
      object: "page",
      id,
      url: `https://www.notion.so/${id.replace(/-/g, "")}`,
      created_time: "2024-01-01T00:00:00.000Z",
      last_edited_time: opts?.lastEditedTime ?? "2024-06-15T10:00:00.000Z",
      created_by: { id: "user-1" },
      last_edited_by: { id: "user-2" },
      parent: {
        type: opts?.parentType ?? "workspace",
        workspace: true,
        ...(opts?.parentId && opts?.parentType === "database_id"
          ? { database_id: opts.parentId }
          : {}),
      },
      properties: {
        title: {
          type: "title",
          title: [{ plain_text: title }],
        },
      },
    };
  }

  function makeBlocksResponse(
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    blocks: any[],
    hasMore = false,
    nextCursor?: string,
  ) {
    return {
      object: "list",
      results: blocks,
      has_more: hasMore,
      next_cursor: nextCursor ?? null,
    };
  }

  function makeSearchResponse(
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    results: any[],
    hasMore = false,
    nextCursor?: string,
  ) {
    return {
      object: "list",
      results,
      has_more: hasMore,
      next_cursor: nextCursor ?? null,
    };
  }

  function mockJsonResponse(data: unknown, status = 200) {
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    });
  }

  function mockErrorResponse(status: number, body = "Error") {
    return Promise.resolve({
      ok: false,
      status,
      json: () => Promise.resolve({ message: body }),
      text: () => Promise.resolve(body),
    });
  }

  // ===== validateConfig =====

  describe("validateConfig", () => {
    test("returns valid for minimal config (empty object)", async () => {
      const result = await connector.validateConfig({});
      expect(result).toEqual({ valid: true });
    });

    test("returns valid with databaseIds", async () => {
      const result = await connector.validateConfig({
        databaseIds: ["db-1", "db-2"],
      });
      expect(result).toEqual({ valid: true });
    });

    test("returns valid with pageIds", async () => {
      const result = await connector.validateConfig({
        pageIds: ["page-1"],
      });
      expect(result).toEqual({ valid: true });
    });

    test("returns valid with both databaseIds and pageIds", async () => {
      const result = await connector.validateConfig({
        databaseIds: ["db-1"],
        pageIds: ["page-1"],
      });
      expect(result).toEqual({ valid: true });
    });

    test("returns invalid for wrong type field", async () => {
      const result = await connector.validateConfig({
        type: "jira",
      });
      expect(result.valid).toBe(false);
    });
  });

  // ===== testConnection =====

  describe("testConnection", () => {
    test("returns success when API responds OK", async () => {
      mockFetch.mockReturnValueOnce(
        mockJsonResponse({ object: "user", id: "bot-user", type: "bot" }),
      );

      const result = await connector.testConnection({
        config: {},
        credentials,
      });

      expect(result).toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.notion.com/v1/users/me",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer secret_test-token-123",
            "Notion-Version": "2022-06-28",
          }),
        }),
      );
    });

    test("returns error when API returns 401", async () => {
      mockFetch.mockReturnValueOnce(
        mockErrorResponse(401, "Invalid token"),
      );

      const result = await connector.testConnection({
        config: {},
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("401");
    });

    test("returns error when network fails", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await connector.testConnection({
        config: {},
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Network error");
    });

    test("returns error for invalid config", async () => {
      const result = await connector.testConnection({
        config: { type: "jira" },
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid Notion configuration");
    });
  });

  // ===== sync — search mode =====

  describe("sync (search mode)", () => {
    test("yields batch of documents from search", async () => {
      const pages = [
        makePage("page-1", "First Page"),
        makePage("page-2", "Second Page"),
      ];

      // Search
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeSearchResponse(pages)),
      );
      // Blocks for page-1
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(
          makeBlocksResponse([
            {
              id: "b1",
              type: "paragraph",
              paragraph: {
                rich_text: [{ plain_text: "Hello world" }],
              },
              has_children: false,
            },
          ]),
        ),
      );
      // Blocks for page-2
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(
          makeBlocksResponse([
            {
              id: "b2",
              type: "heading_1",
              heading_1: {
                rich_text: [{ plain_text: "Introduction" }],
              },
              has_children: false,
            },
          ]),
        ),
      );

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
      expect(batches[0].documents[1].content).toContain("# Introduction");
      expect(batches[0].hasMore).toBe(false);
    });

    test("paginates through multiple search pages", async () => {
      const page1 = [makePage("page-1", "Page 1")];
      const page2 = [makePage("page-2", "Page 2")];

      // First search page
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeSearchResponse(page1, true, "cursor-1")),
      );
      // Blocks for page-1
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeBlocksResponse([])),
      );
      // Second search page
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeSearchResponse(page2, false)),
      );
      // Blocks for page-2
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeBlocksResponse([])),
      );

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
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[1].hasMore).toBe(false);
      expect(batches[1].documents).toHaveLength(1);
    });

    test("filters non-page results from search", async () => {
      const results = [
        makePage("page-1", "A Page"),
        { object: "database", id: "db-1" },
      ];

      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeSearchResponse(results)),
      );
      // Blocks for page-1
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeBlocksResponse([])),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].id).toBe("page-1");
    });

    test("uses checkpoint for incremental sync", async () => {
      const oldPage = makePage("page-old", "Old Page", {
        lastEditedTime: "2024-01-01T00:00:00.000Z",
      });
      const newPage = makePage("page-new", "New Page", {
        lastEditedTime: "2024-06-20T10:00:00.000Z",
      });

      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeSearchResponse([oldPage, newPage])),
      );
      // Blocks for new page only (old one is filtered out)
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeBlocksResponse([])),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: {
          type: "notion",
          lastSyncedAt: "2024-06-01T00:00:00.000Z",
        },
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].id).toBe("page-new");
    });

    test("checkpoint uses last item timestamp", async () => {
      const page = makePage("page-1", "Test", {
        lastEditedTime: "2024-06-20T15:30:00.000Z",
      });

      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeSearchResponse([page])),
      );
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeBlocksResponse([])),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const cp = batches[0].checkpoint as { lastSyncedAt?: string };
      expect(cp.lastSyncedAt).toBe("2024-06-20T15:30:00.000Z");
    });

    test("checkpoint preserves previous value when batch has no items", async () => {
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeSearchResponse([])),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: {
          type: "notion",
          lastSyncedAt: "2024-01-10T00:00:00.000Z",
        },
      })) {
        batches.push(batch);
      }

      const cp = batches[0].checkpoint as { lastSyncedAt?: string };
      expect(cp.lastSyncedAt).toBe("2024-01-10T00:00:00.000Z");
    });

    test("includes sourceUrl in documents", async () => {
      const page = makePage("abc-def-123", "Test Page");

      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeSearchResponse([page])),
      );
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeBlocksResponse([])),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents[0].sourceUrl).toContain("notion.so");
    });

    test("includes metadata in documents", async () => {
      const page = makePage("page-1", "Test", {
        lastEditedTime: "2024-06-15T10:00:00.000Z",
      });

      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeSearchResponse([page])),
      );
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeBlocksResponse([])),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const metadata = batches[0].documents[0].metadata;
      expect(metadata.pageId).toBe("page-1");
      expect(metadata.parentType).toBe("workspace");
      expect(metadata.createdBy).toBe("user-1");
      expect(metadata.lastEditedBy).toBe("user-2");
    });

    test("continues sync when content fetch fails for one page", async () => {
      const pages = [
        makePage("page-1", "First"),
        makePage("page-2", "Second"),
        makePage("page-3", "Third"),
      ];

      // Search
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeSearchResponse(pages)),
      );
      // Blocks for page-1 — success
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(
          makeBlocksResponse([
            {
              id: "b1",
              type: "paragraph",
              paragraph: { rich_text: [{ plain_text: "Content 1" }] },
              has_children: false,
            },
          ]),
        ),
      );
      // Blocks for page-2 — failure
      mockFetch.mockReturnValueOnce(mockErrorResponse(500, "Server Error"));
      // Blocks for page-3 — success
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(
          makeBlocksResponse([
            {
              id: "b3",
              type: "paragraph",
              paragraph: { rich_text: [{ plain_text: "Content 3" }] },
              has_children: false,
            },
          ]),
        ),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // All 3 pages should be in documents
      expect(batches[0].documents).toHaveLength(3);
      expect(batches[0].documents[0].content).toContain("Content 1");
      // page-2 has empty content (fallback)
      expect(batches[0].documents[1].content).toBe("# Second");
      expect(batches[0].documents[2].content).toContain("Content 3");

      // Failures array should have 1 entry
      expect(batches[0].failures).toHaveLength(1);
      expect(batches[0].failures?.[0].itemId).toBe("page-2");
      expect(batches[0].failures?.[0].resource).toBe("blocks");
    });

    test("throws on search API error", async () => {
      mockFetch.mockReturnValueOnce(
        mockErrorResponse(403, "Forbidden"),
      );

      const generator = connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      });

      await expect(generator.next()).rejects.toThrow("Notion search failed");
    });
  });

  // ===== sync — specific pages mode =====

  describe("sync (specific pages mode)", () => {
    test("fetches specific pages by ID", async () => {
      const page = makePage("page-abc", "Specific Page");

      // Fetch page
      mockFetch.mockReturnValueOnce(mockJsonResponse(page));
      // Blocks
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(
          makeBlocksResponse([
            {
              id: "b1",
              type: "paragraph",
              paragraph: { rich_text: [{ plain_text: "Direct content" }] },
              has_children: false,
            },
          ]),
        ),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { pageIds: ["page-abc"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("Specific Page");
      expect(batches[0].documents[0].content).toContain("Direct content");
      expect(batches[0].hasMore).toBe(false);
    });

    test("skips pages that return 404", async () => {
      const existingPage = makePage("page-exists", "Existing");

      // First page: 404
      mockFetch.mockReturnValueOnce(mockErrorResponse(404, "Not found"));
      // Second page: success
      mockFetch.mockReturnValueOnce(mockJsonResponse(existingPage));
      // Blocks for second page
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeBlocksResponse([])),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { pageIds: ["page-missing", "page-exists"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].id).toBe("page-exists");
    });
  });

  // ===== sync — database mode =====

  describe("sync (database mode)", () => {
    test("queries specific databases", async () => {
      const page = makePage("page-in-db", "DB Page", {
        parentType: "database_id",
        parentId: "db-1",
      });

      // Database query
      mockFetch.mockReturnValueOnce(
        mockJsonResponse({
          results: [page],
          has_more: false,
        }),
      );
      // Blocks
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeBlocksResponse([])),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { databaseIds: ["db-1"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("DB Page");
      expect(batches[0].hasMore).toBe(false);

      // Verify the correct API endpoint was called
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.notion.com/v1/databases/db-1/query",
        expect.objectContaining({ method: "POST" }),
      );
    });

    test("paginates through database results", async () => {
      const page1 = makePage("page-1", "Page 1");
      const page2 = makePage("page-2", "Page 2");

      // First query page
      mockFetch.mockReturnValueOnce(
        mockJsonResponse({
          results: [page1],
          has_more: true,
          next_cursor: "cursor-1",
        }),
      );
      // Blocks for page-1
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeBlocksResponse([])),
      );
      // Second query page
      mockFetch.mockReturnValueOnce(
        mockJsonResponse({
          results: [page2],
          has_more: false,
        }),
      );
      // Blocks for page-2
      mockFetch.mockReturnValueOnce(
        mockJsonResponse(makeBlocksResponse([])),
      );

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
      expect(batches[0].hasMore).toBe(true);
      expect(batches[1].documents[0].id).toBe("page-2");
      expect(batches[1].hasMore).toBe(false);
    });

    test("incremental sync passes filter to database query", async () => {
      mockFetch.mockReturnValueOnce(
        mockJsonResponse({ results: [], has_more: false }),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { databaseIds: ["db-1"] },
        credentials,
        checkpoint: {
          type: "notion",
          lastSyncedAt: "2024-06-01T00:00:00.000Z",
        },
      })) {
        batches.push(batch);
      }

      // Verify the filter was passed in the request body
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.filter).toEqual({
        timestamp: "last_edited_time",
        last_edited_time: { on_or_after: "2024-06-01T00:00:00.000Z" },
      });
    });
  });

  // ===== blockToMarkdown =====

  describe("blockToMarkdown", () => {
    test("converts paragraph", () => {
      const block = {
        type: "paragraph",
        paragraph: { rich_text: [{ plain_text: "Hello world" }] },
      };
      expect(blockToMarkdown(block)).toBe("Hello world\n");
    });

    test("converts headings", () => {
      expect(
        blockToMarkdown({
          type: "heading_1",
          heading_1: { rich_text: [{ plain_text: "H1" }] },
        }),
      ).toBe("# H1\n");

      expect(
        blockToMarkdown({
          type: "heading_2",
          heading_2: { rich_text: [{ plain_text: "H2" }] },
        }),
      ).toBe("## H2\n");

      expect(
        blockToMarkdown({
          type: "heading_3",
          heading_3: { rich_text: [{ plain_text: "H3" }] },
        }),
      ).toBe("### H3\n");
    });

    test("converts bulleted list item", () => {
      const block = {
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [{ plain_text: "Item" }],
        },
      };
      expect(blockToMarkdown(block)).toBe("- Item");
    });

    test("converts numbered list item", () => {
      const block = {
        type: "numbered_list_item",
        numbered_list_item: {
          rich_text: [{ plain_text: "Step" }],
        },
      };
      expect(blockToMarkdown(block)).toBe("1. Step");
    });

    test("converts to_do with checked state", () => {
      expect(
        blockToMarkdown({
          type: "to_do",
          to_do: {
            rich_text: [{ plain_text: "Done" }],
            checked: true,
          },
        }),
      ).toBe("- [x] Done");

      expect(
        blockToMarkdown({
          type: "to_do",
          to_do: {
            rich_text: [{ plain_text: "Pending" }],
            checked: false,
          },
        }),
      ).toBe("- [ ] Pending");
    });

    test("converts quote", () => {
      const block = {
        type: "quote",
        quote: { rich_text: [{ plain_text: "A wise quote" }] },
      };
      expect(blockToMarkdown(block)).toBe("> A wise quote\n");
    });

    test("converts code block with language", () => {
      const block = {
        type: "code",
        code: {
          rich_text: [{ plain_text: "const x = 1;" }],
          language: "typescript",
        },
      };
      expect(blockToMarkdown(block)).toBe(
        "```typescript\nconst x = 1;\n```\n",
      );
    });

    test("converts divider", () => {
      expect(blockToMarkdown({ type: "divider", divider: {} })).toBe("---\n");
    });

    test("converts callout", () => {
      const block = {
        type: "callout",
        callout: { rich_text: [{ plain_text: "Important note" }] },
      };
      expect(blockToMarkdown(block)).toBe("> Important note\n");
    });

    test("converts image with external URL", () => {
      const block = {
        type: "image",
        image: {
          external: { url: "https://example.com/img.png" },
          caption: [{ plain_text: "My image" }],
        },
      };
      expect(blockToMarkdown(block)).toBe(
        "![My image](https://example.com/img.png)\n",
      );
    });

    test("converts bookmark", () => {
      const block = {
        type: "bookmark",
        bookmark: {
          url: "https://example.com",
          caption: [{ plain_text: "Example" }],
        },
      };
      expect(blockToMarkdown(block)).toBe(
        "[Example](https://example.com)\n",
      );
    });

    test("converts equation", () => {
      const block = {
        type: "equation",
        equation: { expression: "E = mc^2" },
      };
      expect(blockToMarkdown(block)).toBe("$$E = mc^2$$\n");
    });

    test("returns empty string for empty paragraph", () => {
      const block = {
        type: "paragraph",
        paragraph: { rich_text: [] },
      };
      expect(blockToMarkdown(block)).toBe("");
    });

    test("returns empty string for unknown block type with no text", () => {
      const block = { type: "unsupported_block", unsupported_block: {} };
      expect(blockToMarkdown(block)).toBe("");
    });
  });

  // ===== richTextToPlain =====

  describe("richTextToPlain", () => {
    test("concatenates multiple rich text segments", () => {
      const richText = [
        { plain_text: "Hello " },
        { plain_text: "world" },
      ];
      expect(richTextToPlain(richText)).toBe("Hello world");
    });

    test("returns empty string for undefined", () => {
      expect(richTextToPlain(undefined)).toBe("");
    });

    test("returns empty string for empty array", () => {
      expect(richTextToPlain([])).toBe("");
    });
  });
});
