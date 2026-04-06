import { describe, expect, it, vi } from "vitest";
import type { ConnectorSyncBatch } from "@/types";
import { SharePointConnector } from "./sharepoint-connector";

function makeDriveItem(
  id: string,
  name: string,
  opts?: {
    lastModified?: string;
    webUrl?: string;
    size?: number;
    mimeType?: string;
  },
) {
  return {
    id,
    name,
    webUrl: opts?.webUrl ?? `https://contoso.sharepoint.com/sites/docs/${name}`,
    lastModifiedDateTime: opts?.lastModified ?? "2024-01-15T10:00:00.000Z",
    createdDateTime: "2024-01-01T00:00:00.000Z",
    size: opts?.size ?? 1024,
    file: { mimeType: opts?.mimeType ?? "text/plain" },
    lastModifiedBy: { user: { displayName: "Test User" } },
  };
}

function makeItemListResponse(
  items: ReturnType<typeof makeDriveItem>[],
  opts?: { nextLink?: string; deltaLink?: string },
) {
  return {
    ok: true,
    json: async () => ({
      value: items,
      "@odata.nextLink": opts?.nextLink,
      "@odata.deltaLink": opts?.deltaLink,
    }),
  } as unknown as Response;
}

function makeTokenResponse() {
  return {
    ok: true,
    json: async () => ({ access_token: "test-access-token" }),
  } as unknown as Response;
}

function makeSiteResponse(siteId = "contoso.sharepoint.com,site-id-123") {
  return {
    ok: true,
    json: async () => ({ id: siteId }),
  } as unknown as Response;
}

function makeDefaultDriveResponse(driveId = "drive-abc") {
  return {
    ok: true,
    json: async () => ({ id: driveId }),
  } as unknown as Response;
}

function makeContentResponse(text: string) {
  return {
    ok: true,
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  } as unknown as Response;
}

const validConfig = {
  siteUrl: "https://contoso.sharepoint.com/sites/docs",
  tenantId: "tenant-123",
  clientId: "client-456",
};

const credentials = { apiToken: "client-secret-789" };

describe("SharePointConnector", () => {
  it("has the correct type", () => {
    const connector = new SharePointConnector();
    expect(connector.type).toBe("sharepoint");
  });

  describe("validateConfig", () => {
    it("accepts valid config with required fields", async () => {
      const connector = new SharePointConnector();
      const result = await connector.validateConfig(validConfig);
      expect(result.valid).toBe(true);
    });

    it("accepts config with optional fields", async () => {
      const connector = new SharePointConnector();
      const result = await connector.validateConfig({
        ...validConfig,
        driveId: "drive-abc",
        folderPath: "Documents/Reports",
        includeFileTypes: [".pdf", ".docx"],
        batchSize: 25,
      });
      expect(result.valid).toBe(true);
    });

    it("rejects config missing required fields", async () => {
      const connector = new SharePointConnector();
      const result = await connector.validateConfig({
        siteUrl: "https://contoso.sharepoint.com/sites/docs",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid SharePoint configuration");
    });

    it("rejects config with invalid batchSize type", async () => {
      const connector = new SharePointConnector();
      const result = await connector.validateConfig({
        ...validConfig,
        batchSize: "not-a-number",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("testConnection", () => {
    it("returns success when site is reachable", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result.success).toBe(true);
    });

    it("does not double-encode percent-encoded characters in site URL path", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());

      await connector.testConnection({
        // siteUrl with a space that gets percent-encoded by the URL constructor
        config: {
          ...validConfig,
          siteUrl: "https://contoso.sharepoint.com/sites/my%20team",
        },
        credentials,
      });

      // The Graph API URL must contain "my%20team", NOT double-encoded "my%2520team"
      const siteUrl = (fetchMock.mock.calls[1] as unknown[])[0] as string;
      expect(siteUrl).toContain("my%20team");
      expect(siteUrl).not.toContain("my%2520team");
    });

    it("returns failure on invalid credentials", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Invalid client credentials",
      } as Response);

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Connection failed");
    });

    it("returns failure when site is not found", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Site not found",
      } as Response);

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("404");
    });

    it("returns failure when fetch throws", async () => {
      const connector = new SharePointConnector();
      vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      ).mockRejectedValueOnce(new Error("Network error"));

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Network error");
    });

    it("returns failure on invalid config", async () => {
      const connector = new SharePointConnector();
      const result = await connector.testConnection({
        config: { siteUrl: "https://example.com" },
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid SharePoint configuration");
    });
  });

  describe("sync", () => {
    it("throws when config is invalid", async () => {
      const connector = new SharePointConnector();

      const generator = connector.sync({
        config: { siteUrl: "https://example.com" },
        credentials,
        checkpoint: null,
      });

      await expect(generator.next()).rejects.toThrow(
        "Invalid SharePoint configuration",
      );
    });

    it("yields documents from drive items", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const items = [
        makeDriveItem("item-1", "report.txt"),
        makeDriveItem("item-2", "notes.md"),
      ];

      // token -> site -> default drive -> items list -> content x2
      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeDefaultDriveResponse());
      fetchMock.mockResolvedValueOnce(makeItemListResponse(items));
      fetchMock.mockResolvedValueOnce(makeContentResponse("Report content"));
      fetchMock.mockResolvedValueOnce(makeContentResponse("Notes content"));

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
      expect(batches[0].documents[0].id).toBe("item-1");
      expect(batches[0].documents[0].title).toBe("report.txt");
      expect(batches[0].documents[0].content).toContain("Report content");
      expect(batches[0].documents[1].id).toBe("item-2");
      expect(batches[0].documents[1].content).toContain("Notes content");
      expect(batches[0].hasMore).toBe(false);
    });

    it("skips folders and unsupported file types", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const items = [
        makeDriveItem("item-1", "report.txt"),
        {
          ...makeDriveItem("item-2", "images"),
          folder: { childCount: 3 },
          file: undefined,
        },
        makeDriveItem("item-3", "photo.jpg"),
      ];

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeDefaultDriveResponse());
      fetchMock.mockResolvedValueOnce(makeItemListResponse(items as never));
      fetchMock.mockResolvedValueOnce(makeContentResponse("Report text"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("report.txt");
    });

    it("paginates using @odata.nextLink", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const item1 = makeDriveItem("item-1", "first.txt");
      const item2 = makeDriveItem("item-2", "second.txt");

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeDefaultDriveResponse());
      // First page with nextLink
      fetchMock.mockResolvedValueOnce(
        makeItemListResponse([item1], {
          nextLink: "https://graph.microsoft.com/v1.0/next-page",
        }),
      );
      fetchMock.mockResolvedValueOnce(makeContentResponse("First content"));
      // Second page, no nextLink
      fetchMock.mockResolvedValueOnce(makeItemListResponse([item2]));
      fetchMock.mockResolvedValueOnce(makeContentResponse("Second content"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].hasMore).toBe(true);
      expect(batches[0].documents[0].id).toBe("item-1");
      expect(batches[1].hasMore).toBe(false);
      expect(batches[1].documents[0].id).toBe("item-2");
    });

    it("processes all items from delta endpoint (server-side filtering)", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      // Delta endpoint only returns changed items, so both should be processed
      const items = [
        makeDriveItem("item-a", "a.txt", {
          lastModified: "2024-01-10T00:00:00.000Z",
        }),
        makeDriveItem("item-b", "b.txt", {
          lastModified: "2024-01-20T00:00:00.000Z",
        }),
      ];

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeDefaultDriveResponse());
      fetchMock.mockResolvedValueOnce(makeItemListResponse(items));
      fetchMock.mockResolvedValueOnce(makeContentResponse("Content A"));
      fetchMock.mockResolvedValueOnce(makeContentResponse("Content B"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: {
          type: "sharepoint",
          lastSyncedAt: "2024-01-15T00:00:00.000Z",
        },
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(2);
    });

    it("resolves default drive via /drive endpoint, not /drives index 0", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeDefaultDriveResponse("default-drive-id"));
      fetchMock.mockResolvedValueOnce(makeItemListResponse([]));

      for await (const _ of connector.sync({
        config: validConfig, // no explicit driveId
        credentials,
        checkpoint: null,
      })) {
        // consume
      }

      // Third call should be /drive (singular), not /drives (plural)
      const driveUrl = (fetchMock.mock.calls[2] as unknown[])[0] as string;
      expect(driveUrl).toContain("/sites/");
      expect(driveUrl).toMatch(/\/drive$/);
      expect(driveUrl).not.toContain("/drives");
      // Items URL should use the resolved drive id
      const itemsUrl = (fetchMock.mock.calls[3] as unknown[])[0] as string;
      expect(itemsUrl).toContain("default-drive-id");
    });

    it("uses driveId from config when provided", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      // No drives call since driveId is explicit
      fetchMock.mockResolvedValueOnce(makeItemListResponse([]));

      for await (const _ of connector.sync({
        config: { ...validConfig, driveId: "explicit-drive-id" },
        credentials,
        checkpoint: null,
      })) {
        // consume
      }

      // Calls: token, site, items list (no drives call)
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const itemsUrl = (fetchMock.mock.calls[2] as unknown[])[0] as string;
      expect(itemsUrl).toContain("drives/explicit-drive-id");
    });

    it("uses folderPath when provided", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeDefaultDriveResponse());
      fetchMock.mockResolvedValueOnce(makeItemListResponse([]));

      for await (const _ of connector.sync({
        config: { ...validConfig, folderPath: "Documents/Reports" },
        credentials,
        checkpoint: null,
      })) {
        // consume
      }

      const itemsUrl = (fetchMock.mock.calls[3] as unknown[])[0] as string;
      expect(itemsUrl).toContain("root:/Documents/Reports:/delta");
    });

    it("does not double-encode pre-encoded folderPath segments", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeDefaultDriveResponse());
      fetchMock.mockResolvedValueOnce(makeItemListResponse([]));

      // "Shared%20Documents" is already percent-encoded; the URL must not
      // become "Shared%2520Documents" after encodeFolderPath re-encodes it.
      for await (const _ of connector.sync({
        config: { ...validConfig, folderPath: "Shared%20Documents/Reports" },
        credentials,
        checkpoint: null,
      })) {
        // consume
      }

      const itemsUrl = (fetchMock.mock.calls[3] as unknown[])[0] as string;
      expect(itemsUrl).toContain("root:/Shared%20Documents/Reports:/delta");
      expect(itemsUrl).not.toContain("%2520");
    });

    it("uses delta query when checkpoint has deltaLink", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const item = makeDriveItem("delta-item", "changed.txt", {
        lastModified: "2024-02-01T00:00:00.000Z",
      });

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeDefaultDriveResponse());
      // Delta response
      fetchMock.mockResolvedValueOnce(
        makeItemListResponse([item], {
          deltaLink: "https://graph.microsoft.com/v1.0/new-delta-link",
        }),
      );
      fetchMock.mockResolvedValueOnce(makeContentResponse("Changed content"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: {
          type: "sharepoint",
          lastSyncedAt: "2024-01-15T00:00:00.000Z",
          deltaLink: "https://graph.microsoft.com/v1.0/old-delta-link",
        },
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("changed.txt");

      // Delta URL should have been called
      const deltaUrl = (fetchMock.mock.calls[3] as unknown[])[0] as string;
      expect(deltaUrl).toContain("old-delta-link");

      // New deltaLink should be in checkpoint
      const cp = batches[0].checkpoint as Record<string, unknown>;
      expect(cp.deltaLink).toBe(
        "https://graph.microsoft.com/v1.0/new-delta-link",
      );
    });

    it("records failure and continues when file download fails", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const items = [
        makeDriveItem("good-item", "good.txt"),
        makeDriveItem("bad-item", "bad.txt"),
        makeDriveItem("another-good", "ok.txt"),
      ];

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeDefaultDriveResponse());
      fetchMock.mockResolvedValueOnce(makeItemListResponse(items));
      fetchMock.mockResolvedValueOnce(makeContentResponse("Good content"));
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      } as unknown as Response);
      fetchMock.mockResolvedValueOnce(makeContentResponse("OK content"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(2);
      expect(batches[0].failures).toHaveLength(1);
      expect(batches[0].failures?.[0].itemId).toBe("bad-item");
    });

    it("sets checkpoint lastSyncedAt from last item timestamp", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const items = [
        makeDriveItem("item-1", "first.txt", {
          lastModified: "2024-01-10T00:00:00.000Z",
        }),
        makeDriveItem("item-2", "second.txt", {
          lastModified: "2024-01-20T00:00:00.000Z",
        }),
      ];

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeDefaultDriveResponse());
      fetchMock.mockResolvedValueOnce(makeItemListResponse(items));
      fetchMock.mockResolvedValueOnce(makeContentResponse("First"));
      fetchMock.mockResolvedValueOnce(makeContentResponse("Second"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const cp = batches[0].checkpoint as Record<string, unknown>;
      expect(cp.type).toBe("sharepoint");
      expect(cp.lastSyncedAt).toBe("2024-01-20T00:00:00.000Z");
    });

    it("preserves previous checkpoint when batch has no items", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeDefaultDriveResponse());
      fetchMock.mockResolvedValueOnce(makeItemListResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: {
          type: "sharepoint",
          lastSyncedAt: "2024-01-01T00:00:00.000Z",
        },
      })) {
        batches.push(batch);
      }

      const cp = batches[0].checkpoint as Record<string, unknown>;
      expect(cp.lastSyncedAt).toBe("2024-01-01T00:00:00.000Z");
    });

    it("throws when drive items endpoint returns error", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeDefaultDriveResponse());
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "Access denied",
      } as unknown as Response);

      const generator = connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      });

      await expect(generator.next()).rejects.toThrow(
        "Failed to list drive items",
      );
    });

    it("includes metadata in document", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const item = makeDriveItem("item-1", "report.txt", {
        lastModified: "2024-03-01T08:00:00.000Z",
        size: 2048,
        mimeType: "text/plain",
      });

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeDefaultDriveResponse());
      fetchMock.mockResolvedValueOnce(makeItemListResponse([item]));
      fetchMock.mockResolvedValueOnce(makeContentResponse("Report text"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const metadata = batches[0].documents[0].metadata;
      expect(metadata.sharepointItemId).toBe("item-1");
      expect(metadata.fileName).toBe("report.txt");
      expect(metadata.mimeType).toBe("text/plain");
      expect(metadata.size).toBe(2048);
      expect(metadata.lastModifiedBy).toBe("Test User");
    });

    it("respects custom includeFileTypes filter", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const items = [
        makeDriveItem("item-1", "report.pdf"),
        makeDriveItem("item-2", "notes.txt"),
        makeDriveItem("item-3", "doc.docx"),
      ];

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeDefaultDriveResponse());
      fetchMock.mockResolvedValueOnce(makeItemListResponse(items));
      // Only .pdf should be downloaded
      fetchMock.mockResolvedValueOnce(makeContentResponse("PDF content"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, includeFileTypes: [".pdf"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("report.pdf");
    });

    it("saves nextLink in checkpoint during initial scan pagination", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const item1 = makeDriveItem("item-1", "first.txt");

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeDefaultDriveResponse());
      // First page: only nextLink (no deltaLink yet — mid-pagination)
      fetchMock.mockResolvedValueOnce(
        makeItemListResponse([item1], {
          nextLink: "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=page2",
        }),
      );
      fetchMock.mockResolvedValueOnce(makeContentResponse("First content"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
        // Simulate time-budget stop: only consume first batch
        break;
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].hasMore).toBe(true);
      const cp = batches[0].checkpoint as Record<string, unknown>;
      // nextLink must be persisted so the next run can resume from page 2
      expect(cp.nextLink).toBe(
        "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=page2",
      );
      // deltaLink not yet available from Graph
      expect(cp.deltaLink).toBeUndefined();
    });

    it("resumes initial scan from checkpoint nextLink instead of root/delta", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const item2 = makeDriveItem("item-2", "second.txt");

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeDefaultDriveResponse());
      // Resume from nextLink page — returns deltaLink on this final page
      fetchMock.mockResolvedValueOnce(
        makeItemListResponse([item2], {
          deltaLink: "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=final",
        }),
      );
      fetchMock.mockResolvedValueOnce(makeContentResponse("Second content"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: {
          type: "sharepoint",
          nextLink:
            "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=page2",
        },
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      // Should have fetched the nextLink URL, not root/delta
      const resumeUrl = (fetchMock.mock.calls[3] as unknown[])[0] as string;
      expect(resumeUrl).toContain("token=page2");
      // deltaLink now captured for future incremental syncs
      const cp = batches[0].checkpoint as Record<string, unknown>;
      expect(cp.deltaLink).toBe(
        "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=final",
      );
      expect(cp.nextLink).toBeUndefined();
    });

    it("resumes delta sync from checkpoint nextLink when pagination was interrupted", async () => {
      const connector = new SharePointConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const item = makeDriveItem("delta-item-2", "page2.txt", {
        lastModified: "2024-03-01T00:00:00.000Z",
      });

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeDefaultDriveResponse());
      // Resume from nextLink — final page returns new deltaLink
      fetchMock.mockResolvedValueOnce(
        makeItemListResponse([item], {
          deltaLink:
            "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=new-delta",
        }),
      );
      fetchMock.mockResolvedValueOnce(makeContentResponse("Page 2 content"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: {
          type: "sharepoint",
          lastSyncedAt: "2024-01-15T00:00:00.000Z",
          deltaLink:
            "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=old-delta",
          nextLink:
            "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=delta-page2",
        },
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      // Should have resumed from nextLink, not the old deltaLink
      const resumeUrl = (fetchMock.mock.calls[3] as unknown[])[0] as string;
      expect(resumeUrl).toContain("token=delta-page2");
      const cp = batches[0].checkpoint as Record<string, unknown>;
      expect(cp.deltaLink).toBe(
        "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=new-delta",
      );
      expect(cp.nextLink).toBeUndefined();
    });
  });
});
