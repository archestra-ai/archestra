import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorSyncBatch, PermissionSnapshotYield } from "@/types";
import { SharePointConnector } from "./sharepoint-connector";

// The SP REST tier acquires a second-audience token via ClientSecretCredential;
// keep AAD off the wire in tests.
vi.mock("@azure/identity", () => ({
  ClientSecretCredential: class {
    async getToken() {
      return { token: "sp-rest-token" };
    }
  },
}));

const credentials = { email: "test-client-id", apiToken: "test-client-secret" };

function makeFileBuffer(content: string): ArrayBuffer {
  return Buffer.from(content).buffer;
}

function makeDriveItem(
  id: string,
  name: string,
  opts?: { lastModified?: string; size?: number; webUrl?: string },
) {
  return {
    id,
    name,
    webUrl: opts?.webUrl ?? `https://tenant.sharepoint.com/sites/test/${name}`,
    lastModifiedDateTime: opts?.lastModified ?? "2024-01-15T10:00:00.000Z",
    createdDateTime: "2024-01-01T00:00:00.000Z",
    size: opts?.size ?? 1024,
    file: { mimeType: "text/plain" },
    parentReference: { path: "/drives/drive-1/root:" },
  };
}

function makeSitePage(
  id: string,
  title: string,
  opts?: { lastModified?: string },
) {
  return {
    id,
    name: `${title.toLowerCase().replace(/\s/g, "-")}.aspx`,
    title,
    webUrl: `https://tenant.sharepoint.com/sites/test/SitePages/${title}.aspx`,
    lastModifiedDateTime: opts?.lastModified ?? "2024-01-15T10:00:00.000Z",
    createdDateTime: "2024-01-01T00:00:00.000Z",
    description: `Description for ${title}`,
  };
}

/**
 * Set up a mock Graph client on the connector.
 * Returns the mockGet spy — used for all API calls including file downloads.
 * File downloads use .responseType(...).get() — the mock chains back to mockGet.
 */
function setupMockClient(connector: SharePointConnector) {
  const mockGet = vi.fn();
  const mockApiObj = {
    get: mockGet,
    responseType: vi.fn().mockReturnValue({ get: mockGet }),
  };
  const mockApi = vi.fn().mockReturnValue(mockApiObj);
  const mockClient = { api: mockApi };

  vi.spyOn(
    connector as unknown as { getGraphClient: () => unknown },
    "getGraphClient",
  ).mockReturnValue(mockClient as never);

  return { mockGet, mockApi };
}

describe("SharePointConnector", () => {
  describe("validateConfig", () => {
    it("accepts valid config with siteUrl", async () => {
      const connector = new SharePointConnector();
      const result = await connector.validateConfig({
        tenantId: "test-tenant-id",
        siteUrl: "https://tenant.sharepoint.com/sites/test",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts config with optional driveIds and folderPath", async () => {
      const connector = new SharePointConnector();
      const result = await connector.validateConfig({
        tenantId: "test-tenant-id",
        siteUrl: "https://tenant.sharepoint.com/sites/test",
        driveIds: ["drive-1"],
        folderPath: "Documents/Engineering",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects config without siteUrl", async () => {
      const connector = new SharePointConnector();
      const result = await connector.validateConfig({});
      expect(result.valid).toBe(false);
    });
  });

  describe("testConnection", () => {
    it("returns success when site resolves", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet.mockResolvedValueOnce({ id: "site-123" });

      const result = await connector.testConnection({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
      });

      expect(result.success).toBe(true);
    });

    it("returns failure when site cannot be resolved", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet.mockRejectedValueOnce({
        statusCode: 403,
        code: "accessDenied",
        requestId: "req-123",
        headers: {
          get: (name: string) =>
            name === "client-request-id" ? "client-456" : null,
        },
        body: JSON.stringify({
          error: {
            message: "Graph returned 403 Forbidden",
          },
        }),
        message: "Graph returned 403 Forbidden",
      });

      const result = await connector.testConnection({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/nonexistent",
        },
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        "Graph path: /sites/tenant.sharepoint.com:/sites/nonexistent",
      );
      expect(result.error).toContain("status: 403");
      expect(result.error).toContain("code: accessDenied");
      expect(result.error).toContain("request-id: req-123");
      expect(result.error).toContain("client-request-id: client-456");
      expect(result.error).toContain("message: Graph returned 403 Forbidden");
    });

    it("returns failure when Client ID is missing", async () => {
      const connector = new SharePointConnector();

      const result = await connector.testConnection({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials: { email: "", apiToken: "secret" },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Client ID is required");
    });

    it("includes the underlying site resolution error during sync", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet.mockRejectedValueOnce({
        statusCode: 403,
        body: JSON.stringify({
          error: {
            message: "Forbidden: Sites.Read.All required",
          },
        }),
        message: "Forbidden: Sites.Read.All required",
      });

      let thrown: unknown;
      try {
        for await (const _batch of connector.sync({
          config: {
            tenantId: "test-tenant-id",
            siteUrl: "https://tenant.sharepoint.com/sites/test",
          },
          credentials,
          checkpoint: null,
        })) {
          // no-op
        }
      } catch (error) {
        thrown = error;
      }

      const message =
        thrown instanceof Error ? thrown.message : String(thrown ?? "");
      expect(message).toContain(
        "Graph path: /sites/tenant.sharepoint.com:/sites/test",
      );
      expect(message).toContain("status: 403");
      expect(message).toContain("message: Forbidden: Sites.Read.All required");
    });
  });

  describe("estimateTotalItems", () => {
    it("estimates eligible drive items and site pages using the same sync filters", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        .mockResolvedValueOnce({ value: [{ id: "drive-1" }] })
        // countFilesInFolder("root") runs first (for-await natural order)
        .mockResolvedValueOnce({
          value: [
            makeDriveItem("item-1", "file1.txt", {
              lastModified: "2024-01-20T00:00:00.000Z",
            }),
            makeDriveItem("item-2", "old.txt", {
              lastModified: "2024-01-01T00:00:00.000Z",
            }),
          ],
        })
        // listDirectSubfolders("root") → returns item-3 (called after root body)
        .mockResolvedValueOnce({
          value: [
            {
              id: "item-3",
              folder: { childCount: 1 },
              file: undefined,
            },
          ],
        })
        // countFilesInFolder("item-3") → empty
        .mockResolvedValueOnce({ value: [] })
        // listDirectSubfolders("item-3") → no nested subfolders
        .mockResolvedValueOnce({ value: [] })
        // countSitePages
        .mockResolvedValueOnce({
          value: [
            makeSitePage("page-1", "Included page", {
              lastModified: "2024-01-20T00:00:00.000Z",
            }),
            makeSitePage("page-2", "Old page", {
              lastModified: "2024-01-01T00:00:00.000Z",
            }),
          ],
        });

      const result = await connector.estimateTotalItems({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
          includePages: true,
        },
        credentials,
        checkpoint: {
          type: "sharepoint",
          lastSyncedAt: "2024-01-15T12:00:00.000Z",
        },
      });

      expect(result).toBe(2);
    });
  });

  describe("sync — drive items", () => {
    it("syncs text files from drive", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet
        .mockResolvedValueOnce({ id: "site-123" }) // resolveSiteId
        .mockResolvedValueOnce({ value: [{ id: "drive-1" }] }) // listDriveIds
        .mockResolvedValueOnce({ value: [] }) // listDirectSubfolders("root")
        .mockResolvedValueOnce({
          value: [
            makeDriveItem("item-1", "readme.md"),
            makeDriveItem("item-2", "notes.txt"),
          ],
        }) // driveItems
        .mockResolvedValueOnce(makeFileBuffer("# Hello World")) // readme.md download
        .mockResolvedValueOnce(makeFileBuffer("Some notes")) // notes.txt download
        .mockResolvedValueOnce({ value: [] }); // sitePages

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches.length).toBeGreaterThanOrEqual(1);
      const driveBatch = batches[0];
      expect(driveBatch.documents).toHaveLength(2);
      expect(driveBatch.documents[0].title).toBe("readme.md");
      expect(driveBatch.documents[0].content).toContain("# Hello World");
      expect(driveBatch.documents[1].title).toBe("notes.txt");
    });

    it("skips unsupported file types", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        .mockResolvedValueOnce({ value: [{ id: "drive-1" }] })
        .mockResolvedValueOnce({ value: [] }) // listDirectSubfolders("root")
        .mockResolvedValueOnce({
          value: [
            makeDriveItem("item-1", "doc.txt"),
            {
              ...makeDriveItem("item-2", "photo.jpg"),
              file: { mimeType: "image/jpeg" },
            },
            {
              ...makeDriveItem("item-3", "archive.zip"),
              file: { mimeType: "application/zip" },
            },
          ],
        })
        .mockResolvedValueOnce(makeFileBuffer("Text content")) // doc.txt download
        .mockResolvedValueOnce({ value: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("doc.txt");
    });

    it("paginates drive items using @odata.nextLink", async () => {
      const connector = new SharePointConnector();
      const { mockGet, mockApi } = setupMockClient(connector);

      const nextLinkUrl =
        "https://graph.microsoft.com/v1.0/drives/drive-1/root/children?$skiptoken=abc";

      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        .mockResolvedValueOnce({ value: [{ id: "drive-1" }] })
        .mockResolvedValueOnce({ value: [] }) // listDirectSubfolders("root")
        .mockResolvedValueOnce({
          value: [makeDriveItem("item-1", "file1.txt")],
          "@odata.nextLink": nextLinkUrl,
        })
        .mockResolvedValueOnce(makeFileBuffer("Content 1")) // file1.txt download
        .mockResolvedValueOnce({
          value: [makeDriveItem("item-2", "file2.txt")],
        })
        .mockResolvedValueOnce(makeFileBuffer("Content 2")) // file2.txt download
        .mockResolvedValueOnce({ value: [] }); // sitePages

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches.length).toBeGreaterThanOrEqual(2);
      expect(batches[0].documents[0].title).toBe("file1.txt");
      expect(batches[1].documents[0].title).toBe("file2.txt");

      // Second drive page call should use the nextLink URL
      const apiCalls = mockApi.mock.calls.map((c) => c[0] as string);
      expect(apiCalls.some((u) => u === nextLinkUrl)).toBe(true);
    });

    it("preserves path separators when folderPath contains nested folders", async () => {
      const connector = new SharePointConnector();
      const { mockGet, mockApi } = setupMockClient(connector);

      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        .mockResolvedValueOnce({ value: [] }) // listDirectSubfolders("root") with folderPath
        .mockResolvedValueOnce({ value: [] }) // syncFilesInFolder("root")
        .mockResolvedValueOnce({ value: [] }); // sitePages

      for await (const _batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
          driveIds: ["drive-1"],
          folderPath: "General/Documents & Files/Engineering",
        },
        credentials,
        checkpoint: null,
      })) {
        // no-op
      }

      const apiCalls = mockApi.mock.calls.map((call) => call[0] as string);
      expect(
        apiCalls.some((url) =>
          url.includes(
            "/drives/drive-1/root:/General/Documents%20%26%20Files/Engineering:/children",
          ),
        ),
      ).toBe(true);
    });

    it("skips items older than checkpoint via client-side filter", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      const checkpointTime = "2024-01-15T12:00:00.000Z";
      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        .mockResolvedValueOnce({ value: [{ id: "drive-1" }] })
        .mockResolvedValueOnce({ value: [] }) // listDirectSubfolders("root")
        .mockResolvedValueOnce({
          value: [
            // older than checkpoint — should be skipped
            makeDriveItem("item-1", "old.txt", {
              lastModified: "2024-01-10T00:00:00.000Z",
            }),
            // newer than checkpoint (minus safety buffer) — should be included
            makeDriveItem("item-2", "new.txt", {
              lastModified: "2024-01-20T00:00:00.000Z",
            }),
          ],
        })
        .mockResolvedValueOnce(makeFileBuffer("New content")) // new.txt download
        .mockResolvedValueOnce({ value: [] }); // sitePages

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: {
          type: "sharepoint",
          lastSyncedAt: checkpointTime,
        },
      })) {
        batches.push(batch);
      }

      // Only new.txt (after checkpoint) should be returned
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("new.txt");
    });

    it("compares checkpoint dates by timestamp, not raw string format", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        .mockResolvedValueOnce({ value: [{ id: "drive-1" }] })
        .mockResolvedValueOnce({ value: [] }) // listDirectSubfolders("root")
        .mockResolvedValueOnce({
          value: [
            makeDriveItem("item-1", "same-moment.txt", {
              lastModified: "2024-01-15T12:00:00+00:00",
            }),
          ],
        })
        .mockResolvedValueOnce(makeFileBuffer("same instant"))
        .mockResolvedValueOnce({ value: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: {
          type: "sharepoint",
          lastSyncedAt: "2024-01-15T12:00:00.000Z",
        },
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("same-moment.txt");
    });

    it("skips item and records failure when file download fails", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        .mockResolvedValueOnce({ value: [{ id: "drive-1" }] })
        .mockResolvedValueOnce({ value: [] }) // listDirectSubfolders("root")
        .mockResolvedValueOnce({
          value: [
            makeDriveItem("item-1", "good.txt"),
            makeDriveItem("item-2", "bad.txt"),
          ],
        })
        .mockResolvedValueOnce(makeFileBuffer("Good content")) // good.txt download
        .mockRejectedValueOnce(new Error("Internal Server Error")) // bad.txt download fails
        .mockResolvedValueOnce({ value: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("good.txt");
      const failures = batches[0].failures ?? [];
      expect(failures).toHaveLength(1);
      expect(failures[0]?.itemId).toBe("item-2");
      expect(failures[0]?.itemUnavailable).toBe(true);
    });

    it("reports a file with no extractable text as a categorized skip naming the file", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      // Standalone ArrayBuffer (not from the Node.js pool — see the image sync
      // test) so the download yields exactly these whitespace bytes.
      const blankBytes = Buffer.from("   \n  ");
      const blankArrayBuffer: ArrayBuffer = blankBytes.buffer.slice(
        blankBytes.byteOffset,
        blankBytes.byteOffset + blankBytes.byteLength,
      );

      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        .mockResolvedValueOnce({ value: [{ id: "drive-1" }] })
        .mockResolvedValueOnce({ value: [] }) // listDirectSubfolders("root")
        .mockResolvedValueOnce({
          value: [makeDriveItem("item-1", "blank.txt")],
        })
        .mockResolvedValueOnce(blankArrayBuffer) // whitespace-only content
        .mockResolvedValueOnce({ value: [] }); // sitePages

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(0);
      expect(batches[0].skipped).toHaveLength(1);
      const skip = batches[0].skipped?.[0];
      expect(skip?.name).toBe("blank.txt");
      expect(skip?.category).toBe("no_extractable_text");
      expect(skip?.sourceScope).toEqual({
        metadataField: "driveId",
        value: "drive-1",
      });
    });

    it("throws when drive items endpoint returns error", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        .mockResolvedValueOnce({ value: [{ id: "drive-1" }] })
        .mockResolvedValueOnce({ value: [] }) // listDirectSubfolders("root")
        .mockRejectedValueOnce(new Error("Forbidden")); // syncFilesInFolder

      const generator = connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      });
      await expect(generator.next()).rejects.toThrow(
        "Drive items query failed",
      );
    });

    it("reports unsupported drive files with the unsupported-type category", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        .mockResolvedValueOnce({ value: [{ id: "drive-1" }] })
        .mockResolvedValueOnce({ value: [] }) // listDirectSubfolders("root")
        .mockResolvedValueOnce({
          value: [makeDriveItem("item-1", "archive.exe")],
        })
        .mockResolvedValueOnce({ value: [] }); // sitePages

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toEqual([]);
      expect(batches[0].skipped).toEqual([
        {
          itemId: "item-1",
          name: "archive.exe",
          reason: "unsupported_file_type",
          category: "unsupported_type",
          sourceScope: { metadataField: "driveId", value: "drive-1" },
        },
      ]);
    });
  });

  describe("sync — site pages", () => {
    it("syncs site pages with web part content", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        .mockResolvedValueOnce({ value: [] }) // listDriveIds (empty)
        .mockResolvedValueOnce({
          value: [makeSitePage("page-1", "Welcome Page")],
        }) // sitePages
        .mockResolvedValueOnce({
          value: [
            { innerHtml: "<p>Hello <b>world</b></p>" },
            { innerHtml: "<div>More content</div>" },
          ],
        }); // webParts for page-1

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const pageBatch = batches[batches.length - 1];
      expect(pageBatch.documents).toHaveLength(1);
      expect(pageBatch.documents[0].title).toBe("Welcome Page");
      expect(pageBatch.documents[0].content).toContain("Hello world");
      expect(pageBatch.documents[0].content).toContain("More content");
      expect(pageBatch.documents[0].id).toBe("page-page-1");
    });

    it("marks site-page text that exceeds the connector indexing limit", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        .mockResolvedValueOnce({ value: [] })
        .mockResolvedValueOnce({
          value: [makeSitePage("page-1", "Long Page")],
        })
        .mockResolvedValueOnce({
          value: [{ innerHtml: `<p>${"x".repeat(500_001)}</p>` }],
        });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const page = batches.at(-1)?.documents[0];
      expect(page?.contentTruncation).toMatchObject({
        originalCharacterCount: 500_001,
        indexedCharacterCount: 500_000,
      });
    });

    it("reports a page with no extractable content as a categorized skip naming the page", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        .mockResolvedValueOnce({ value: [] }) // listDriveIds (empty)
        .mockResolvedValueOnce({
          value: [makeSitePage("page-1", "Empty Page")],
        }) // sitePages
        .mockResolvedValueOnce({ value: [] }); // webParts for page-1 — no content

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const pageBatch = batches[batches.length - 1];
      expect(pageBatch.documents).toHaveLength(0);
      expect(pageBatch.skipped).toHaveLength(1);
      const skip = pageBatch.skipped?.[0];
      expect(skip?.name).toBe("Empty Page");
      expect(skip?.sourceId).toBe("page-page-1");
      expect(skip?.category).toBe("no_extractable_text");
      expect(skip?.reason).toBe("Page has no extractable content");
    });

    it("sets checkpoint from last page lastModifiedDateTime", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        .mockResolvedValueOnce({ value: [] })
        .mockResolvedValueOnce({
          value: [
            makeSitePage("page-1", "First", {
              lastModified: "2024-02-01T00:00:00.000Z",
            }),
            makeSitePage("page-2", "Second", {
              lastModified: "2024-03-01T00:00:00.000Z",
            }),
          ],
        })
        .mockResolvedValueOnce({ value: [] }) // webParts for page-1
        .mockResolvedValueOnce({ value: [] }); // webParts for page-2

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const cp = batches[batches.length - 1].checkpoint as Record<
        string,
        unknown
      >;
      expect(cp.lastSyncedAt).toBe("2024-03-01T00:00:00.000Z");
    });
  });

  describe("sync — config options", () => {
    it("uses specific driveIds when provided", async () => {
      const connector = new SharePointConnector();
      const { mockGet, mockApi } = setupMockClient(connector);

      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        // No listDriveIds call since driveIds provided
        .mockResolvedValueOnce({ value: [] }) // listDirectSubfolders("root")
        .mockResolvedValueOnce({
          value: [makeDriveItem("item-1", "file.txt")],
        })
        .mockResolvedValueOnce(makeFileBuffer("Content")) // file.txt download
        .mockResolvedValueOnce({ value: [] }); // sitePages

      for await (const _ of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
          driveIds: ["specific-drive"],
        },
        credentials,
        checkpoint: null,
      })) {
        // consume
      }

      const apiCalls = mockApi.mock.calls.map((c) => c[0] as string);
      expect(apiCalls.some((u) => u.includes("/drives/specific-drive/"))).toBe(
        true,
      );
      expect(apiCalls.some((u) => u.includes("/drives?$select=id"))).toBe(
        false,
      );
    });

    it("syncs image files when embeddingInputModalities includes image", async () => {
      const connector = new SharePointConnector();
      const { mockGet, mockApi } = setupMockClient(connector);

      // Use a standalone ArrayBuffer (not from Node.js pool) so Buffer.from(ab)
      // round-trips exactly to the original bytes.
      const imageContent = "fake-png-data";
      const imageBytes = Buffer.from(imageContent);
      const imageArrayBuffer: ArrayBuffer = imageBytes.buffer.slice(
        imageBytes.byteOffset,
        imageBytes.byteOffset + imageBytes.byteLength,
      );
      const expectedBase64 = imageBytes.toString("base64");

      mockGet
        .mockResolvedValueOnce({ id: "site-123" }) // resolveSiteId
        .mockResolvedValueOnce({ value: [{ id: "drive-1" }] }) // listDriveIds
        .mockResolvedValueOnce({ value: [] }) // listDirectSubfolders("root")
        .mockResolvedValueOnce({
          value: [makeDriveItem("item-1", "diagram.png")],
        }) // driveItems
        .mockResolvedValueOnce(imageArrayBuffer) // image download
        .mockResolvedValueOnce({ value: [] }); // sitePages

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
        embeddingInputModalities: ["text", "image"],
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      const doc = batches[0].documents[0];
      expect(doc.title).toBe("diagram.png");
      expect(doc.mediaContent).toBeDefined();
      expect(doc.mediaContent?.mimeType).toBe("image/png");
      expect(doc.mediaContent?.data).toBe(expectedBase64);

      const apiCalls = mockApi.mock.calls.map((c) => c[0] as string);
      expect(apiCalls.some((u) => u.includes("/content"))).toBe(true);
    });

    it("skips image files when embeddingInputModalities does not include image", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        .mockResolvedValueOnce({ value: [{ id: "drive-1" }] })
        .mockResolvedValueOnce({ value: [] }) // listDirectSubfolders("root")
        .mockResolvedValueOnce({
          value: [
            makeDriveItem("item-1", "doc.txt"),
            makeDriveItem("item-2", "photo.png"),
          ],
        })
        .mockResolvedValueOnce(makeFileBuffer("Text content")) // doc.txt download
        .mockResolvedValueOnce({ value: [] }); // sitePages (photo.png skipped)

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
        embeddingInputModalities: ["text"], // no "image"
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("doc.txt");
    });

    it("skips site pages when includePages is false", async () => {
      const connector = new SharePointConnector();
      const { mockGet, mockApi } = setupMockClient(connector);

      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        .mockResolvedValueOnce({ value: [] }); // listDriveIds

      for await (const _ of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
          includePages: false,
        },
        credentials,
        checkpoint: null,
      })) {
        // consume
      }

      const apiCalls = mockApi.mock.calls.map((c) => c[0] as string);
      expect(apiCalls.some((u) => u.includes("/pages"))).toBe(false);
    });
  });

  describe("sync — recursive traversal", () => {
    function makeFolderItem(id: string, name: string) {
      return {
        id,
        name,
        webUrl: `https://tenant.sharepoint.com/sites/test/${name}`,
        lastModifiedDateTime: "2024-01-15T10:00:00.000Z",
        createdDateTime: "2024-01-01T00:00:00.000Z",
        size: 0,
        file: undefined,
        folder: { childCount: 1 },
        parentReference: { path: "/drives/drive-1/root:" },
      };
    }

    it("traverses subfolders recursively by default", async () => {
      const connector = new SharePointConnector();
      const { mockGet, mockApi } = setupMockClient(connector);

      mockGet
        .mockResolvedValueOnce({ id: "site-123" }) // resolveSite
        .mockResolvedValueOnce({ value: [{ id: "drive-1" }] }) // listDriveIds
        // listDirectSubfolders("root") → returns folder-1
        .mockResolvedValueOnce({
          value: [makeFolderItem("folder-1", "Subfolder")],
        })
        // syncFilesInFolder("root") → one file
        .mockResolvedValueOnce({
          value: [makeDriveItem("root-file", "root.txt")],
        })
        .mockResolvedValueOnce(makeFileBuffer("Root content")) // root.txt download
        // listDirectSubfolders("folder-1") → no subfolders
        .mockResolvedValueOnce({ value: [] })
        // syncFilesInFolder("folder-1") → one file
        .mockResolvedValueOnce({
          value: [makeDriveItem("sub-file", "sub.txt")],
        })
        .mockResolvedValueOnce(makeFileBuffer("Sub content")) // sub.txt download
        .mockResolvedValueOnce({ value: [] }); // sitePages

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs.map((d) => d.title)).toContain("root.txt");
      expect(allDocs.map((d) => d.title)).toContain("sub.txt");

      // Verify subfolder children URL was called (listDirectSubfolders or syncFilesInFolder)
      const apiCalls = mockApi.mock.calls.map((c) => c[0] as string);
      expect(
        apiCalls.some((u) =>
          u.includes("/drives/drive-1/items/folder-1/children"),
        ),
      ).toBe(true);
    });

    it("does not traverse subfolders when recursive is false", async () => {
      const connector = new SharePointConnector();
      const { mockGet, mockApi } = setupMockClient(connector);

      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        .mockResolvedValueOnce({ value: [{ id: "drive-1" }] })
        // syncFilesInFolder("root") — no listDirectSubfolders called when recursive=false
        .mockResolvedValueOnce({
          value: [makeDriveItem("root-file", "root.txt")],
        })
        .mockResolvedValueOnce(makeFileBuffer("Root content")) // root.txt
        .mockResolvedValueOnce({ value: [] }); // sitePages

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
          recursive: false,
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs.map((d) => d.title)).toContain("root.txt");
      expect(allDocs.map((d) => d.title)).not.toContain("sub.txt");

      // Neither listDirectSubfolders nor syncFilesInFolder for folder-1
      const apiCalls = mockApi.mock.calls.map((c) => c[0] as string);
      expect(apiCalls.some((u) => u.includes("/items/folder-1/children"))).toBe(
        false,
      );
    });

    it("respects maxDepth and stops at the configured depth limit", async () => {
      const connector = new SharePointConnector();
      const { mockGet, mockApi } = setupMockClient(connector);

      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        .mockResolvedValueOnce({ value: [{ id: "drive-1" }] })
        // listDirectSubfolders("root") → returns folder-1
        .mockResolvedValueOnce({
          value: [makeFolderItem("folder-1", "Level1")],
        })
        // syncFilesInFolder("root") → one file
        .mockResolvedValueOnce({
          value: [makeDriveItem("file-0", "level0.txt")],
        })
        .mockResolvedValueOnce(makeFileBuffer("Level 0 content"))
        // listDirectSubfolders("folder-1") NOT called: depth(1) >= maxDepth(1)
        // syncFilesInFolder("folder-1") → one file + one nested folder (folder filtered out)
        .mockResolvedValueOnce({
          value: [
            makeDriveItem("file-1", "level1.txt"),
            makeFolderItem("folder-2", "Level2"),
          ],
        })
        .mockResolvedValueOnce(makeFileBuffer("Level 1 content"))
        .mockResolvedValueOnce({ value: [] }); // sitePages

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
          recursive: true,
          maxDepth: 1,
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const apiCalls = mockApi.mock.calls.map((c) => c[0] as string);
      // syncFilesInFolder("folder-1") was called — has /items/folder-1/children
      expect(apiCalls.some((u) => u.includes("/items/folder-1/children"))).toBe(
        true,
      );
      // folder-2 never reached: listDirectSubfolders("folder-1") not called, syncFilesInFolder("folder-2") not called
      expect(apiCalls.some((u) => u.includes("/items/folder-2/children"))).toBe(
        false,
      );

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs.map((d) => d.title)).toContain("level0.txt");
      expect(allDocs.map((d) => d.title)).toContain("level1.txt");
    });
  });

  describe("checkpoint monotonicity", () => {
    it("keeps previous checkpoint on intermediate batches so resumed run re-visits unprocessed folders", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      const previousCheckpoint = "2024-01-01T00:00:00.000Z";
      const page1Timestamp = "2024-05-01T00:00:00.000Z";
      const page2Timestamp = "2024-06-01T00:00:00.000Z";
      const nextLinkUrl =
        "https://graph.microsoft.com/v1.0/drives/drive-1/root/children?$skiptoken=abc";

      mockGet
        // resolveSiteId
        .mockResolvedValueOnce({ id: "site-1" })
        // listDriveIds
        .mockResolvedValueOnce({ value: [{ id: "drive-1" }] })
        // listDirectSubfolders("root") → no subfolders
        .mockResolvedValueOnce({ value: [] })
        // syncFilesInFolder("root") page 1 — has nextLink (more pages)
        .mockResolvedValueOnce({
          value: [
            makeDriveItem("file-1", "page1.txt", {
              lastModified: page1Timestamp,
            }),
          ],
          "@odata.nextLink": nextLinkUrl,
        })
        .mockResolvedValueOnce(makeFileBuffer("Page 1 content"))
        // syncFilesInFolder("root") page 2 — final page
        .mockResolvedValueOnce({
          value: [
            makeDriveItem("file-2", "page2.txt", {
              lastModified: page2Timestamp,
            }),
          ],
        })
        .mockResolvedValueOnce(makeFileBuffer("Page 2 content"))
        // sitePages
        .mockResolvedValueOnce({ value: [] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: {
          type: "sharepoint",
          lastSyncedAt: previousCheckpoint,
        },
      })) {
        batches.push(batch);
      }

      // At least 2 drive batches (page1, page2) + optional pages batch
      expect(batches.length).toBeGreaterThanOrEqual(2);

      // First batch (page 1, hasMore=true due to nextLink): checkpoint must NOT
      // advance — keeps previousCheckpoint so resumed run starts before any
      // not-yet-visited content (e.g. subfolders with older file timestamps).
      const firstBatch = batches[0];
      expect(firstBatch.hasMore).toBe(true);
      const firstCheckpoint = firstBatch.checkpoint as { lastSyncedAt: string };
      expect(firstCheckpoint.lastSyncedAt).toBe(
        new Date(previousCheckpoint).toISOString(),
      );

      // Final drive batch (page 2, hasMore=false): checkpoint advances to max seen
      const lastDriveBatch = batches.find(
        (b) => !b.hasMore && b.documents.some((d) => d.title === "page2.txt"),
      );
      expect(lastDriveBatch).toBeDefined();
      const finalCheckpoint = lastDriveBatch?.checkpoint as {
        lastSyncedAt: string;
      };
      expect(finalCheckpoint.lastSyncedAt).toBe(
        new Date(page2Timestamp).toISOString(),
      );
    });

    it("does not regress checkpoint when pages have older timestamps than drive items", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      const driveTimestamp = "2024-03-01T10:00:00.000Z";
      const pageTimestamp = "2024-01-15T08:00:00.000Z";

      mockGet
        // resolveSiteId
        .mockResolvedValueOnce({ id: "site-1" })
        // listDriveIds
        .mockResolvedValueOnce({ value: [{ id: "drive-1" }] })
        // listDirectSubfolders("root")
        .mockResolvedValueOnce({ value: [] })
        // drive items — newer timestamp
        .mockResolvedValueOnce({
          value: [
            makeDriveItem("d1", "report.txt", { lastModified: driveTimestamp }),
          ],
        })
        // download file content
        .mockResolvedValueOnce(makeFileBuffer("Report content"))
        // site pages — older timestamp
        .mockResolvedValueOnce({
          value: [
            makeSitePage("p1", "Old Page", { lastModified: pageTimestamp }),
          ],
        })
        // page webParts
        .mockResolvedValueOnce({ value: [{ innerHtml: "<p>Page text</p>" }] });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Should have 2 batches: one from drives, one from pages
      expect(batches.length).toBe(2);

      // The final checkpoint (from the pages batch) must NOT regress
      // to the older page timestamp — it must keep the drive timestamp
      const finalCheckpoint = batches[batches.length - 1].checkpoint as {
        lastSyncedAt: string;
      };
      expect(finalCheckpoint.lastSyncedAt).toBe(
        new Date(driveTimestamp).toISOString(),
      );

      // Verify it did NOT use the older page timestamp
      expect(finalCheckpoint.lastSyncedAt).not.toBe(
        new Date(pageTimestamp).toISOString(),
      );
    });
  });

  describe("permission sync", () => {
    type ContainerYield = Extract<
      PermissionSnapshotYield,
      { kind: "container" }
    >;
    type DocumentYield = Extract<PermissionSnapshotYield, { kind: "document" }>;

    const permConfig = {
      type: "sharepoint",
      tenantId: "tenant-id",
      siteUrl: "https://tenant.sharepoint.com/sites/test",
      driveIds: ["D1"],
      includePages: false,
    };

    /** Route table: url substring → response body, or a thrown Graph error. */
    let routes: Array<{
      match: string;
      body?: unknown;
      error?: { statusCode: number };
      /** Only match when the Prefer header contains this. */
      prefer?: string;
    }>;
    let requestedUrls: string[];
    let fetchMock: ReturnType<typeof vi.fn>;

    function routeFor(url: string, prefer: string | null) {
      const route = routes.find(
        (r) =>
          url.includes(r.match) &&
          (r.prefer === undefined || (prefer ?? "").includes(r.prefer)),
      );
      if (route?.error) {
        const err = new Error("Graph error") as Error & {
          statusCode: number;
        };
        err.statusCode = route.error.statusCode;
        throw err;
      }
      if (!route) throw new Error(`No route for ${url}`);
      return route.body;
    }

    function installClient(connector: SharePointConnector) {
      const mockApi = vi.fn((url: string) => {
        let prefer: string | null = null;
        const chain = {
          get: () => {
            requestedUrls.push(url);
            return Promise.resolve(routeFor(url, prefer));
          },
          header: (name: string, value: string) => {
            if (name === "Prefer") prefer = value;
            return chain;
          },
          responseType: () => chain,
        };
        return chain;
      });
      vi.spyOn(
        connector as unknown as { getGraphClient: () => unknown },
        "getGraphClient",
      ).mockReturnValue({ api: mockApi } as never);
    }

    function readBack(docs: Array<{ sourceId: string; driveId?: string }>) {
      return vi.fn(
        async (args: {
          metadataFilter?: Record<string, string>;
          afterId?: string | null;
          limit: number;
        }) => ({
          documents: docs
            .filter(
              (d) =>
                !args.metadataFilter?.driveId ||
                d.driveId === args.metadataFilter.driveId,
            )
            .map((d) => ({
              sourceId: d.sourceId,
              metadata: d.driveId ? { driveId: d.driveId } : null,
            })),
          nextAfterId: null,
        }),
      );
    }

    function syncParams(overrides?: {
      config?: Record<string, unknown>;
      docs?: Array<{ sourceId: string; driveId?: string }>;
    }) {
      return {
        config: overrides?.config ?? permConfig,
        credentials,
        cursor: null,
        readIngestedDocuments: readBack(
          overrides?.docs ?? [{ sourceId: "I1", driveId: "D1" }],
        ),
      };
    }

    function collectSnapshot(
      gen: AsyncGenerator<PermissionSnapshotYield> | undefined,
    ) {
      const containers = new Map<string, ContainerYield>();
      const documents: DocumentYield[] = [];
      return (async () => {
        for await (const item of gen ??
          ((async function* () {})() as AsyncGenerator<PermissionSnapshotYield>)) {
          if (item.kind === "container")
            containers.set(item.containerKey, item);
          else documents.push(item);
        }
        return { containers, documents };
      })();
    }

    /** The default delta walk: root + one plain file. */
    function stubDeltaWalk(items: unknown[]) {
      routes.push({
        match: "/drives/D1/root/delta",
        body: { value: items, "@odata.deltaLink": "delta-link-1" },
      });
    }

    beforeEach(() => {
      routes = [
        {
          match: "/sites/tenant.sharepoint.com:/sites/test",
          body: { id: "site-1" },
        },
      ];
      requestedUrls = [];
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });

    it("supportsPermissionSync is true", () => {
      expect(new SharePointConnector().supportsPermissionSync).toBe(true);
    });

    it("drive container: root audience from the root permission list; plain items assign to it", async () => {
      const connector = new SharePointConnector();
      installClient(connector);
      stubDeltaWalk([
        { id: "root", parentReference: {} },
        { id: "I1", parentReference: { id: "root" } },
      ]);
      routes.push({
        match: "/drives/D1/root/permissions",
        body: {
          value: [
            {
              grantedToV2: {
                siteUser: {
                  loginName: "i:0#.f|membership|Alice@Example.com",
                },
              },
              roles: ["read"],
            },
          ],
        },
      });

      const { containers, documents } = await collectSnapshot(
        connector.syncPermissionSnapshot(syncParams()),
      );

      expect(containers.get("drive:D1")?.permissions).toEqual({
        isPublic: false,
        users: ["alice@example.com"],
        groups: [],
      });
      expect(documents).toEqual([
        {
          kind: "document",
          sourceId: "I1",
          containerKey: "drive:D1",
          cursor: "drive:D1",
        },
      ]);
      // No per-item permission reads for non-exception items.
      expect(requestedUrls.filter((u) => u.includes("/items/")).length).toBe(0);
    });

    it("a document under a uniquely-permissioned folder joins that folder's nested container", async () => {
      const connector = new SharePointConnector();
      installClient(connector);
      stubDeltaWalk([
        { id: "root", parentReference: {} },
        { id: "F", parentReference: { id: "root" }, shared: {} },
        { id: "I1", parentReference: { id: "F" } },
      ]);
      routes.push(
        {
          match: "/drives/D1/root/permissions",
          body: {
            value: [
              {
                grantedToV2: {
                  siteUser: {
                    loginName: "i:0#.f|membership|root@example.com",
                  },
                },
                roles: ["read"],
              },
            ],
          },
        },
        {
          match: "/drives/D1/items/F/permissions",
          body: {
            value: [
              {
                grantedToV2: {
                  siteUser: {
                    loginName: "i:0#.f|membership|folder@example.com",
                  },
                },
                roles: ["read"],
              },
            ],
          },
        },
      );

      const { containers, documents } = await collectSnapshot(
        connector.syncPermissionSnapshot(syncParams()),
      );

      expect(containers.get("drive:D1/item:F")?.permissions.users).toEqual([
        "folder@example.com",
      ]);
      expect(documents[0]?.containerKey).toBe("drive:D1/item:F");
    });

    it("anonymous link → isPublic; organization link expands tenant users (User.Read.All tier)", async () => {
      const connector = new SharePointConnector();
      installClient(connector);
      stubDeltaWalk([
        { id: "root", parentReference: {} },
        { id: "I1", parentReference: { id: "root" } },
      ]);
      routes.push(
        {
          match: "/drives/D1/root/permissions",
          body: {
            value: [
              { link: { scope: "anonymous" }, roles: ["read"] },
              { link: { scope: "organization" }, roles: ["read"] },
            ],
          },
        },
        { match: "/users?$select=id&$top=1", body: { value: [] } },
        {
          match: "/users?$select=mail,userPrincipalName,accountEnabled",
          body: {
            value: [
              { mail: "on@example.com", accountEnabled: true },
              { mail: "off@example.com", accountEnabled: false },
            ],
          },
        },
      );

      const { containers } = await collectSnapshot(
        connector.syncPermissionSnapshot(syncParams()),
      );

      const audience = containers.get("drive:D1")?.permissions;
      expect(audience?.isPublic).toBe(true);
      expect(audience?.users).toEqual(["on@example.com"]);
    });

    it("organization links drop fail-closed when the users tier is denied", async () => {
      const connector = new SharePointConnector();
      installClient(connector);
      stubDeltaWalk([
        { id: "root", parentReference: {} },
        { id: "I1", parentReference: { id: "root" } },
      ]);
      routes.push(
        {
          match: "/drives/D1/root/permissions",
          body: {
            value: [{ link: { scope: "organization" }, roles: ["read"] }],
          },
        },
        {
          match: "/users?$select=id&$top=1",
          error: { statusCode: 403 },
        },
      );

      const { containers } = await collectSnapshot(
        connector.syncPermissionSnapshot(syncParams()),
      );

      expect(containers.get("drive:D1")?.permissions.users).toEqual([]);
    });

    it("Entra group grants emit the group ref; membership resolves via the roster", async () => {
      const connector = new SharePointConnector();
      installClient(connector);
      stubDeltaWalk([
        { id: "root", parentReference: {} },
        { id: "I1", parentReference: { id: "root" } },
      ]);
      routes.push({
        match: "/drives/D1/root/permissions",
        body: {
          value: [
            {
              grantedToV2: { group: { id: "g-1" } },
              roles: ["read"],
            },
          ],
        },
      });

      const first = await collectSnapshot(
        connector.syncPermissionSnapshot(syncParams()),
      );
      // The audience carries the group's IDENTITY at every tier — members
      // are the roster's concern (syncGroups), not the audience's.
      expect(first.containers.get("drive:D1")?.permissions).toEqual({
        isPublic: false,
        users: [],
        groups: ["entra:g-1"],
      });
    });

    it("SharePoint site-group grants emit the sitegroup ref", async () => {
      const connector = new SharePointConnector();
      installClient(connector);
      stubDeltaWalk([
        { id: "root", parentReference: {} },
        { id: "I1", parentReference: { id: "root" } },
      ]);
      routes.push({
        match: "/drives/D1/root/permissions",
        body: {
          value: [
            {
              grantedToV2: { siteGroup: { displayName: "Test Members" } },
              roles: ["read"],
            },
          ],
        },
      });

      const { containers } = await collectSnapshot(
        connector.syncPermissionSnapshot(syncParams()),
      );
      expect(containers.get("drive:D1")?.permissions).toEqual({
        isPublic: false,
        users: [],
        groups: ["sitegroup:Test Members"],
      });
      // No expansion happens on the audience path anymore.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("member override maps a direct grantee whose upstream email is hidden", async () => {
      const connector = new SharePointConnector();
      installClient(connector);
      stubDeltaWalk([
        { id: "root", parentReference: {} },
        { id: "I1", parentReference: { id: "root" } },
      ]);
      routes.push(
        {
          match: "/drives/D1/root/permissions",
          body: {
            value: [
              { grantedToV2: { user: { id: "u-hidden" } }, roles: ["read"] },
            ],
          },
        },
        // Users tier probes fine, but the account itself has no email.
        { match: "/users?", body: { value: [{ id: "probe" }] } },
        { match: "/users/u-hidden", body: { id: "u-hidden", mail: null } },
      );

      const { containers } = await collectSnapshot(
        connector.syncPermissionSnapshot({
          ...syncParams(),
          resolveMappedEmail: (accountId: string) =>
            accountId === "u-hidden" ? "Mapped@Corp.Test" : null,
        }),
      );
      expect(containers.get("drive:D1")?.permissions.users).toEqual([
        "mapped@corp.test",
      ]);
    });

    describe("syncGroups", () => {
      async function collectGroups(connector: SharePointConnector) {
        const out: Array<{
          groupId: string;
          members: Array<{
            accountId: string;
            displayName: string | null;
            email: string | null;
          }>;
        }> = [];
        for await (const g of connector.syncGroups(syncParams())) {
          out.push({
            groupId: g.groupId,
            members: g.members.map((m) => ({
              accountId: m.accountId,
              displayName: m.displayName,
              email: m.email,
            })),
          });
        }
        return out;
      }

      it("rosters Entra group members with byte-matching group ids", async () => {
        const connector = new SharePointConnector();
        installClient(connector);
        routes.push(
          {
            match: "/drives/D1/root/permissions",
            body: {
              value: [
                { grantedToV2: { group: { id: "g-1" } }, roles: ["read"] },
              ],
            },
          },
          {
            match: "/groups/g-1/transitiveMembers",
            body: {
              value: [
                {
                  id: "m1",
                  displayName: "Member One",
                  mail: "member@example.com",
                },
                { id: "m2", userPrincipalName: "upn@example.com", mail: null },
                {
                  id: "m3",
                  displayName: "Disabled",
                  mail: "off@example.com",
                  accountEnabled: false,
                },
              ],
            },
          },
        );

        expect(await collectGroups(connector)).toEqual([
          {
            groupId: "entra:g-1",
            members: [
              {
                accountId: "m1",
                displayName: "Member One",
                email: "member@example.com",
              },
              { accountId: "m2", displayName: null, email: "upn@example.com" },
              // Disabled accounts stay rostered but never resolve.
              { accountId: "m3", displayName: "Disabled", email: null },
            ],
          },
        ]);
      });

      it("expansion denial (403) yields members: [] — memberships fail closed", async () => {
        const connector = new SharePointConnector();
        installClient(connector);
        routes.push(
          {
            match: "/drives/D1/root/permissions",
            body: {
              value: [
                { grantedToV2: { group: { id: "g-1" } }, roles: ["read"] },
              ],
            },
          },
          {
            match: "/groups/g-1/transitiveMembers",
            error: { statusCode: 403 },
          },
        );

        expect(await collectGroups(connector)).toEqual([
          { groupId: "entra:g-1", members: [] },
        ]);
      });

      it("rosters SP site-group members via SP REST, flattening nested Entra claims", async () => {
        const connector = new SharePointConnector();
        installClient(connector);
        routes.push(
          {
            match: "/drives/D1/root/permissions",
            body: {
              value: [
                {
                  grantedToV2: { siteGroup: { displayName: "Test Members" } },
                  roles: ["read"],
                },
              ],
            },
          },
          {
            match: "/groups/g-9/transitiveMembers",
            body: { value: [{ id: "n1", mail: "nested@example.com" }] },
          },
        );
        fetchMock.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                Email: "Direct@Example.com",
                LoginName: "i:0#.f|membership|direct@example.com",
                Title: "Direct User",
              },
              { LoginName: "c:0o.c|federateddirectoryclaimprovider|g-9" },
            ],
          }),
        });

        expect(await collectGroups(connector)).toEqual([
          {
            groupId: "sitegroup:Test Members",
            members: [
              {
                accountId: "i:0#.f|membership|direct@example.com",
                displayName: "Direct User",
                email: "direct@example.com",
              },
              {
                accountId: "n1",
                displayName: null,
                email: "nested@example.com",
              },
            ],
          },
        ]);
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining(
            "/sites/test/_api/web/sitegroups/getbyname('Test%20Members')/users",
          ),
          expect.objectContaining({
            headers: expect.objectContaining({
              authorization: "Bearer sp-rest-token",
            }),
          }),
        );
      });

      it("SP REST denial (403) yields members: [] for the site group", async () => {
        const connector = new SharePointConnector();
        installClient(connector);
        routes.push({
          match: "/drives/D1/root/permissions",
          body: {
            value: [
              {
                grantedToV2: { siteGroup: { displayName: "Test Members" } },
                roles: ["read"],
              },
            ],
          },
        });
        fetchMock.mockResolvedValue({ ok: false, status: 403 });

        expect(await collectGroups(connector)).toEqual([
          { groupId: "sitegroup:Test Members", members: [] },
        ]);
      });

      it("direct grantees roster under direct-grants; hidden emails stay visible for assignment", async () => {
        const connector = new SharePointConnector();
        installClient(connector);
        routes.push(
          {
            match: "/drives/D1/root/permissions",
            body: {
              value: [
                {
                  grantedToV2: {
                    user: { id: "u-frank", displayName: "Frank NoEmail" },
                  },
                  roles: ["read"],
                },
                {
                  grantedToV2: {
                    siteUser: {
                      loginName: "i:0#.f|membership|Alice@Example.com",
                      displayName: "Alice QA",
                    },
                  },
                  roles: ["read"],
                },
              ],
            },
          },
          { match: "/users?", body: { value: [{ id: "probe" }] } },
          { match: "/users/u-frank", body: { id: "u-frank", mail: null } },
        );

        expect(await collectGroups(connector)).toEqual([
          {
            groupId: "direct-grants",
            members: [
              {
                accountId: "i:0#.f|membership|Alice@Example.com",
                displayName: "Alice QA",
                email: "alice@example.com",
              },
              {
                accountId: "u-frank",
                displayName: "Frank NoEmail",
                email: null,
              },
            ],
          },
        ]);
      });

      it("a failed surface read keeps that surface's groups un-yielded (previous roster preserved)", async () => {
        const connector = new SharePointConnector();
        installClient(connector);
        routes.push({
          match: "/drives/D1/root/permissions",
          error: { statusCode: 500 },
        });

        expect(await collectGroups(connector)).toEqual([]);
      });
    });

    it("empty corpus emits the boundary container without resolving an audience", async () => {
      const connector = new SharePointConnector();
      installClient(connector);
      stubDeltaWalk([]);

      const { containers, documents } = await collectSnapshot(
        connector.syncPermissionSnapshot(syncParams({ docs: [] })),
      );

      expect(containers.get("drive:D1")).toMatchObject({
        permissions: { isPublic: false, users: [], groups: [] },
        audienceResolutionFailed: false,
      });
      expect(documents).toEqual([]);
      expect(
        requestedUrls.filter((u) => u.includes("/permissions")).length,
      ).toBe(0);
    });

    it("root permission read failure fail-closes the container, never aborts", async () => {
      const connector = new SharePointConnector();
      installClient(connector);
      stubDeltaWalk([
        { id: "root", parentReference: {} },
        { id: "I1", parentReference: { id: "root" } },
      ]);
      routes.push({
        match: "/drives/D1/root/permissions",
        error: { statusCode: 500 },
      });

      const { containers, documents } = await collectSnapshot(
        connector.syncPermissionSnapshot(syncParams()),
      );

      expect(containers.get("drive:D1")).toMatchObject({
        audienceResolutionFailed: true,
        permissions: { isPublic: false, users: [], groups: [] },
      });
      expect(documents[0]?.containerKey).toBe("drive:D1");
    });

    it("item permission read failure fail-closes the nested container only", async () => {
      const connector = new SharePointConnector();
      installClient(connector);
      stubDeltaWalk([
        { id: "root", parentReference: {} },
        { id: "I1", parentReference: { id: "root" }, shared: {} },
      ]);
      routes.push(
        {
          match: "/drives/D1/root/permissions",
          body: {
            value: [
              {
                grantedToV2: {
                  siteUser: {
                    loginName: "i:0#.f|membership|root@example.com",
                  },
                },
                roles: ["read"],
              },
            ],
          },
        },
        {
          match: "/drives/D1/items/I1/permissions",
          error: { statusCode: 429 },
        },
      );

      const { containers, documents } = await collectSnapshot(
        connector.syncPermissionSnapshot(syncParams()),
      );

      expect(containers.get("drive:D1/item:I1")).toMatchObject({
        audienceResolutionFailed: true,
        permissions: { isPublic: false, users: [], groups: [] },
      });
      expect(documents[0]?.containerKey).toBe("drive:D1/item:I1");
    });

    it("site pages take the default drive's root audience", async () => {
      const connector = new SharePointConnector();
      installClient(connector);
      stubDeltaWalk([]); // drive D1: empty
      routes.push(
        { match: "/sites/site-1/drive", body: { id: "D0" } },
        {
          match: "/drives/D0/root/permissions",
          body: {
            value: [
              {
                grantedToV2: {
                  siteUser: {
                    loginName: "i:0#.f|membership|page@example.com",
                  },
                },
                roles: ["read"],
              },
            ],
          },
        },
      );

      const { containers, documents } = await collectSnapshot(
        connector.syncPermissionSnapshot(
          syncParams({
            config: { ...permConfig, includePages: true },
            docs: [{ sourceId: "page-9", driveId: undefined }],
          }),
        ),
      );

      expect(containers.get("site:site-1")?.permissions.users).toEqual([
        "page@example.com",
      ]);
      expect(documents.find((d) => d.sourceId === "page-9")?.containerKey).toBe(
        "site:site-1",
      );
    });

    it("probe: first probe captures latest tokens and requires full reconcile", async () => {
      const connector = new SharePointConnector();
      installClient(connector);
      routes.push({
        match: "/drives/D1/root/delta?token=latest",
        body: { "@odata.deltaLink": "dl-latest" },
      });

      const result = await connector.probePermissionChanges({
        config: permConfig,
        credentials,
        state: null,
      });

      expect(result.fullRequired).toBe(true);
      expect(result.nextState).toEqual({
        deltaTokens: { "drive:D1": "dl-latest" },
      });
    });

    it("probe: sharing-annotated items dirty the container; plain drift does not when elevated", async () => {
      const connector = new SharePointConnector();
      installClient(connector);
      routes.push({
        match: "delta-link-1",
        body: {
          value: [{ id: "I1", "@microsoft.graph.sharedChanged": "True" }],
          "@odata.deltaLink": "delta-link-2",
        },
      });

      const dirty = await connector.probePermissionChanges({
        config: permConfig,
        credentials,
        state: { deltaTokens: { "drive:D1": "delta-link-1" } },
      });
      expect(dirty).toEqual({
        dirtyContainerKeys: ["drive:D1"],
        fullRequired: false,
        nextState: { deltaTokens: { "drive:D1": "delta-link-2" } },
      });
    });

    it("probe: 403 on the sharing preference degrades to coarse probing (any item dirties)", async () => {
      const connector = new SharePointConnector();
      installClient(connector);
      routes.push(
        {
          match: "delta-link-1",
          prefer: "deltashowsharingchanges",
          error: { statusCode: 403 },
        },
        {
          match: "delta-link-1",
          body: {
            value: [{ id: "I9" }],
            "@odata.deltaLink": "delta-link-2",
          },
        },
      );

      const result = await connector.probePermissionChanges({
        config: permConfig,
        credentials,
        state: { deltaTokens: { "drive:D1": "delta-link-1" } },
      });

      expect(result.fullRequired).toBe(false);
      expect(result.dirtyContainerKeys).toEqual(["drive:D1"]);
    });

    it("probe: a rejected token (410) promotes to a full reconcile with fresh tokens", async () => {
      const connector = new SharePointConnector();
      installClient(connector);
      routes.push(
        { match: "delta-link-stale", error: { statusCode: 410 } },
        {
          match: "/drives/D1/root/delta?token=latest",
          body: { "@odata.deltaLink": "dl-fresh" },
        },
      );

      const result = await connector.probePermissionChanges({
        config: permConfig,
        credentials,
        state: { deltaTokens: { "drive:D1": "delta-link-stale" } },
      });

      expect(result.fullRequired).toBe(true);
      expect(result.nextState).toEqual({
        deltaTokens: { "drive:D1": "dl-fresh" },
      });
    });

    it("refreshContainerAudiences re-resolves drive + site containers and skips nested item keys", async () => {
      const connector = new SharePointConnector();
      installClient(connector);
      routes.push(
        {
          match: "/drives/D1/root/permissions",
          body: {
            value: [
              {
                grantedToV2: {
                  siteUser: {
                    loginName: "i:0#.f|membership|root@example.com",
                  },
                },
                roles: ["read"],
              },
            ],
          },
        },
        { match: "/sites/site-1/drive", body: { id: "D0" } },
        {
          match: "/drives/D0/root/permissions",
          body: { value: [] },
        },
      );

      const yields = [];
      for await (const item of connector.refreshContainerAudiences({
        config: { ...permConfig, includePages: true },
        credentials,
        containerKeys: ["drive:D1", "drive:D1/item:I1", "site:site-1"],
      }) ?? []) {
        yields.push(item);
      }

      expect(yields.map((y) => y.containerKey)).toEqual([
        "drive:D1",
        "site:site-1",
      ]);
      expect(yields[0]?.permissions.users).toEqual(["root@example.com"]);
      expect(requestedUrls.filter((u) => u.includes("/items/")).length).toBe(0);
    });

    it("scopeKeyForDocument maps driveId and siteId metadata to containers", () => {
      const connector = new SharePointConnector();
      expect(connector.scopeKeyForDocument({ driveId: "D1" })).toBe("drive:D1");
      expect(connector.scopeKeyForDocument({ siteId: "S1" })).toBe("site:S1");
      expect(connector.scopeKeyForDocument({})).toBeNull();
    });
  });
});
