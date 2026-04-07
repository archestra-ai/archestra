import { describe, expect, it, vi } from "vitest";
import type { ConnectorSyncBatch } from "@/types";
import { SharePointConnector } from "./sharepoint-connector";

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
  it("has the correct type", () => {
    const connector = new SharePointConnector();
    expect(connector.type).toBe("sharepoint");
  });

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
        .mockResolvedValueOnce({
          value: [
            makeDriveItem("item-1", "file1.txt", {
              lastModified: "2024-01-20T00:00:00.000Z",
            }),
            makeDriveItem("item-2", "old.txt", {
              lastModified: "2024-01-01T00:00:00.000Z",
            }),
            {
              ...makeDriveItem("item-3", "folder", {
                lastModified: "2024-01-20T00:00:00.000Z",
              }),
              file: undefined,
              folder: { childCount: 1 },
            },
          ],
        })
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
        .mockResolvedValueOnce({
          value: [
            makeDriveItem("item-1", "doc.txt"),
            {
              ...makeDriveItem("item-2", "photo.jpg"),
              file: { mimeType: "image/jpeg" },
            },
            {
              ...makeDriveItem("item-3", "spreadsheet.xlsx"),
              file: { mimeType: "application/vnd.openxmlformats" },
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
        .mockResolvedValueOnce({
          value: [],
        })
        .mockResolvedValueOnce({ value: [] });

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
    });

    it("throws when drive items endpoint returns error", async () => {
      const connector = new SharePointConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet
        .mockResolvedValueOnce({ id: "site-123" })
        .mockResolvedValueOnce({ value: [{ id: "drive-1" }] })
        .mockRejectedValueOnce(new Error("Forbidden")); // driveItems

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

  describe("checkpoint monotonicity", () => {
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
});
