import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type {
  ConfluencePage,
  ConfluenceSearchResponse,
} from "@/types/knowledge-connectors/confluence";
import type { ConnectorSyncBatch } from "@/types/knowledge-connectors/connector";
import { ConfluenceConnector, stripHtmlTags } from "./confluence-connector";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("ConfluenceConnector", () => {
  let connector: ConfluenceConnector;

  const validConfig = {
    confluenceUrl: "https://mysite.atlassian.net",
    isCloud: true,
    spaceKeys: ["DEV"],
  };

  const credentials = {
    email: "user@example.com",
    apiToken: "test-api-token",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new ConfluenceConnector();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("validateConfig", () => {
    test("returns valid for correct config", async () => {
      const result = await connector.validateConfig(validConfig);
      expect(result).toEqual({ valid: true });
    });

    test("returns invalid when confluenceUrl is missing", async () => {
      const result = await connector.validateConfig({ isCloud: true });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("confluenceUrl");
    });

    test("returns invalid when isCloud is missing", async () => {
      const result = await connector.validateConfig({
        confluenceUrl: "https://mysite.atlassian.net",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("isCloud");
    });

    test("returns invalid when confluenceUrl is not a valid URL", async () => {
      const result = await connector.validateConfig({
        confluenceUrl: "not-a-url",
        isCloud: true,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("valid HTTP(S) URL");
    });

    test("accepts server config with isCloud false", async () => {
      const result = await connector.validateConfig({
        confluenceUrl: "https://confluence.mycompany.com",
        isCloud: false,
      });
      expect(result).toEqual({ valid: true });
    });
  });

  describe("testConnection", () => {
    test("returns success when API responds OK", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      });

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result).toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://mysite.atlassian.net/wiki/rest/api/space?limit=1",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: expect.stringContaining("Basic "),
          }),
        }),
      );
    });

    test("uses correct path for server instances", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      });

      await connector.testConnection({
        config: { ...validConfig, isCloud: false },
        credentials,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://mysite.atlassian.net/rest/api/space?limit=1",
        expect.anything(),
      );
    });

    test("returns error when API responds with error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("401");
    });

    test("returns error for invalid config", async () => {
      const result = await connector.testConnection({
        config: {},
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid Confluence configuration");
    });
  });

  describe("sync", () => {
    function makePage(
      id: string,
      title: string,
      bodyHtml = "<p>Page content</p>",
    ): ConfluencePage {
      return {
        id,
        title,
        status: "current",
        body: { storage: { value: bodyHtml } },
        metadata: { labels: { results: [] } },
        version: { when: "2024-01-15T10:00:00.000Z" },
        _links: { webui: `/spaces/DEV/pages/${id}/${title}` },
        space: { key: "DEV", name: "Development" },
      };
    }

    function makeSearchResponse(
      pages: ConfluencePage[],
      limit = 50,
    ): ConfluenceSearchResponse {
      return {
        results: pages,
        start: 0,
        limit,
        size: pages.length,
      };
    }

    test("yields batch of documents from search results", async () => {
      const pages = [
        makePage("123", "Getting Started"),
        makePage("456", "API Reference"),
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeSearchResponse(pages)),
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(2);
      expect(batches[0].documents[0].id).toBe("123");
      expect(batches[0].documents[0].title).toBe("Getting Started");
      expect(batches[0].documents[1].id).toBe("456");
      expect(batches[0].hasMore).toBe(false);
    });

    test("uses /wiki prefix for cloud instances", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeSearchResponse([])),
      });

      const batches = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, isCloud: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/wiki/rest/api/content/search"),
        expect.anything(),
      );
    });

    test("omits /wiki prefix for server instances", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeSearchResponse([])),
      });

      const batches = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, isCloud: false },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain("/rest/api/content/search");
      expect(callUrl).not.toContain("/wiki/rest/api/content/search");
    });

    test("builds CQL with space filter", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeSearchResponse([])),
      });

      const batches = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, spaceKeys: ["DEV", "OPS"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const callUrl = mockFetch.mock.calls[0][0] as string;
      const url = new URL(callUrl);
      const cql = url.searchParams.get("cql") ?? "";
      expect(cql).toContain('space IN ("DEV", "OPS")');
    });

    test("paginates through multiple pages", async () => {
      const page1 = Array.from({ length: 50 }, (_, i) =>
        makePage(`${i + 1}`, `Page ${i + 1}`),
      );
      const page2 = [makePage("51", "Page 51")];

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              results: page1,
              start: 0,
              limit: 50,
              size: 50,
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              results: page2,
              start: 50,
              limit: 50,
              size: 1,
            }),
        });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].documents).toHaveLength(50);
      expect(batches[0].hasMore).toBe(true);
      expect(batches[1].documents).toHaveLength(1);
      expect(batches[1].hasMore).toBe(false);
    });

    test("incremental sync uses checkpoint timestamp", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeSearchResponse([])),
      });

      const batches = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: { lastSyncedAt: "2024-01-10T00:00:00.000Z" },
      })) {
        batches.push(batch);
      }

      const callUrl = mockFetch.mock.calls[0][0] as string;
      const url = new URL(callUrl);
      const cql = url.searchParams.get("cql") ?? "";
      expect(cql).toContain('lastModified >= "2024-01-10"');
    });

    test("skips pages with labels in labelsToSkip", async () => {
      const pages = [
        makePage("1", "Keep this"),
        {
          ...makePage("2", "Skip this"),
          metadata: { labels: { results: [{ name: "archived" }] } },
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeSearchResponse(pages)),
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, labelsToSkip: ["archived"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].id).toBe("1");
    });

    test("converts HTML body to plain text", async () => {
      const pages = [
        makePage(
          "1",
          "HTML Page",
          "<h1>Title</h1><p>Paragraph with <strong>bold</strong> text.</p>",
        ),
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeSearchResponse(pages)),
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const content = batches[0].documents[0].content;
      expect(content).toContain("Paragraph with bold text.");
      expect(content).not.toContain("<strong>");
      expect(content).not.toContain("<p>");
    });

    test("builds source URL correctly for cloud", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(makeSearchResponse([makePage("123", "Test Page")])),
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents[0].sourceUrl).toBe(
        "https://mysite.atlassian.net/wiki/spaces/DEV/pages/123/Test Page",
      );
    });

    test("includes metadata in documents", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(makeSearchResponse([makePage("123", "Test Page")])),
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const metadata = batches[0].documents[0].metadata;
      expect(metadata.pageId).toBe("123");
      expect(metadata.spaceKey).toBe("DEV");
      expect(metadata.spaceName).toBe("Development");
      expect(metadata.status).toBe("current");
    });

    test("throws on search API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Invalid CQL"),
      });

      const generator = connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      });

      await expect(generator.next()).rejects.toThrow(
        "Confluence search failed",
      );
    });

    test("respects custom batchSize", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [],
            start: 0,
            limit: 10,
            size: 0,
          }),
      });

      const batches = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, batchSize: 10 },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const callUrl = mockFetch.mock.calls[0][0] as string;
      const url = new URL(callUrl);
      expect(url.searchParams.get("limit")).toBe("10");
    });
  });

  describe("stripHtmlTags", () => {
    test("strips simple HTML tags", () => {
      expect(stripHtmlTags("<p>Hello world</p>")).toBe("Hello world");
    });

    test("handles nested tags", () => {
      const html = "<p>Text with <strong>bold</strong> and <em>italic</em></p>";
      expect(stripHtmlTags(html)).toBe("Text with bold and italic");
    });

    test("replaces block elements with newlines", () => {
      const html = "<p>First</p><p>Second</p>";
      const result = stripHtmlTags(html);
      expect(result).toContain("First");
      expect(result).toContain("Second");
      expect(result).toContain("\n");
    });

    test("handles br tags", () => {
      const html = "Line 1<br/>Line 2<br>Line 3";
      const result = stripHtmlTags(html);
      expect(result).toContain("Line 1");
      expect(result).toContain("Line 2");
      expect(result).toContain("Line 3");
    });

    test("decodes HTML entities", () => {
      expect(stripHtmlTags("&amp; &lt; &gt; &quot; &#39;")).toBe("& < > \" '");
    });

    test("handles nbsp", () => {
      expect(stripHtmlTags("hello&nbsp;world")).toBe("hello world");
    });

    test("returns empty string for empty input", () => {
      expect(stripHtmlTags("")).toBe("");
    });

    test("collapses multiple newlines", () => {
      const html = "<p>A</p><p></p><p></p><p>B</p>";
      const result = stripHtmlTags(html);
      expect(result).not.toMatch(/\n{3,}/);
    });
  });
});
