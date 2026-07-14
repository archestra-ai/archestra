import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { ConnectorSyncBatch, PermissionSnapshotYield } from "@/types";
import {
  ConfluenceConnector,
  formatCqlLocalDate,
  stripHtmlTags,
} from "./confluence-connector";

// Mock confluence.js SDK
const mockGetSpaces = vi.fn();
const mockSearchContentByCQL = vi.fn();
const mockSendRequest = vi.fn();
const capturedConfluenceConfigs: Record<string, unknown>[] = [];

vi.mock("@/cache-manager");

vi.mock("confluence.js", () => ({
  ConfluenceClient: class MockConfluenceClient {
    space = { getSpaces: mockGetSpaces };
    content = { searchContentByCQL: mockSearchContentByCQL };
    sendRequest = mockSendRequest;
    // biome-ignore lint/suspicious/noExplicitAny: mock constructor
    constructor(config: any) {
      capturedConfluenceConfigs.push(config);
    }
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
    capturedConfluenceConfigs.length = 0;
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

    test("returns invalid when confluenceUrl uses unsupported protocol", async () => {
      const result = await connector.validateConfig({
        confluenceUrl: "ftp://confluence.example.com",
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

    test("accepts URL without protocol by prepending https://", async () => {
      const result = await connector.validateConfig({
        confluenceUrl: "mycompany.atlassian.net/wiki",
        isCloud: true,
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

    test("uses basic auth for server when email is provided", async () => {
      mockGetSpaces.mockResolvedValueOnce({ results: [] });

      await connector.testConnection({
        config: { ...validConfig, isCloud: false },
        credentials: { email: "admin", apiToken: "password123" },
      });

      const config = capturedConfluenceConfigs[0];
      expect(config?.authentication).toEqual({
        basic: { email: "admin", apiToken: "password123" },
      });
    });

    test("uses oauth2 (PAT) auth for server when email is not provided", async () => {
      mockGetSpaces.mockResolvedValueOnce({ results: [] });

      await connector.testConnection({
        config: { ...validConfig, isCloud: false },
        credentials: { apiToken: "pat-token-value" },
      });

      const config = capturedConfluenceConfigs[0];
      expect(config?.authentication).toEqual({
        oauth2: { accessToken: "pat-token-value" },
      });
    });

    test("sets noCheckAtlassianToken", async () => {
      mockGetSpaces.mockResolvedValueOnce({ results: [] });

      await connector.testConnection({
        config: { ...validConfig, isCloud: false },
        credentials: { apiToken: "pat-token" },
      });

      const config = capturedConfluenceConfigs[0];
      expect(config?.noCheckAtlassianToken).toBe(true);
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

    test("Server/DC uses offset-based pagination via sendRequest", async () => {
      const serverConfig = {
        confluenceUrl: "https://confluence.mycompany.com",
        isCloud: false,
        spaceKeys: ["DEV"],
      };

      const page1 = Array.from({ length: 50 }, (_, i) =>
        makePage(`${i + 1}`, `Page ${i + 1}`),
      );
      const page2 = Array.from({ length: 50 }, (_, i) =>
        makePage(`${i + 51}`, `Page ${i + 51}`),
      );
      const page3 = [makePage("101", "Page 101")];

      mockSendRequest
        .mockResolvedValueOnce({
          results: page1,
          size: 50,
          _links: {
            next: "/rest/api/content/search?limit=50&start=50&cql=...",
          },
        })
        .mockResolvedValueOnce({
          results: page2,
          size: 50,
          _links: {
            next: "/rest/api/content/search?limit=50&start=100&cql=...",
          },
        })
        .mockResolvedValueOnce({
          results: page3,
          size: 1,
        });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: serverConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(3);
      expect(batches[0].documents).toHaveLength(50);
      expect(batches[0].hasMore).toBe(true);
      expect(batches[1].documents).toHaveLength(50);
      expect(batches[1].hasMore).toBe(true);
      expect(batches[2].documents).toHaveLength(1);
      expect(batches[2].hasMore).toBe(false);

      // Verify start offset increments correctly
      expect(mockSendRequest).toHaveBeenCalledTimes(3);
      expect(mockSendRequest.mock.calls[0][0].params.start).toBe(0);
      expect(mockSendRequest.mock.calls[1][0].params.start).toBe(50);
      expect(mockSendRequest.mock.calls[2][0].params.start).toBe(100);

      // Should NOT use searchContentByCQL for Server/DC
      expect(mockSearchContentByCQL).not.toHaveBeenCalled();
    });

    test("Server/DC stops when _links.next is absent", async () => {
      const serverConfig = {
        confluenceUrl: "https://confluence.mycompany.com",
        isCloud: false,
        spaceKeys: ["DEV"],
      };

      mockSendRequest.mockResolvedValueOnce({
        results: [makePage("1", "Only Page")],
        size: 1,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: serverConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].hasMore).toBe(false);
      expect(mockSendRequest).toHaveBeenCalledTimes(1);
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

  describe("scopeKeyForDocument", () => {
    // Pins the metadata-field contract with content-sync: documents are
    // written with `spaceKey`, and the delta pass's local-adoption scoping
    // depends on reading exactly that field.
    test("maps content-sync document metadata to the space scope key", () => {
      expect(
        connector.scopeKeyForDocument({ spaceKey: "DOCS", pageId: "1" }),
      ).toBe("space:DOCS");
    });

    test("returns null when the metadata cannot place the document", () => {
      expect(connector.scopeKeyForDocument({})).toBeNull();
      expect(connector.scopeKeyForDocument({ spaceKey: "" })).toBeNull();
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

    test("strips decorative colour parameter from status lozenges", () => {
      const html = `<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Red</ac:parameter><ac:parameter ac:name="title">INC50780112</ac:parameter></ac:structured-macro>`;
      const result = stripHtmlTags(html);
      expect(result).toContain("INC50780112");
      expect(result).not.toContain("Red");
    });

    test("strips multiple decorative parameters (colour, subtle, icon)", () => {
      const html = `<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="subtle">true</ac:parameter><ac:parameter ac:name="title">Resolved</ac:parameter></ac:structured-macro>`;
      const result = stripHtmlTags(html);
      expect(result).toBe("Resolved");
    });

    test("separates table cells with tabs and rows with newlines", () => {
      const html = `<table><tr><td>Incident Number</td><td>INC50780112</td></tr><tr><td>Status</td><td>Open</td></tr></table>`;
      const result = stripHtmlTags(html);
      expect(result).toContain("Incident Number\tINC50780112");
      expect(result).toContain("Status\tOpen");
    });

    test("handles status lozenge inside a table cell", () => {
      const html = `<table><tr><td>Incident</td><td><ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Red</ac:parameter><ac:parameter ac:name="title">INC40298173</ac:parameter></ac:structured-macro></td></tr></table>`;
      const result = stripHtmlTags(html);
      expect(result).toContain("INC40298173");
      expect(result).not.toContain("Red");
    });
  });
});

describe("ConfluenceConnector permission sync", () => {
  const config = {
    confluenceUrl: "https://mysite.atlassian.net",
    isCloud: true,
    spaceKeys: ["DEV"],
  };
  const credentials = { email: "user@example.com", apiToken: "tok" };
  let connector: ConfluenceConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new ConfluenceConnector();
    // The Cloud permission pass arms the Atlassian admin-API email fallback,
    // which calls global fetch. Deny it by default (plain-API-token behavior)
    // so no test ever reaches the live network; the fallback test below
    // overrides this stub with a fake admin API.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );
  });
  afterEach(() => {
    vi.resetAllMocks();
  });

  async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of gen) out.push(item);
    return out;
  }

  /** Collect a permission snapshot into containers + document assignments. */
  async function collectSnapshot(
    gen: AsyncGenerator<PermissionSnapshotYield> | undefined,
  ) {
    const containers = new Map<string, unknown>();
    const documents: Extract<PermissionSnapshotYield, { kind: "document" }>[] =
      [];
    const yields: PermissionSnapshotYield[] = [];
    for await (const item of gen ??
      ((async function* () {})() as AsyncGenerator<PermissionSnapshotYield>)) {
      yields.push(item);
      if (item.kind === "container") {
        containers.set(item.containerKey, item.permissions);
      } else {
        documents.push(item);
      }
    }
    return { yields, containers, documents };
  }

  /** The effective audience of one document: its container's permissions. */
  function audienceOf(
    snapshot: Awaited<ReturnType<typeof collectSnapshot>>,
    sourceId: string,
  ) {
    const doc = snapshot.documents.find((d) => d.sourceId === sourceId);
    if (!doc) throw new Error(`No assignment yielded for ${sourceId}`);
    return snapshot.containers.get(doc.containerKey);
  }

  // biome-ignore lint/suspicious/noExplicitAny: test router
  function routeSendRequest(routes: Record<string, any>) {
    mockSendRequest.mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: SDK request shape
      async (req: any) => {
        const url: string = req.url;
        for (const [prefix, response] of Object.entries(routes)) {
          if (url.startsWith(prefix)) return response;
        }
        return {};
      },
    );
  }

  test("supportsPermissionSync is true", () => {
    expect(connector.supportsPermissionSync).toBe(true);
  });

  test("a restricted page lands in its own nested container with the restriction audience", async () => {
    mockSearchContentByCQL.mockResolvedValue({
      results: [{ id: "p1", space: { key: "DEV" }, ancestors: [] }],
      _links: {},
    });
    routeSendRequest({
      "/api/content/p1/restriction/byOperation/read": {
        restrictions: {
          user: { results: [{ accountId: "a1", email: "alice@example.com" }] },
          group: { results: [{ name: "devs" }] },
        },
      },
    });

    const snapshot = await collectSnapshot(
      connector.syncPermissionSnapshot?.({
        config,
        credentials,
        cursor: null,
        readIngestedDocuments: vi.fn(),
      }),
    );

    expect(snapshot.documents).toEqual([
      {
        kind: "document",
        sourceId: "p1",
        containerKey: "space:DEV/page:p1",
        cursor: "space:DEV",
      },
    ]);
    expect(audienceOf(snapshot, "p1")).toEqual({
      isPublic: false,
      users: ["alice@example.com"],
      groups: ["devs"],
    });
  });

  test("a failed restriction lookup fail-closes the page instead of inheriting the space audience", async () => {
    mockSearchContentByCQL.mockResolvedValue({
      results: [{ id: "p1", space: { key: "DEV" }, ancestors: [] }],
      _links: {},
    });
    // biome-ignore lint/suspicious/noExplicitAny: SDK request shape
    mockSendRequest.mockImplementation(async (req: any) => {
      const url = String(req.url);
      if (url.includes("/restriction/byOperation/read")) {
        throw new Error("429 Too Many Requests");
      }
      if (url.startsWith("/api/space/DEV")) {
        return {
          permissions: [
            {
              operation: { operation: "read" },
              subjects: { user: { results: [{ email: "bob@example.com" }] } },
            },
          ],
        };
      }
      return {};
    });

    const snapshot = await collectSnapshot(
      connector.syncPermissionSnapshot?.({
        config,
        credentials,
        cursor: null,
        readIngestedDocuments: vi.fn(),
      }),
    );

    // The space audience itself resolved — but the page whose restriction
    // check failed must NOT inherit it (a restricted page would over-grant).
    expect(snapshot.containers.get("space:DEV")).toEqual({
      isPublic: false,
      users: ["bob@example.com"],
      groups: [],
    });
    expect(snapshot.documents).toEqual([
      {
        kind: "document",
        sourceId: "p1",
        containerKey: "space:DEV/page:p1",
        cursor: "space:DEV",
      },
    ]);
    expect(audienceOf(snapshot, "p1")).toEqual({
      isPublic: false,
      users: [],
      groups: [],
    });
  });

  test("uses inline-expanded restrictions without any per-content requests", async () => {
    mockSearchContentByCQL.mockResolvedValue({
      results: [
        {
          id: "p1",
          ancestors: [],
          restrictions: {
            read: {
              restrictions: {
                user: {
                  results: [{ accountId: "a1", email: "alice@example.com" }],
                  size: 1,
                },
                group: { results: [{ name: "devs" }], size: 1 },
              },
            },
          },
        },
        {
          id: "p2",
          ancestors: [{ id: "p1" }],
          restrictions: {
            read: {
              restrictions: {
                user: { results: [], size: 0 },
                group: { results: [], size: 0 },
              },
            },
          },
        },
      ],
      _links: {},
    });
    routeSendRequest({});

    const snapshot = await collectSnapshot(
      connector.syncPermissionSnapshot?.({
        config,
        credentials,
        cursor: null,
        readIngestedDocuments: vi.fn(),
      }),
    );

    // p1 restricted inline; p2 unrestricted inherits p1's restriction from the
    // buffered map — closest restricted ancestor, resolved locally into ONE
    // shared nested container.
    expect(snapshot.documents.map((d) => d.containerKey)).toEqual([
      "space:DEV/page:p1",
      "space:DEV/page:p1",
    ]);
    expect(audienceOf(snapshot, "p1")).toMatchObject({
      users: ["alice@example.com"],
    });
    expect(audienceOf(snapshot, "p2")).toMatchObject({
      users: ["alice@example.com"],
    });
    // The search asked for the inline expansion...
    expect(mockSearchContentByCQL).toHaveBeenCalledWith(
      expect.objectContaining({
        expand: expect.arrayContaining(["restrictions.read.restrictions.user"]),
      }),
    );
    // ...and NO per-content restriction endpoint was hit.
    const restrictionCalls = mockSendRequest.mock.calls.filter(
      // biome-ignore lint/suspicious/noExplicitAny: SDK request shape
      (call: any[]) => String(call[0]?.url).includes("/restriction/"),
    );
    expect(restrictionCalls).toHaveLength(0);
  });

  test("falls back to the per-content endpoint when an inline list is truncated", async () => {
    mockSearchContentByCQL.mockResolvedValue({
      results: [
        {
          id: "p1",
          ancestors: [],
          restrictions: {
            read: {
              restrictions: {
                // 1 of 2 subjects inline — truncated, so the inline data must
                // not be trusted (it would under-grant).
                user: {
                  results: [{ accountId: "a1", email: "alice@example.com" }],
                  size: 2,
                },
                group: { results: [], size: 0 },
              },
            },
          },
        },
      ],
      _links: {},
    });
    routeSendRequest({
      "/api/content/p1/restriction/byOperation/read": {
        restrictions: {
          user: {
            results: [
              { accountId: "a1", email: "alice@example.com" },
              { accountId: "a2", email: "bob@example.com" },
            ],
          },
          group: { results: [] },
        },
      },
    });

    const snapshot = await collectSnapshot(
      connector.syncPermissionSnapshot?.({
        config,
        credentials,
        cursor: null,
        readIngestedDocuments: vi.fn(),
      }),
    );

    expect(audienceOf(snapshot, "p1")).toMatchObject({
      users: ["alice@example.com", "bob@example.com"],
    });
  });

  test("retries without the restriction expand when the server rejects it", async () => {
    mockSearchContentByCQL
      .mockRejectedValueOnce(new Error("400: unsupported expand"))
      .mockResolvedValue({
        results: [{ id: "p1", ancestors: [] }],
        _links: {},
      });
    routeSendRequest({
      "/api/content/p1/restriction/byOperation/read": {
        restrictions: {
          user: { results: [{ email: "alice@example.com" }] },
          group: { results: [] },
        },
      },
    });

    const snapshot = await collectSnapshot(
      connector.syncPermissionSnapshot?.({
        config,
        credentials,
        cursor: null,
        readIngestedDocuments: vi.fn(),
      }),
    );

    expect(audienceOf(snapshot, "p1")).toMatchObject({
      users: ["alice@example.com"],
    });
    // Retried without the restriction expands after the rejection.
    expect(mockSearchContentByCQL).toHaveBeenCalledTimes(2);
    expect(mockSearchContentByCQL.mock.calls[1][0].expand).toEqual([
      "ancestors",
    ]);
  });

  test("enumerates all spaces and resumes from the space-key cursor", async () => {
    const searchedSpaces: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: SDK request shape
    mockSearchContentByCQL.mockImplementation(async (req: any) => {
      const match = String(req.cql).match(/space = "([^"]+)"/);
      if (match) searchedSpaces.push(match[1]);
      return { results: [], _links: {} };
    });
    mockGetSpaces.mockResolvedValue({
      results: [{ key: "ZZZ" }, { key: "AAA" }, { key: "MMM" }],
    });

    await collectSnapshot(
      connector.syncPermissionSnapshot?.({
        config: {
          confluenceUrl: "https://mysite.atlassian.net",
          isCloud: true,
        },
        credentials,
        cursor: "space:MMM",
        readIngestedDocuments: vi.fn(),
      }),
    );

    // Sorted space order; spaces strictly before the cursor are skipped and
    // the cursor space itself is re-processed.
    expect(searchedSpaces).toEqual(["MMM", "ZZZ"]);
  });

  test("persists resolved emails across passes (fresh connector instance)", async () => {
    mockSearchContentByCQL.mockResolvedValue({
      results: [
        {
          id: "p1",
          ancestors: [],
          restrictions: {
            read: {
              restrictions: {
                // No email inline — forces the /api/user lookup.
                user: { results: [{ accountId: "a1" }], size: 1 },
                group: { results: [], size: 0 },
              },
            },
          },
        },
      ],
      _links: {},
    });
    routeSendRequest({
      "/api/user": { email: "alice@example.com" },
    });

    const runPass = async () => {
      const fresh = new ConfluenceConnector();
      return collectSnapshot(
        fresh.syncPermissionSnapshot?.({
          config,
          credentials,
          cursor: null,
          readIngestedDocuments: vi.fn(),
        }),
      );
    };
    const userLookups = () =>
      mockSendRequest.mock.calls.filter(
        // biome-ignore lint/suspicious/noExplicitAny: SDK request shape
        (call: any[]) => String(call[0]?.url).startsWith("/api/user"),
      ).length;

    const first = await runPass();
    expect(audienceOf(first, "p1")).toMatchObject({
      users: ["alice@example.com"],
    });
    expect(userLookups()).toBe(1);

    // A fresh instance has an empty per-pass LRU; the persistent identity
    // cache must serve the second pass without another upstream lookup.
    const second = await runPass();
    expect(audienceOf(second, "p1")).toMatchObject({
      users: ["alice@example.com"],
    });
    expect(userLookups()).toBe(1);
  });

  test("falls back to the closest ancestor restriction when the page is unrestricted", async () => {
    mockSearchContentByCQL.mockResolvedValue({
      results: [
        {
          id: "p2",
          space: { key: "DEV" },
          ancestors: [{ id: "root" }, { id: "parent" }],
        },
      ],
      _links: {},
    });
    routeSendRequest({
      "/api/content/p2/restriction/byOperation/read": {
        restrictions: { user: { results: [] }, group: { results: [] } },
      },
      "/api/content/parent/restriction/byOperation/read": {
        restrictions: {
          user: { results: [{ email: "bob@example.com" }] },
          group: { results: [] },
        },
      },
    });

    const snapshot = await collectSnapshot(
      connector.syncPermissionSnapshot?.({
        config,
        credentials,
        cursor: null,
        readIngestedDocuments: vi.fn(),
      }),
    );

    // Governed by the closest restricted ancestor — even one outside the
    // corpus enumeration (fetched via the per-content fallback).
    expect(snapshot.documents[0].containerKey).toBe("space:DEV/page:parent");
    expect(audienceOf(snapshot, "p2")).toEqual({
      isPublic: false,
      users: ["bob@example.com"],
      groups: [],
    });
  });

  test("falls back to space read permissions when nothing is restricted", async () => {
    mockSearchContentByCQL.mockResolvedValue({
      results: [{ id: "p3", space: { key: "DEV" }, ancestors: [] }],
      _links: {},
    });
    routeSendRequest({
      "/api/content/p3/restriction/byOperation/read": {
        restrictions: { user: { results: [] }, group: { results: [] } },
      },
      "/api/space/DEV": {
        permissions: [
          {
            operation: { operation: "read" },
            subjects: { group: { results: [{ name: "space-readers" }] } },
          },
        ],
      },
    });

    const snapshot = await collectSnapshot(
      connector.syncPermissionSnapshot?.({
        config,
        credentials,
        cursor: null,
        readIngestedDocuments: vi.fn(),
      }),
    );

    expect(snapshot.documents[0].containerKey).toBe("space:DEV");
    expect(audienceOf(snapshot, "p3")).toEqual({
      isPublic: false,
      users: [],
      groups: ["space-readers"],
    });
  });

  test("syncGroups expands groups to members via the by-ID endpoint on Cloud", async () => {
    // Cloud group lists carry ids, and Cloud no longer serves the by-name
    // member endpoint (it 404s into the SPA's HTML page) — members MUST be
    // fetched through /group/{id}/membersByGroupId there.
    routeSendRequest({
      "/api/group/group-devs-id/membersByGroupId": {
        results: [
          {
            accountId: "acc-alice",
            displayName: "Alice",
            email: "alice@example.com",
          },
          // Email hidden — recorded with email null, never dropped.
          { accountId: "acc-bob", publicName: "Bob" },
        ],
      },
      "/api/group": { results: [{ id: "group-devs-id", name: "devs" }] },
    });

    const yields = await collect(
      connector.syncGroups?.({
        config,
        credentials,
        cursor: null,
        readIngestedDocuments: vi.fn(),
      }) ?? (async function* () {})(),
    );

    const members = [
      {
        accountId: "acc-alice",
        displayName: "Alice",
        email: "alice@example.com",
        accountType: null,
      },
      {
        accountId: "acc-bob",
        displayName: "Bob",
        email: null,
        accountType: null,
      },
    ];
    expect(yields).toEqual([
      { groupId: "devs", members, cursor: "devs" },
      // Synthetic "any logged-in user" group: the union of every member
      // across the instance's real groups.
      {
        groupId: "confluence-any-logged-in-user",
        members,
        cursor: "confluence-any-logged-in-user",
      },
    ]);
  });

  test("syncGroups skips a group whose member lookup fails instead of aborting the enumeration", async () => {
    // A group can be listed but fail on member lookup (e.g. a hidden system
    // group returning 404); one bad group must not abort the whole
    // enumeration, which would leave the snapshot unrefreshed for every group.
    // biome-ignore lint/suspicious/noExplicitAny: SDK request shape
    mockSendRequest.mockImplementation(async (req: any) => {
      const url: string = req.url;
      if (url.startsWith("/api/group/member?name=hidden-addons")) {
        throw new Error("HTTP 404: group does not exist");
      }
      if (url.startsWith("/api/group/member")) {
        return {
          results: [
            {
              accountId: "acc-alice",
              displayName: "Alice",
              email: "alice@example.com",
            },
          ],
        };
      }
      if (url.startsWith("/api/group")) {
        return { results: [{ name: "hidden-addons" }, { name: "devs" }] };
      }
      return {};
    });

    const yields = await collect(
      connector.syncGroups?.({
        config,
        credentials,
        cursor: null,
        readIngestedDocuments: vi.fn(),
      }) ?? (async function* () {})(),
    );

    const members = [
      {
        accountId: "acc-alice",
        displayName: "Alice",
        email: "alice@example.com",
        accountType: null,
      },
    ];
    expect(yields).toEqual([
      // The failed group yields empty (fail-closed for it alone); the healthy
      // group is still enumerated, as is the synthetic all-members group.
      { groupId: "hidden-addons", members: [], cursor: "hidden-addons" },
      { groupId: "devs", members, cursor: "devs" },
      {
        groupId: "confluence-any-logged-in-user",
        members,
        cursor: "confluence-any-logged-in-user",
      },
    ]);
  });

  test("syncGroups resolves hidden emails through the Atlassian admin directory when the credential is an org-admin API key", async () => {
    // The product API hides most emails (profile visibility, AX-207); an
    // org-admin API key credential unlocks the Organizations directory, which
    // returns managed accounts' emails regardless of visibility.
    routeSendRequest({
      "/api/group/member": {
        results: [{ accountId: "acc-bob", publicName: "Bob" }],
      },
      "/api/group": { results: [{ name: "devs" }] },
    });
    const adminApi = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/admin/v1/orgs")) {
        return Response.json({ data: [{ id: "org-1" }], links: {} });
      }
      if (url.endsWith("/admin/v2/orgs/org-1/directories")) {
        return Response.json({ data: [{ directoryId: "dir-1" }], links: {} });
      }
      if (url.endsWith("/directories/dir-1/users/search")) {
        return Response.json({
          data: [{ accountId: "acc-bob", email: "bob@example.com" }],
          links: {},
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", adminApi);

    const yields = await collect(
      connector.syncGroups?.({
        config,
        credentials,
        cursor: null,
        readIngestedDocuments: vi.fn(),
      }) ?? (async function* () {})(),
    );

    expect(yields[0].members).toEqual([
      {
        accountId: "acc-bob",
        displayName: "Bob",
        email: "bob@example.com",
        accountType: null,
      },
    ]);
  });

  test("maps a built-in all-users group to the synthetic any-logged-in-user group", async () => {
    // A page readable by the built-in `confluence-users` group means "any
    // logged-in user" — its token must be the synthetic id so it resolves to
    // every member, not a raw group name nothing is stored under.
    mockSearchContentByCQL.mockResolvedValue({
      results: [{ id: "p9", space: { key: "DEV" }, ancestors: [] }],
      _links: {},
    });
    routeSendRequest({
      "/api/content/p9/restriction/byOperation/read": {
        restrictions: {
          user: { results: [] },
          group: { results: [{ name: "confluence-users" }] },
        },
      },
    });

    const snapshot = await collectSnapshot(
      connector.syncPermissionSnapshot?.({
        config,
        credentials,
        cursor: null,
        readIngestedDocuments: vi.fn(),
      }),
    );

    expect(audienceOf(snapshot, "p9")).toEqual({
      isPublic: false,
      users: [],
      groups: ["confluence-any-logged-in-user"],
    });
  });

  test("probePermissionChanges: first probe demands a full pass; audit + content windows map drift", async () => {
    const first = await connector.probePermissionChanges?.({
      config,
      credentials,
      state: null,
    });
    expect(first?.fullRequired).toBe(true);
    expect(typeof first?.nextState.contentCursor).toBe("string");

    routeSendRequest({
      "/api/audit": {
        results: [
          { summary: "User added to group", category: "users and groups" },
          { summary: "Content restriction added", category: "permissions" },
        ],
      },
    });
    mockSearchContentByCQL.mockResolvedValue({
      results: [
        { id: "p1", space: { key: "DEV" } },
        { id: "p2", space: { key: "OPS" } },
      ],
      _links: {},
    });
    const probe = await connector.probePermissionChanges?.({
      config,
      credentials,
      state: {
        contentCursor: "2026-07-01T00:00:00.000Z",
        auditCursor: "2026-07-01T00:00:00.000Z",
      },
    });
    expect(probe?.dirtyContainerKeys).toEqual(["space:DEV", "space:OPS"]);
    // A restriction event moves pages between containers (an ASSIGNMENT
    // change invisible to the lastmodified window) → full reconcile. This is
    // the audit window's ONLY job.
    expect(probe?.fullRequired).toBe(true);
    // The audit window opens a few minutes BEFORE the cursor: clock skew
    // against the upstream must not hide events stamped just before it.
    const auditRequest = mockSendRequest.mock.calls
      .map(([req]) => req)
      .find((req) => req?.url === "/api/audit");
    expect(auditRequest?.params?.startDate).toBe("2026-06-30T23:55:00.000Z");

    // Group and space-permission events flag NOTHING: audiences and
    // memberships are verified directly by every delta pass, never inferred
    // from audit wording (which proved lossy — late ingestion, and
    // revocations worded unlike grants).
    routeSendRequest({
      "/api/audit": {
        results: [
          { summary: "Space permission added", category: "permissions" },
          { summary: "User added to group", category: "users and groups" },
        ],
      },
    });
    mockSearchContentByCQL.mockResolvedValue({ results: [], _links: {} });
    const clean = await connector.probePermissionChanges?.({
      config,
      credentials,
      state: {
        contentCursor: "2026-07-01T00:00:00.000Z",
        auditCursor: "2026-07-01T00:00:00.000Z",
      },
    });
    expect(clean?.fullRequired).toBe(false);
    expect(clean?.dirtyContainerKeys).toEqual([]);

    // The stored audit cursor TRAILS the pass wall-clock: audit ingestion is
    // asynchronous, so a cursor taken at pass time slides past records still
    // in flight — a restriction edit ingested minutes late would be
    // permanently skipped when passes run close together.
    const contentNext = Date.parse(String(clean?.nextState.contentCursor));
    const auditNext = Date.parse(String(clean?.nextState.auditCursor));
    expect(contentNext - auditNext).toBe(15 * 60 * 1000);
  });

  test("refreshContainerAudiences re-resolves stored space audiences and skips restriction containers", async () => {
    routeSendRequest({
      "/api/space/DEV": {
        permissions: [
          {
            operation: { operation: "read" },
            subjects: {
              user: { results: [{ email: "alice@example.com" }] },
              group: { results: [{ name: "devs" }] },
            },
          },
        ],
      },
    });

    const out: unknown[] = [];
    const generator = connector.refreshContainerAudiences?.({
      config,
      credentials,
      // The nested restriction container is NOT refreshed: a restriction
      // change is an assignment change owned by the enumerating passes.
      containerKeys: ["space:DEV", "space:DEV/page:123"],
    });
    if (!generator) throw new Error("hook missing");
    for await (const item of generator) out.push(item);

    expect(out).toEqual([
      {
        containerKey: "space:DEV",
        permissions: {
          isPublic: false,
          users: ["alice@example.com"],
          groups: ["devs"],
        },
        audienceResolutionFailed: false,
      },
    ]);
    // No page/content requests were made — audiences only.
    const urls = mockSendRequest.mock.calls.map(([req]) => req?.url as string);
    expect(urls.every((url) => url.startsWith("/api/space/"))).toBe(true);
  });

  test("a directly-granted account with a hidden upstream email materializes as its mapped user's email", async () => {
    routeSendRequest({
      "/api/space/DEV": {
        permissions: [
          {
            operation: { operation: "read" },
            // The subject's upstream email is hidden — only the accountId is
            // exposed; the admin mapping resolves it without an upstream call.
            subjects: { user: { results: [{ accountId: "acc-hidden" }] } },
          },
        ],
      },
    });

    const out: { permissions: { users: string[] } }[] = [];
    const generator = connector.refreshContainerAudiences?.({
      config,
      credentials,
      containerKeys: ["space:DEV"],
      resolveMappedEmail: (externalAccountId) =>
        externalAccountId === "acc-hidden" ? "mapped@example.com" : null,
    });
    if (!generator) throw new Error("hook missing");
    for await (const item of generator) {
      out.push(item as { permissions: { users: string[] } });
    }

    expect(out).toHaveLength(1);
    expect(out[0].permissions.users).toEqual(["mapped@example.com"]);
  });

  test("server (isCloud=false) pages document permissions by start offset through the server search API", async () => {
    const serverConfig = {
      confluenceUrl: "https://confluence.internal",
      isCloud: false,
      spaceKeys: ["DEV"],
    };
    // biome-ignore lint/suspicious/noExplicitAny: SDK request shape
    mockSendRequest.mockImplementation(async (req: any) => {
      if (req.url === "/api/content/search") {
        // Two pages keyed by the start offset (Server has no cursor API).
        if (req.params.start === 0) {
          return {
            results: [{ id: "s1", space: { key: "DEV" }, ancestors: [] }],
            _links: { next: "/rest/api/content/search?start=1" },
          };
        }
        return {
          results: [{ id: "s2", space: { key: "DEV" }, ancestors: [] }],
          _links: {},
        };
      }
      if (req.url.includes("/restriction/byOperation/read")) {
        return {
          restrictions: {
            user: { results: [{ email: "carol@example.com" }] },
            group: { results: [] },
          },
        };
      }
      return {};
    });

    const snapshot = await collectSnapshot(
      connector.syncPermissionSnapshot?.({
        config: serverConfig,
        credentials,
        cursor: null,
        readIngestedDocuments: vi.fn(),
      }),
    );

    expect(snapshot.documents.map((item) => item.sourceId)).toEqual([
      "s1",
      "s2",
    ]);
    expect(audienceOf(snapshot, "s1")).toEqual({
      isPublic: false,
      users: ["carol@example.com"],
      groups: [],
    });
    // The Server path never touches the Cloud CQL API and never arms the
    // Cloud-only admin email fallback.
    expect(mockSearchContentByCQL).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("server (isCloud=false) syncGroups records members by username with their server-visible email", async () => {
    const serverConfig = {
      confluenceUrl: "https://confluence.internal",
      isCloud: false,
      spaceKeys: ["DEV"],
    };
    routeSendRequest({
      "/api/group/member": {
        results: [
          {
            username: "carol",
            displayName: "Carol",
            email: "carol@example.com",
          },
        ],
      },
      "/api/group": { results: [{ name: "ops" }] },
    });

    const yields = await collect(
      connector.syncGroups?.({
        config: serverConfig,
        credentials,
        cursor: null,
        readIngestedDocuments: vi.fn(),
      }) ?? (async function* () {})(),
    );

    // Server members carry no accountId — the username keys the membership
    // row — and the server returns emails to an admin credential directly.
    const members = [
      {
        accountId: "carol",
        displayName: "Carol",
        email: "carol@example.com",
        accountType: null,
      },
    ];
    expect(yields).toEqual([
      { groupId: "ops", members, cursor: "ops" },
      {
        groupId: "confluence-any-logged-in-user",
        members,
        cursor: "confluence-any-logged-in-user",
      },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
