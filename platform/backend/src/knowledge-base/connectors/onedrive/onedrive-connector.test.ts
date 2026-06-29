import { describe, expect, it, vi } from "vitest";
import type { ConnectorSyncBatch } from "@/types";
import { OneDriveConnector } from "./onedrive-connector";

const credentials = { email: "test-client-id", apiToken: "test-client-secret" };

const baseConfig = {
  tenantId: "test-tenant-id",
  userIds: ["user-1"],
};

function makeFileBuffer(content: string): ArrayBuffer {
  return Buffer.from(content).buffer;
}

function makeDriveItem(
  id: string,
  name: string,
  opts?: {
    lastModified?: string;
    size?: number;
    webUrl?: string;
    isFolder?: boolean;
  },
) {
  return {
    id,
    name,
    webUrl:
      opts?.webUrl ??
      `https://tenant-my.sharepoint.com/personal/user1/Documents/${name}`,
    lastModifiedDateTime: opts?.lastModified ?? "2024-01-15T10:00:00.000Z",
    createdDateTime: "2024-01-01T00:00:00.000Z",
    size: opts?.size ?? 1024,
    file: opts?.isFolder ? undefined : { mimeType: "text/plain" },
    folder: opts?.isFolder ? { childCount: 2 } : undefined,
    parentReference: { path: "/drives/drive-1/root:" },
  };
}

function setupMockClient(connector: OneDriveConnector) {
  const mockGet = vi.fn();
  const mockApiObj = {
    get: mockGet,
    select: vi.fn().mockReturnThis(),
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

describe("OneDriveConnector", () => {
  it("has the correct type", () => {
    const connector = new OneDriveConnector();
    expect(connector.type).toBe("onedrive");
  });

  describe("validateConfig", () => {
    it("accepts valid config with tenantId and userIds", async () => {
      const connector = new OneDriveConnector();
      const result = await connector.validateConfig(baseConfig);
      expect(result.valid).toBe(true);
    });

    it("rejects config without tenantId", async () => {
      const connector = new OneDriveConnector();
      const result = await connector.validateConfig({ userIds: ["user-1"] });
      expect(result.valid).toBe(false);
    });

    it("rejects config with empty userIds", async () => {
      const connector = new OneDriveConnector();
      const result = await connector.validateConfig({
        tenantId: "test-tenant-id",
        userIds: [],
      });
      expect(result.valid).toBe(false);
    });

    it("rejects config without userIds", async () => {
      const connector = new OneDriveConnector();
      const result = await connector.validateConfig({
        tenantId: "test-tenant-id",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("testConnection", () => {
    it("returns failure when Client ID is missing", async () => {
      const connector = new OneDriveConnector();

      const result = await connector.testConnection({
        config: baseConfig,
        credentials: { apiToken: "secret" }, // no email = no clientId
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Connection failed");
    });

    it("returns success when drive is accessible", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet.mockResolvedValueOnce({ id: "drive-id", name: "OneDrive" });

      const result = await connector.testConnection({
        config: baseConfig,
        credentials,
      });

      expect(result.success).toBe(true);
    });

    it("returns failure on API error", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet.mockRejectedValueOnce(new Error("Unauthorized"));

      const result = await connector.testConnection({
        config: baseConfig,
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Connection failed");
    });

    it("returns failure for invalid config", async () => {
      const connector = new OneDriveConnector();

      const result = await connector.testConnection({
        config: { tenantId: "test" }, // missing userIds
        credentials,
      });

      expect(result.success).toBe(false);
    });
  });

  describe("estimateTotalItems", () => {
    it("returns count of supported files", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      // for-await natural order: countFilesInFolder("root") first
      mockGet.mockResolvedValueOnce({
        value: [
          makeDriveItem("file-1", "doc.txt"),
          makeDriveItem("file-2", "archive.zip"), // unsupported
          makeDriveItem("file-3", "readme.md"),
        ],
      });
      // then listDirectSubfolders("root")
      mockGet.mockResolvedValueOnce({ value: [] });

      const count = await connector.estimateTotalItems({
        config: baseConfig,
        credentials,
        checkpoint: null,
      });

      expect(count).toBe(2);
    });

    it("returns null on API error", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet.mockRejectedValueOnce(new Error("Forbidden"));

      const count = await connector.estimateTotalItems({
        config: baseConfig,
        credentials,
        checkpoint: null,
      });

      expect(count).toBeNull();
    });

    it("counts files across multiple users", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      // User 1: countFilesInFolder("root") then listDirectSubfolders("root")
      mockGet.mockResolvedValueOnce({
        value: [
          makeDriveItem("file-1", "doc1.txt"),
          makeDriveItem("file-2", "doc2.md"),
        ],
      });
      mockGet.mockResolvedValueOnce({ value: [] });

      // User 2: countFilesInFolder("root") then listDirectSubfolders("root")
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("file-3", "doc3.txt")],
      });
      mockGet.mockResolvedValueOnce({ value: [] });

      const count = await connector.estimateTotalItems({
        config: { ...baseConfig, userIds: ["user-1", "user-2"] },
        credentials,
        checkpoint: null,
      });

      expect(count).toBe(3);
    });
  });

  describe("sync", () => {
    it("yields documents for text files", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      // Peek-ahead: listDirectSubfolders("root") called before syncFilesInFolder
      mockGet.mockResolvedValueOnce({ value: [] }); // listDirectSubfolders("root")
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("file-1", "readme.txt")],
      }); // syncFilesInFolder("root")
      mockGet.mockResolvedValueOnce(makeFileBuffer("Hello OneDrive")); // file content

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: baseConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("readme.txt");
      expect(batches[0].documents[0].content).toContain("Hello OneDrive");
    });

    it("skips unsupported file types", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet.mockResolvedValueOnce({ value: [] }); // listDirectSubfolders("root")
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("file-1", "archive.zip")],
      }); // syncFilesInFolder("root")

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: baseConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(0);
    });

    it("handles pagination with @odata.nextLink", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet.mockResolvedValueOnce({ value: [] }); // listDirectSubfolders("root")

      // Page 1
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("file-1", "doc1.txt")],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page",
      });
      mockGet.mockResolvedValueOnce(makeFileBuffer("Content 1"));

      // Page 2
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("file-2", "doc2.txt")],
      });
      mockGet.mockResolvedValueOnce(makeFileBuffer("Content 2"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: baseConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].hasMore).toBe(true);
      expect(batches[1].hasMore).toBe(false);
    });

    it("syncs multiple users sequentially", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      // User 1: listDirectSubfolders then files
      mockGet.mockResolvedValueOnce({ value: [] }); // listDirectSubfolders("root") user 1
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("file-1", "user1-doc.txt")],
      });
      mockGet.mockResolvedValueOnce(makeFileBuffer("User 1 content"));

      // User 2: listDirectSubfolders then files
      mockGet.mockResolvedValueOnce({ value: [] }); // listDirectSubfolders("root") user 2
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("file-2", "user2-doc.txt")],
      });
      mockGet.mockResolvedValueOnce(makeFileBuffer("User 2 content"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...baseConfig, userIds: ["user-1", "user-2"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(2);
      expect(allDocs[0].title).toBe("user1-doc.txt");
      expect(allDocs[1].title).toBe("user2-doc.txt");
    });

    it("respects incremental sync from checkpoint", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet.mockResolvedValueOnce({ value: [] }); // listDirectSubfolders("root")
      // Old file (before checkpoint) + new file
      mockGet.mockResolvedValueOnce({
        value: [
          makeDriveItem("file-old", "old.txt", {
            lastModified: "2024-01-01T00:00:00.000Z",
          }),
          makeDriveItem("file-new", "new.txt", {
            lastModified: "2024-02-01T00:00:00.000Z",
          }),
        ],
      });
      mockGet.mockResolvedValueOnce(makeFileBuffer("New content"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: baseConfig,
        credentials,
        checkpoint: {
          type: "onedrive",
          lastSyncedAt: "2024-01-20T00:00:00.000Z",
        },
      })) {
        batches.push(batch);
      }

      const docs = batches.flatMap((b) => b.documents);
      expect(docs).toHaveLength(1);
      expect(docs[0].title).toBe("new.txt");
    });

    it("traverses subfolders recursively", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      // Peek-ahead: listDirectSubfolders("root") → [folder-1]
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("folder-1", "Subfolder", { isFolder: true })],
      });
      // syncFilesInFolder("root"): one file
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("file-1", "root-doc.txt")],
      });
      mockGet.mockResolvedValueOnce(makeFileBuffer("Root content"));

      // Peek-ahead: listDirectSubfolders("folder-1") → []
      mockGet.mockResolvedValueOnce({ value: [] });
      // syncFilesInFolder("folder-1"): one file
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("file-2", "sub-doc.txt")],
      });
      mockGet.mockResolvedValueOnce(makeFileBuffer("Sub content"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...baseConfig, recursive: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(2);
    });

    it("traverses all subfolder pages when listDirectSubfolders response is paginated", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      // listDirectSubfolders("root") — page 1 with nextLink, page 2 terminates
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("folder-1", "Subfolder1", { isFolder: true })],
        "@odata.nextLink": "https://graph.microsoft.com/next-page",
      });
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("folder-2", "Subfolder2", { isFolder: true })],
      });
      // syncFilesInFolder("root"): no files
      mockGet.mockResolvedValueOnce({ value: [] });

      // listDirectSubfolders("folder-1") → []
      mockGet.mockResolvedValueOnce({ value: [] });
      // syncFilesInFolder("folder-1"): one file
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("file-1", "doc1.txt")],
      });
      mockGet.mockResolvedValueOnce(makeFileBuffer("content 1"));

      // listDirectSubfolders("folder-2") → []
      mockGet.mockResolvedValueOnce({ value: [] });
      // syncFilesInFolder("folder-2"): one file
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("file-2", "doc2.txt")],
      });
      mockGet.mockResolvedValueOnce(makeFileBuffer("content 2"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...baseConfig, recursive: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      // Both subfolders from both pages must be discovered and synced
      expect(allDocs).toHaveLength(2);
      expect(allDocs.map((d) => d.title).sort()).toEqual([
        "doc1.txt",
        "doc2.txt",
      ]);
    });

    it("does not traverse subfolders when recursive is false", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      // recursive=false: traverseFolders yields only root, never calls listDirectSubfolders
      // so next call after first next() is done=true, no subfolder API call
      mockGet.mockResolvedValueOnce({
        value: [
          makeDriveItem("folder-1", "Subfolder", { isFolder: true }),
          makeDriveItem("file-1", "root-doc.txt"),
        ],
      }); // syncFilesInFolder("root") - folder filtered out
      mockGet.mockResolvedValueOnce(makeFileBuffer("Root content"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...baseConfig, recursive: false },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(1);
      expect(allDocs[0].title).toBe("root-doc.txt");
    });

    it("syncs image files when embedding model supports images", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      const imageBuffer = Buffer.from("fake-png-data");

      mockGet.mockResolvedValueOnce({ value: [] }); // listDirectSubfolders("root")
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("img-1", "photo.png")],
      });
      mockGet.mockResolvedValueOnce(imageBuffer.buffer);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: baseConfig,
        credentials,
        checkpoint: null,
        embeddingInputModalities: ["image"],
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].mediaContent?.mimeType).toBe("image/png");
    });

    it("skips image files when embedding model does not support images", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet.mockResolvedValueOnce({ value: [] }); // listDirectSubfolders("root")
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("img-1", "photo.png")],
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: baseConfig,
        credentials,
        checkpoint: null,
        embeddingInputModalities: ["text"],
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(0);
    });

    it("throws on drive items API error", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      // listDirectSubfolders("root") succeeds, then syncFilesInFolder throws
      mockGet.mockResolvedValueOnce({ value: [] });
      mockGet.mockRejectedValueOnce(new Error("Internal Server Error"));

      await expect(async () => {
        for await (const _ of connector.sync({
          config: baseConfig,
          credentials,
          checkpoint: null,
        })) {
          // consume
        }
      }).rejects.toThrow("OneDrive items query failed");
    });

    it("records failure and continues when individual file download fails", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet.mockResolvedValueOnce({ value: [] }); // listDirectSubfolders("root")
      mockGet.mockResolvedValueOnce({
        value: [
          makeDriveItem("file-1", "good.txt"),
          makeDriveItem("file-2", "bad.txt"),
        ],
      });
      // good.txt succeeds
      mockGet.mockResolvedValueOnce(makeFileBuffer("Good content"));
      // bad.txt fails
      mockGet.mockRejectedValueOnce(new Error("Download failed"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: baseConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("good.txt");
      expect(batches[0].failures).toHaveLength(1);
    });

    it("emits checkpoint that advances monotonically", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet.mockResolvedValueOnce({ value: [] }); // listDirectSubfolders("root")
      mockGet.mockResolvedValueOnce({
        value: [
          makeDriveItem("file-1", "doc.txt", {
            lastModified: "2024-03-01T00:00:00.000Z",
          }),
        ],
      });
      mockGet.mockResolvedValueOnce(makeFileBuffer("content"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: baseConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].checkpoint.type).toBe("onedrive");
      if (batches[0].checkpoint.type === "onedrive") {
        expect(batches[0].checkpoint.lastSyncedAt).toBe(
          "2024-03-01T00:00:00.000Z",
        );
      }
    });

    it("keeps previous checkpoint on intermediate batches so resumed run re-visits unprocessed folders", async () => {
      // Regression: before the safeLastSyncedAt fix, intermediate batches (hasMore=true)
      // would advance lastSyncedAt to the latest file seen so far. If the process was
      // interrupted after the first page, the resumed run would skip files in
      // unvisited pages/folders whose timestamps are earlier than the advanced checkpoint.
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      const previousCheckpoint = "2024-01-01T00:00:00.000Z";

      mockGet.mockResolvedValueOnce({ value: [] }); // listDirectSubfolders("root")

      // Page 1 (hasMore=true): file modified after checkpoint
      mockGet.mockResolvedValueOnce({
        value: [
          makeDriveItem("file-1", "page1.txt", {
            lastModified: "2024-03-01T00:00:00.000Z",
          }),
        ],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page",
      });
      mockGet.mockResolvedValueOnce(makeFileBuffer("page1 content"));

      // Page 2 (hasMore=false): file modified after checkpoint
      mockGet.mockResolvedValueOnce({
        value: [
          makeDriveItem("file-2", "page2.txt", {
            lastModified: "2024-04-01T00:00:00.000Z",
          }),
        ],
      });
      mockGet.mockResolvedValueOnce(makeFileBuffer("page2 content"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: baseConfig,
        credentials,
        checkpoint: { type: "onedrive", lastSyncedAt: previousCheckpoint },
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);

      // Intermediate batch must keep the previous checkpoint so a resumed run
      // re-fetches from the safe starting point and doesn't skip page 2.
      expect(batches[0].hasMore).toBe(true);
      if (batches[0].checkpoint.type === "onedrive") {
        expect(batches[0].checkpoint.lastSyncedAt).toBe(previousCheckpoint);
      }

      // Final batch must advance to the true maximum last-modified seen.
      expect(batches[1].hasMore).toBe(false);
      if (batches[1].checkpoint.type === "onedrive") {
        expect(batches[1].checkpoint.lastSyncedAt).toBe(
          "2024-04-01T00:00:00.000Z",
        );
      }
    });

    it("filters files by fileTypes config when provided", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet.mockResolvedValueOnce({ value: [] }); // listDirectSubfolders("root")
      mockGet.mockResolvedValueOnce({
        value: [
          makeDriveItem("file-1", "notes.txt"),
          makeDriveItem("file-2", "data.json"), // excluded by fileTypes filter
          makeDriveItem("file-3", "report.md"), // excluded by fileTypes filter
        ],
      });
      // Only notes.txt download is fetched
      mockGet.mockResolvedValueOnce(makeFileBuffer("note content"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...baseConfig, fileTypes: [".txt"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const docs = batches.flatMap((b) => b.documents);
      expect(docs).toHaveLength(1);
      expect(docs[0].title).toBe("notes.txt");
    });
  });

  describe("estimateTotalItems — fileTypes filter", () => {
    it("counts only files matching fileTypes when provided", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet.mockResolvedValueOnce({
        value: [
          makeDriveItem("file-1", "report.pdf"),
          makeDriveItem("file-2", "notes.txt"),
          makeDriveItem("file-3", "data.csv"),
        ],
      });
      mockGet.mockResolvedValueOnce({ value: [] }); // listDirectSubfolders

      const count = await connector.estimateTotalItems({
        config: { ...baseConfig, fileTypes: [".pdf"] },
        credentials,
        checkpoint: null,
      });

      expect(count).toBe(1);
    });
  });
});
