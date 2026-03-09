import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { ConnectorSyncBatch } from "@/types/knowledge-connector";
import {
  ConfluenceConnector,
  formatCqlLocalDate,
  stripHtmlTags,
} from "./confluence-connector";

// Mock confluence.js SDK
const mockGetSpaces = vi.fn();
const mockSearchContentByCQL = vi.fn();

vi.mock("confluence.js", () => ({
  ConfluenceClient: class MockConfluenceClient {
    space = { getSpaces: mockGetSpaces };
    content = { searchContentByCQL: mockSearchContentByCQL };
  },
}));

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
      mockGetSpaces.mockResolvedValueOnce({ results: [] });

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result).toEqual({ success: true });
      expect(mockGetSpaces).toHaveBeenCalledWith({ limit: 1 });
    });

    test("returns success for server instances", async () => {
      mockGetSpaces.mockResolvedValueOnce({ results: [] });

      const result = await connector.testConnection({
        config: { ...validConfig, isCloud: false },
        credentials,
      });

      expect(result).toEqual({ success: true });
      expect(mockGetSpaces).toHaveBeenCalled();
    });

    test("returns error when API throws", async () => {
      mockGetSpaces.mockRejectedValueOnce(
        new Error("Request failed with status code 401"),
      );

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
    ) {
      return {
        id,
        title,
        status: "current",
        body: { storage: { value: bodyHtml } },
        metadata: { labels: { results: [] as Array<{ name: string }> } },
        version: { when: "2024-01-15T10:00:00.000Z" },
        _links: { webui: `/spaces/DEV/pages/${id}/${title}` },
        space: { key: "DEV", name: "Development" },
      };
    }

    test("yields batch of documents from search results", async () => {
      const pages = [
        makePage("123", "Getting Started"),
        makePage("456", "API Reference"),
      ];

      mockSearchContentByCQL.mockResolvedValueOnce({
        results: pages,
        size: pages.length,
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

    test("passes CQL with space filter", async () => {
      mockSearchContentByCQL.mockResolvedValueOnce({
        results: [],
        size: 0,
      });

      const batches = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, spaceKeys: ["DEV", "OPS"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const callArgs = mockSearchContentByCQL.mock.calls[0][0];
      expect(callArgs.cql).toContain('space IN ("DEV", "OPS")');
    });

    test("paginates through multiple pages using cursor", async () => {
      const page1 = Array.from({ length: 50 }, (_, i) =>
        makePage(`${i + 1}`, `Page ${i + 1}`),
      );
      const page2 = [makePage("51", "Page 51")];

      mockSearchContentByCQL
        .mockResolvedValueOnce({
          results: page1,
          size: 50,
          _links: {
            next: "/rest/api/content/search?cursor=next-page-cursor&cql=...",
          },
        })
        .mockResolvedValueOnce({
          results: page2,
          size: 1,
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

      // Second call should include the cursor
      expect(mockSearchContentByCQL).toHaveBeenCalledTimes(2);
      expect(mockSearchContentByCQL.mock.calls[1][0]).toEqual(
        expect.objectContaining({ cursor: "next-page-cursor" }),
      );
    });

    test("incremental sync with old checkpoint (no lastRawModifiedAt) applies 1-day safety buffer", async () => {
      mockSearchContentByCQL.mockResolvedValueOnce({
        results: [],
        size: 0,
      });

      const batches = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: { lastSyncedAt: "2024-01-10T00:00:00.000Z" },
      })) {
        batches.push(batch);
      }

      // 2024-01-10 minus 1 day = 2024-01-09
      const callArgs = mockSearchContentByCQL.mock.calls[0][0];
      expect(callArgs.cql).toContain('lastModified >= "2024-01-09"');
    });

    test("incremental sync with lastRawModifiedAt uses local date extraction", async () => {
      mockSearchContentByCQL.mockResolvedValueOnce({
        results: [],
        size: 0,
      });

      const batches = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: {
          type: "confluence",
          lastSyncedAt: "2024-06-20T15:30:00.000Z",
          lastRawModifiedAt: "2024-06-20T11:30:00.774-0400",
        },
      })) {
        batches.push(batch);
      }

      // Should extract local date from raw timestamp (2024-06-20), NOT convert from UTC
      const callArgs = mockSearchContentByCQL.mock.calls[0][0];
      expect(callArgs.cql).toContain('lastModified >= "2024-06-20"');
    });

    test("skips pages with labels in labelsToSkip", async () => {
      const pages = [
        makePage("1", "Keep this"),
        {
          ...makePage("2", "Skip this"),
          metadata: { labels: { results: [{ name: "archived" }] } },
        },
      ];

      mockSearchContentByCQL.mockResolvedValueOnce({
        results: pages,
        size: pages.length,
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

      mockSearchContentByCQL.mockResolvedValueOnce({
        results: pages,
        size: pages.length,
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
      mockSearchContentByCQL.mockResolvedValueOnce({
        results: [makePage("123", "Test Page")],
        size: 1,
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
      mockSearchContentByCQL.mockResolvedValueOnce({
        results: [makePage("123", "Test Page")],
        size: 1,
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

    test("checkpoint stores lastRawModifiedAt and lastPageId from last page", async () => {
      const pages = [
        makePage("123", "First Page"),
        {
          ...makePage("456", "Second Page"),
          version: { when: "2024-06-20T11:30:00.774-0400" },
        },
      ];

      mockSearchContentByCQL.mockResolvedValueOnce({
        results: pages,
        size: pages.length,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const checkpoint = batches[0].checkpoint as {
        lastSyncedAt?: string;
        lastPageId?: string;
        lastRawModifiedAt?: string;
      };
      // lastSyncedAt is the UTC conversion of the raw timestamp
      expect(checkpoint.lastSyncedAt).toBe("2024-06-20T15:30:00.774Z");
      expect(checkpoint.lastPageId).toBe("456");
      // Raw timestamp preserved for correct CQL date formatting
      expect(checkpoint.lastRawModifiedAt).toBe("2024-06-20T11:30:00.774-0400");
    });

    test("checkpoint preserves previous value when batch has no pages", async () => {
      mockSearchContentByCQL.mockResolvedValueOnce({
        results: [],
        size: 0,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: {
          type: "confluence",
          lastSyncedAt: "2024-01-10T00:00:00.000Z",
          lastPageId: "99",
        },
      })) {
        batches.push(batch);
      }

      const checkpoint = batches[0].checkpoint as {
        lastSyncedAt?: string;
        lastPageId?: string;
      };
      expect(checkpoint.lastSyncedAt).toBe("2024-01-10T00:00:00.000Z");
      expect(checkpoint.lastPageId).toBe("99");
    });

    test("throws on search API error", async () => {
      mockSearchContentByCQL.mockRejectedValueOnce(
        new Error("Request failed with status code 400"),
      );

      const generator = connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      });

      await expect(generator.next()).rejects.toThrow();
    });

    test("respects custom batchSize", async () => {
      mockSearchContentByCQL.mockResolvedValueOnce({
        results: [],
        size: 0,
      });

      const batches = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, batchSize: 10 },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const callArgs = mockSearchContentByCQL.mock.calls[0][0];
      expect(callArgs.limit).toBe(10);
    });
  });

  describe("trailing slash normalization", () => {
    test("validates config with trailing slash", async () => {
      const result = await connector.validateConfig({
        confluenceUrl: "https://mycompany.atlassian.net/",
        isCloud: true,
      });
      expect(result).toEqual({ valid: true });
    });

    test("validates config without trailing slash", async () => {
      const result = await connector.validateConfig({
        confluenceUrl: "https://mycompany.atlassian.net",
        isCloud: true,
      });
      expect(result).toEqual({ valid: true });
    });

    test("source URLs are identical regardless of trailing slash in config", async () => {
      function makePage(id: string, title: string) {
        return {
          id,
          title,
          status: "current",
          body: { storage: { value: "<p>Content</p>" } },
          metadata: { labels: { results: [] } },
          version: { when: "2024-01-15T10:00:00.000Z" },
          _links: { webui: `/spaces/DEV/pages/${id}/${title}` },
          space: { key: "DEV", name: "Development" },
        };
      }

      // Test with trailing slash
      mockSearchContentByCQL.mockResolvedValueOnce({
        results: [makePage("123", "Test Page")],
        size: 1,
      });

      const batchesWithSlash: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          confluenceUrl: "https://mycompany.atlassian.net/",
          isCloud: true,
          spaceKeys: ["DEV"],
        },
        credentials,
        checkpoint: null,
      })) {
        batchesWithSlash.push(batch);
      }

      // Test without trailing slash
      mockSearchContentByCQL.mockResolvedValueOnce({
        results: [makePage("123", "Test Page")],
        size: 1,
      });

      const batchesWithoutSlash: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          confluenceUrl: "https://mycompany.atlassian.net",
          isCloud: true,
          spaceKeys: ["DEV"],
        },
        credentials,
        checkpoint: null,
      })) {
        batchesWithoutSlash.push(batch);
      }

      expect(batchesWithSlash[0].documents[0].sourceUrl).toBe(
        "https://mycompany.atlassian.net/wiki/spaces/DEV/pages/123/Test Page",
      );
      expect(batchesWithoutSlash[0].documents[0].sourceUrl).toBe(
        "https://mycompany.atlassian.net/wiki/spaces/DEV/pages/123/Test Page",
      );
      expect(batchesWithSlash[0].documents[0].sourceUrl).toBe(
        batchesWithoutSlash[0].documents[0].sourceUrl,
      );
    });
  });

  describe("formatCqlLocalDate", () => {
    test("extracts local date from timestamp with negative offset", () => {
      expect(formatCqlLocalDate("2026-03-09T11:05:52.774-0400")).toBe(
        "2026-03-09",
      );
    });

    test("extracts local date from timestamp with positive offset", () => {
      expect(formatCqlLocalDate("2026-03-09T23:30:00.000+0530")).toBe(
        "2026-03-09",
      );
    });

    test("extracts local date from UTC timestamp (Z suffix)", () => {
      expect(formatCqlLocalDate("2024-06-20T15:30:00.000Z")).toBe("2024-06-20");
    });

    test("falls back to UTC formatting for non-ISO strings", () => {
      expect(formatCqlLocalDate("June 20, 2024")).toBe("2024-06-20");
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
