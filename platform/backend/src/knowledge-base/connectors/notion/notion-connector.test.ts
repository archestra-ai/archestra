import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { NotionConnector } from "./notion-connector";

// Mock global fetch
const mockFetch = vi.fn();

vi.stubGlobal("fetch", mockFetch);

const NOTION_API_BASE = "https://api.notion.com/v1";

function mockResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  } as unknown as Response);
}

describe("NotionConnector", () => {
  let connector: NotionConnector;

  const credentials = {
    apiToken: "secret_test-token",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new NotionConnector();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("validateConfig", () => {
    test("returns valid for empty config (auth only)", async () => {
      const result = await connector.validateConfig({});
      expect(result).toEqual({ valid: true });
    });

    test("returns valid when databaseIds is provided", async () => {
      const result = await connector.validateConfig({
        databaseIds: ["abc123"],
      });
      expect(result).toEqual({ valid: true });
    });

    test("returns valid when pageIds is provided", async () => {
      const result = await connector.validateConfig({
        pageIds: ["page-id-1", "page-id-2"],
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
  });

  describe("testConnection", () => {
    test("returns success when search API returns 200", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ results: [], has_more: false }),
      );

      const result = await connector.testConnection({
        config: {},
        credentials,
      });

      expect(result).toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledWith(
        `${NOTION_API_BASE}/search`,
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer secret_test-token",
            "Notion-Version": "2022-06-28",
          }),
          body: JSON.stringify({
            query: "",
            page_size: 1,
            filter: { property: "object", value: "page" },
          }),
        }),
      );
    });

    test("returns error when API returns non-200", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ message: "Unauthorized" }, 401),
      );

      const result = await connector.testConnection({
        config: {},
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unauthorized");
    });

    test("returns error when fetch throws", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await connector.testConnection({
        config: {},
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Network error");
    });
  });

  describe("sync", () => {
    test("yields documents for explicit pageIds", async () => {
      // Mock page fetch
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          id: "page-123",
          url: "https://notion.so/page-123",
          properties: {
            title: {
              type: "title",
              title: [{ plain_text: "Test Page" }],
            },
            last_edited_time: "2026-03-27T00:00:00.000Z",
          },
        }),
      );

      // Mock block children fetch
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          results: [
            {
              id: "block-1",
              type: "paragraph",
              has_children: false,
              paragraph: {
                rich_text: [{ plain_text: "Hello world", annotations: {} }],
              },
            },
          ],
          has_more: false,
        }),
      );

      const generator = connector.sync({
        config: { pageIds: ["page-123"] },
        credentials,
        checkpoint: null,
      });

      const batch = await generator.next();

      expect(batch.value).toMatchObject({
        documents: [
          expect.objectContaining({
            id: "page-123",
            title: "Test Page",
            content: "Hello world",
            metadata: expect.objectContaining({ kind: "notion_page" }),
          }),
        ],
        hasMore: false,
      });
    });

    test("yields documents for full workspace search", async () => {
      // Mock search response
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          results: [
            {
              id: "workspace-page-1",
              last_edited_time: "2026-03-27T00:00:00.000Z",
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
      );

      // Mock page fetch
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          id: "workspace-page-1",
          url: "https://notion.so/workspace-page-1",
          properties: {
            title: {
              type: "title",
              title: [{ plain_text: "Workspace Page" }],
            },
            last_edited_time: "2026-03-27T00:00:00.000Z",
          },
        }),
      );

      // Mock block children fetch
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          results: [],
          has_more: false,
        }),
      );

      const generator = connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      });

      const batch = await generator.next();

      expect(batch.value).toMatchObject({
        documents: [
          expect.objectContaining({
            id: "workspace-page-1",
            title: "Workspace Page",
          }),
        ],
      });
    });

    test("yields documents for specific database", async () => {
      // Mock database query
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          results: [
            {
              id: "db-page-1",
              last_edited_time: "2026-03-27T00:00:00.000Z",
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
      );

      // Mock page fetch
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          id: "db-page-1",
          url: "https://notion.so/db-page-1",
          properties: {
            Name: {
              type: "title",
              title: [{ plain_text: "Database Entry" }],
            },
            last_edited_time: "2026-03-27T00:00:00.000Z",
          },
        }),
      );

      // Mock block children fetch
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          results: [
            {
              id: "heading-block",
              type: "heading_1",
              has_children: false,
              heading_1: {
                rich_text: [{ plain_text: "My Heading", annotations: {} }],
              },
            },
          ],
          has_more: false,
        }),
      );

      const generator = connector.sync({
        config: { databaseIds: ["database-abc"] },
        credentials,
        checkpoint: null,
      });

      const batch = await generator.next();

      expect(batch.value).toMatchObject({
        documents: [
          expect.objectContaining({
            id: "db-page-1",
            title: "Database Entry",
            content: "# My Heading",
          }),
        ],
      });
    });

    test("skips pages with no title", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          id: "untitled-page",
          url: "https://notion.so/untitled-page",
          properties: {},
          last_edited_time: "2026-03-27T00:00:00.000Z",
        }),
      );

      mockFetch.mockResolvedValueOnce(
        mockResponse({
          results: [],
          has_more: false,
        }),
      );

      const generator = connector.sync({
        config: { pageIds: ["untitled-page"] },
        credentials,
        checkpoint: null,
      });

      const batch = await generator.next();

      expect(batch.value.documents[0].title).toBe("Notion Page untitled-page");
    });
  });

  describe("markdown conversion", () => {
    async function getSingleBatchContent(blocks: unknown[]) {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          id: "test-page",
          url: "https://notion.so/test-page",
          properties: {
            title: {
              type: "title",
              title: [{ plain_text: "Test" }],
            },
            last_edited_time: "2026-03-27T00:00:00.000Z",
          },
        }),
      );

      mockFetch.mockResolvedValueOnce(
        mockResponse({ results: blocks, has_more: false }),
      );

      const generator = connector.sync({
        config: { pageIds: ["test-page"] },
        credentials,
        checkpoint: null,
      });

      const { value } = await generator.next();
      return value.documents[0]?.content ?? "";
    }

    test("converts heading_1", async () => {
      const content = await getSingleBatchContent([
        {
          id: "b1",
          type: "heading_1",
          has_children: false,
          heading_1: { rich_text: [{ plain_text: "Title", annotations: {} }] },
        },
      ]);
      expect(content).toBe("# Title");
    });

    test("converts heading_2", async () => {
      const content = await getSingleBatchContent([
        {
          id: "b1",
          type: "heading_2",
          has_children: false,
          heading_2: { rich_text: [{ plain_text: "Subtitle", annotations: {} }] },
        },
      ]);
      expect(content).toBe("## Subtitle");
    });

    test("converts heading_3", async () => {
      const content = await getSingleBatchContent([
        {
          id: "b1",
          type: "heading_3",
          has_children: false,
          heading_3: { rich_text: [{ plain_text: "Sub-subtitle", annotations: {} }] },
        },
      ]);
      expect(content).toBe("### Sub-subtitle");
    });

    test("converts paragraph", async () => {
      const content = await getSingleBatchContent([
        {
          id: "b1",
          type: "paragraph",
          has_children: false,
          paragraph: {
            rich_text: [{ plain_text: "Some text", annotations: {} }],
          },
        },
      ]);
      expect(content).toBe("Some text");
    });

    test("converts bulleted_list_item", async () => {
      const content = await getSingleBatchContent([
        {
          id: "b1",
          type: "bulleted_list_item",
          has_children: false,
          bulleted_list_item: {
            rich_text: [{ plain_text: "Item 1", annotations: {} }],
          },
        },
      ]);
      expect(content).toBe("- Item 1");
    });

    test("converts numbered_list_item", async () => {
      const content = await getSingleBatchContent([
        {
          id: "b1",
          type: "numbered_list_item",
          has_children: false,
          numbered_list_item: {
            rich_text: [{ plain_text: "First", annotations: {} }],
          },
        },
      ]);
      expect(content).toBe("1. First");
    });

    test("converts to_do with checked state", async () => {
      const content = await getSingleBatchContent([
        {
          id: "b1",
          type: "to_do",
          has_children: false,
          to_do: {
            rich_text: [{ plain_text: "Done task", annotations: {} }],
            checked: true,
          },
        },
      ]);
      expect(content).toBe("- [x] Done task");
    });

    test("converts to_do unchecked", async () => {
      const content = await getSingleBatchContent([
        {
          id: "b1",
          type: "to_do",
          has_children: false,
          to_do: {
            rich_text: [{ plain_text: "Pending", annotations: {} }],
            checked: false,
          },
        },
      ]);
      expect(content).toBe("- [ ] Pending");
    });

    test("converts quote", async () => {
      const content = await getSingleBatchContent([
        {
          id: "b1",
          type: "quote",
          has_children: false,
          quote: { rich_text: [{ plain_text: "A quote", annotations: {} }] },
        },
      ]);
      expect(content).toBe("> A quote");
    });

    test("converts code block with language", async () => {
      const content = await getSingleBatchContent([
        {
          id: "b1",
          type: "code",
          has_children: false,
          code: {
            language: "typescript",
            rich_text: [{ plain_text: "const x = 1", annotations: {} }],
          },
        },
      ]);
      expect(content).toBe("```typescript\nconst x = 1\n```");
    });

    test("converts divider", async () => {
      const content = await getSingleBatchContent([
        {
          id: "b1",
          type: "divider",
          has_children: false,
        },
      ]);
      expect(content).toBe("---");
    });

    test("converts image with external URL", async () => {
      const content = await getSingleBatchContent([
        {
          id: "b1",
          type: "image",
          has_children: false,
          image: {
            type: "external",
            external: { url: "https://example.com/img.png" },
            caption: [],
          },
        },
      ]);
      expect(content).toBe("![](https://example.com/img.png)");
    });

    test("converts image with caption", async () => {
      const content = await getSingleBatchContent([
        {
          id: "b1",
          type: "image",
          has_children: false,
          image: {
            type: "external",
            external: { url: "https://example.com/img.png" },
            caption: [{ plain_text: "My Image", annotations: {} }],
          },
        },
      ]);
      expect(content).toBe("![My Image](https://example.com/img.png)");
    });

    test("applies bold annotation", async () => {
      const content = await getSingleBatchContent([
        {
          id: "b1",
          type: "paragraph",
          has_children: false,
          paragraph: {
            rich_text: [
              { plain_text: "bold text", annotations: { bold: true } },
            ],
          },
        },
      ]);
      expect(content).toBe("**bold text**");
    });

    test("applies italic annotation", async () => {
      const content = await getSingleBatchContent([
        {
          id: "b1",
          type: "paragraph",
          has_children: false,
          paragraph: {
            rich_text: [
              { plain_text: "italic text", annotations: { italic: true } },
            ],
          },
        },
      ]);
      expect(content).toBe("*italic text*");
    });

    test("applies code annotation", async () => {
      const content = await getSingleBatchContent([
        {
          id: "b1",
          type: "paragraph",
          has_children: false,
          paragraph: {
            rich_text: [
              { plain_text: "inline code", annotations: { code: true } },
            ],
          },
        },
      ]);
      expect(content).toBe("`inline code`");
    });

    test("applies strikethrough annotation", async () => {
      const content = await getSingleBatchContent([
        {
          id: "b1",
          type: "paragraph",
          has_children: false,
          paragraph: {
            rich_text: [
              {
                plain_text: "deleted text",
                annotations: { strikethrough: true },
              },
            ],
          },
        },
      ]);
      expect(content).toBe("~~deleted text~~");
    });

    test("converts nested blocks recursively", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          id: "test-page",
          url: "https://notion.so/test-page",
          properties: {
            title: {
              type: "title",
              title: [{ plain_text: "Test" }],
            },
            last_edited_time: "2026-03-27T00:00:00.000Z",
          },
        }),
      );

      mockFetch.mockResolvedValueOnce(
        mockResponse({
          results: [
            {
              id: "toggle-block",
              type: "toggle",
              has_children: true,
              toggle: {
                rich_text: [{ plain_text: "Toggle section", annotations: {} }],
              },
            },
          ],
          has_more: false,
        }),
      );

      // Child blocks of toggle
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          results: [
            {
              id: "child-para",
              type: "paragraph",
              has_children: false,
              paragraph: {
                rich_text: [{ plain_text: "Nested content", annotations: {} }],
              },
            },
          ],
          has_more: false,
        }),
      );

      const generator = connector.sync({
        config: { pageIds: ["test-page"] },
        credentials,
        checkpoint: null,
      });

      const { value } = await generator.next();
      expect(value.documents[0]?.content).toContain("**Toggle:** Toggle section");
      expect(value.documents[0]?.content).toContain("Nested content");
    });

    test("skips child_database and child_page blocks", async () => {
      const content = await getSingleBatchContent([
        {
          id: "b1",
          type: "child_database",
          has_children: false,
          child_database: { title: "My Database" },
        },
        {
          id: "b2",
          type: "child_page",
          has_children: false,
          child_page: { title: "Linked Page" },
        },
      ]);
      expect(content).not.toContain("My Database");
      expect(content).not.toContain("Linked Page");
    });
  });
});
