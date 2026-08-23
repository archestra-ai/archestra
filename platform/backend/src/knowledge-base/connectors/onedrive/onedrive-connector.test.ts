import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorSyncBatch, PermissionSnapshotYield } from "@/types";
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

    it("marks text that exceeds the connector indexing limit", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);
      const source = Buffer.from("x".repeat(500_001));

      mockGet.mockResolvedValueOnce({ value: [] });
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("file-1", "long.txt")],
      });
      mockGet.mockResolvedValueOnce(
        source.buffer.slice(
          source.byteOffset,
          source.byteOffset + source.byteLength,
        ),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: baseConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents[0].contentTruncation).toMatchObject({
        originalCharacterCount: 500_001,
        indexedCharacterCount: 500_000,
      });
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

    it("reports a file with no extractable text as a categorized skip naming the file", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      // Standalone ArrayBuffer (not from the Node.js pool) so the download
      // yields exactly these whitespace bytes.
      const blankBytes = Buffer.from("   \n  ");
      const blankArrayBuffer: ArrayBuffer = blankBytes.buffer.slice(
        blankBytes.byteOffset,
        blankBytes.byteOffset + blankBytes.byteLength,
      );

      mockGet.mockResolvedValueOnce({ value: [] }); // listDirectSubfolders("root")
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("file-1", "blank.txt")],
      }); // syncFilesInFolder("root")
      mockGet.mockResolvedValueOnce(blankArrayBuffer); // whitespace-only content

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: baseConfig,
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
        metadataField: "userId",
        value: "user-1",
      });
    });

    it("records a fileTypes extension with no extractor as an unsupported-type skip, not a document without text", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet.mockResolvedValueOnce({ value: [] }); // listDirectSubfolders("root")
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("file-1", "recording.mp4")],
      }); // syncFilesInFolder("root") — .mp4 passes the fileTypes override

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...baseConfig, fileTypes: [".pdf", ".mp4"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(0);
      expect(batches[0].skipped).toHaveLength(1);
      const skip = batches[0].skipped?.[0];
      expect(skip?.name).toBe("recording.mp4");
      expect(skip?.reason).toBe("unsupported_file_type");
      expect(skip?.category).toBe("unsupported_type");
    });

    it("reports an oversized image as a categorized skip", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      const oversized = new ArrayBuffer(4 * 1024 * 1024 + 1);

      mockGet.mockResolvedValueOnce({ value: [] }); // listDirectSubfolders("root")
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("file-1", "poster.png")],
      }); // syncFilesInFolder("root")
      mockGet.mockResolvedValueOnce(oversized); // image content over the limit

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: baseConfig,
        credentials,
        checkpoint: null,
        embeddingInputModalities: ["image"],
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(0);
      expect(batches[0].skipped).toHaveLength(1);
      const skip = batches[0].skipped?.[0];
      expect(skip?.name).toBe("poster.png");
      expect(skip?.category).toBe("no_extractable_text");
      expect(skip?.sourceScope).toEqual({
        metadataField: "userId",
        value: "user-1",
      });
      expect(skip?.reason).toContain("maximum size");
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
      expect(batches[0].failures?.[0]).toMatchObject({
        itemId: "file-2",
        itemUnavailable: true,
      });
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

    it("does not let fileTypes opt images into a text-only embedding model", async () => {
      const connector = new OneDriveConnector();
      const { mockGet } = setupMockClient(connector);

      mockGet.mockResolvedValueOnce({ value: [] });
      mockGet.mockResolvedValueOnce({
        value: [makeDriveItem("image-1", "diagram.png")],
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...baseConfig, fileTypes: [".png"] },
        credentials,
        checkpoint: null,
        embeddingInputModalities: ["text"],
      })) {
        batches.push(batch);
      }

      expect(batches.flatMap((batch) => batch.documents)).toHaveLength(0);
      expect(mockGet).toHaveBeenCalledTimes(2);
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

  describe("permission sync", () => {
    type ContainerYield = Extract<
      PermissionSnapshotYield,
      { kind: "container" }
    >;
    type DocumentYield = Extract<PermissionSnapshotYield, { kind: "document" }>;

    const permConfig = {
      tenantId: "test-tenant-id",
      userIds: ["user-1"],
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

    function routeFor(url: string, prefer: string | null) {
      const route = routes.find(
        (r) =>
          url.includes(r.match) &&
          (r.prefer === undefined || (prefer ?? "").includes(r.prefer)),
      );
      if (route?.error) {
        const err = new Error("Graph error") as Error & { statusCode: number };
        err.statusCode = route.error.statusCode;
        throw err;
      }
      if (!route) throw new Error(`No route for ${url}`);
      return route.body;
    }

    function installClient(connector: OneDriveConnector) {
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
          select: () => chain,
        };
        return chain;
      });
      vi.spyOn(
        connector as unknown as { getGraphClient: () => unknown },
        "getGraphClient",
      ).mockReturnValue({ api: mockApi } as never);
    }

    function readBack(docs: Array<{ sourceId: string; userId?: string }>) {
      return vi.fn(
        async (args: {
          metadataFilter?: Record<string, string>;
          afterId?: string | null;
          limit: number;
        }) => ({
          documents: docs
            .filter(
              (d) =>
                !args.metadataFilter?.userId ||
                d.userId === args.metadataFilter.userId,
            )
            .map((d) => ({
              sourceId: d.sourceId,
              metadata: d.userId ? { userId: d.userId } : null,
            })),
          nextAfterId: null,
        }),
      );
    }

    function syncParams(overrides?: {
      config?: Record<string, unknown>;
      docs?: Array<{ sourceId: string; userId?: string }>;
      cursor?: string | null;
      scope?: { containerKeys: string[] };
      resolveMappedEmail?: (accountId: string) => string | null;
    }) {
      return {
        config: overrides?.config ?? permConfig,
        credentials,
        cursor: overrides?.cursor ?? null,
        scope: overrides?.scope,
        resolveMappedEmail: overrides?.resolveMappedEmail,
        readIngestedDocuments: readBack(
          overrides?.docs ?? [{ sourceId: "I1", userId: "user-1" }],
        ),
      };
    }

    function collectSnapshot(gen: AsyncGenerator<PermissionSnapshotYield>) {
      const containers = new Map<string, ContainerYield>();
      const documents: DocumentYield[] = [];
      return (async () => {
        for await (const item of gen) {
          if (item.kind === "container")
            containers.set(item.containerKey, item);
          else documents.push(item);
        }
        return { containers, documents };
      })();
    }

    /** The user's drive resolution route (id + owner). */
    function stubDrive() {
      routes.push({
        match: "/users/user-1/drive?$select=id,owner",
        body: {
          id: "D1",
          owner: { user: { id: "owner-1", displayName: "Owner One" } },
        },
      });
    }

    /** The default delta walk over D1. */
    function stubDeltaWalk(items: unknown[]) {
      routes.push({
        match: "/drives/D1/root/delta",
        body: { value: items, "@odata.deltaLink": "delta-link-1" },
      });
    }

    /** User.Read.All tier probe + owner email resolution. */
    function stubUsersTier() {
      routes.push(
        { match: "/users?$select=id&$top=1", body: { value: [] } },
        {
          match: "/users/owner-1?$select=mail,userPrincipalName",
          body: { mail: "owner@example.com" },
        },
      );
    }

    beforeEach(() => {
      routes = [];
      requestedUrls = [];
    });

    it("supportsPermissionSync is true", () => {
      expect(new OneDriveConnector().supportsPermissionSync).toBe(true);
    });

    it("scopeKeyForDocument maps metadata.userId to the container key", () => {
      const connector = new OneDriveConnector();
      expect(connector.scopeKeyForDocument({ userId: "user-1" })).toBe(
        "user:user-1",
      );
      expect(connector.scopeKeyForDocument({})).toBeNull();
      expect(connector.scopeKeyForDocument({ userId: "" })).toBeNull();
    });

    it("root audience: direct grant + entra group token + drive owner; plain items assign to the top container", async () => {
      const connector = new OneDriveConnector();
      installClient(connector);
      stubDrive();
      stubDeltaWalk([
        { id: "root", parentReference: {} },
        { id: "I1", parentReference: { id: "root" } },
      ]);
      stubUsersTier();
      routes.push(
        {
          match: "/drives/D1/root/permissions",
          body: {
            value: [
              { grantedToV2: { user: { id: "u-alice" } } },
              { grantedToV2: { group: { id: "G1" } } },
            ],
          },
        },
        {
          match: "/users/u-alice?$select=mail,userPrincipalName",
          body: { mail: "Alice@Example.com" },
        },
      );

      const { containers, documents } = await collectSnapshot(
        connector.syncPermissionSnapshot(syncParams()),
      );

      const top = containers.get("user:user-1");
      expect(top).toBeDefined();
      expect(top?.audienceResolutionFailed).toBe(false);
      expect(top?.permissions.isPublic).toBe(false);
      // can-read: alice + the owner; cannot-read: anyone else is absent.
      expect([...(top?.permissions.users ?? [])].sort()).toEqual([
        "alice@example.com",
        "owner@example.com",
      ]);
      expect(top?.permissions.groups).toEqual(["entra:G1"]);
      expect(documents).toEqual([
        {
          kind: "document",
          sourceId: "I1",
          containerKey: "user:user-1",
          cursor: "user:user-1",
        },
      ]);
    });

    it("a permission-hierarchy root becomes a nested item container with its own audience", async () => {
      const connector = new OneDriveConnector();
      installClient(connector);
      stubDrive();
      stubDeltaWalk([
        { id: "root", parentReference: {} },
        { id: "I1", parentReference: { id: "root" } },
        // shared facet present ⇒ unique permissions (hierarchicalsharing)
        { id: "I2", parentReference: { id: "root" }, shared: {} },
      ]);
      stubUsersTier();
      routes.push(
        {
          match: "/drives/D1/root/permissions",
          body: { value: [{ grantedToV2: { user: { id: "u-alice" } } }] },
        },
        {
          match: "/drives/D1/items/I2/permissions",
          body: { value: [{ grantedToV2: { user: { id: "u-bob" } } }] },
        },
        {
          match: "/users/u-alice?$select=mail,userPrincipalName",
          body: { mail: "alice@example.com" },
        },
        {
          match: "/users/u-bob?$select=mail,userPrincipalName",
          body: { mail: "bob@example.com" },
        },
      );

      const { containers, documents } = await collectSnapshot(
        connector.syncPermissionSnapshot(
          syncParams({
            docs: [
              { sourceId: "I1", userId: "user-1" },
              { sourceId: "I2", userId: "user-1" },
            ],
          }),
        ),
      );

      const nested = containers.get("user:user-1/item:I2");
      expect(nested?.permissions.users).toContain("bob@example.com");
      // the owner belongs to every audience in the drive
      expect(nested?.permissions.users).toContain("owner@example.com");
      // alice governs the root, not the nested subtree
      expect(nested?.permissions.users).not.toContain("alice@example.com");
      expect(documents.find((d) => d.sourceId === "I2")?.containerKey).toBe(
        "user:user-1/item:I2",
      );
      expect(documents.find((d) => d.sourceId === "I1")?.containerKey).toBe(
        "user:user-1",
      );
    });

    it("an unreadable root permission list fail-closes the container — owner included", async () => {
      const connector = new OneDriveConnector();
      installClient(connector);
      stubDrive();
      stubDeltaWalk([{ id: "root", parentReference: {} }]);
      stubUsersTier();
      routes.push({
        match: "/drives/D1/root/permissions",
        error: { statusCode: 500 },
      });

      const { containers } = await collectSnapshot(
        connector.syncPermissionSnapshot(syncParams()),
      );

      const top = containers.get("user:user-1");
      expect(top?.audienceResolutionFailed).toBe(true);
      expect(top?.permissions).toEqual({
        isPublic: false,
        users: [],
        groups: [],
      });
    });

    it("an unreadable nested item fail-closes that subtree only", async () => {
      const connector = new OneDriveConnector();
      installClient(connector);
      stubDrive();
      stubDeltaWalk([
        { id: "root", parentReference: {} },
        { id: "I2", parentReference: { id: "root" }, shared: {} },
      ]);
      stubUsersTier();
      routes.push(
        {
          match: "/drives/D1/root/permissions",
          body: { value: [{ grantedToV2: { user: { id: "u-alice" } } }] },
        },
        {
          match: "/users/u-alice?$select=mail,userPrincipalName",
          body: { mail: "alice@example.com" },
        },
        {
          match: "/drives/D1/items/I2/permissions",
          error: { statusCode: 429 },
        },
      );

      const { containers } = await collectSnapshot(
        connector.syncPermissionSnapshot(
          syncParams({ docs: [{ sourceId: "I2", userId: "user-1" }] }),
        ),
      );

      const nested = containers.get("user:user-1/item:I2");
      expect(nested?.audienceResolutionFailed).toBe(true);
      expect(nested?.permissions.users).toEqual([]);
      const top = containers.get("user:user-1");
      expect(top?.audienceResolutionFailed).toBe(false);
    });

    it("a failed drive resolution fail-closes the whole corpus under the top container", async () => {
      const connector = new OneDriveConnector();
      installClient(connector);
      routes.push({
        match: "/users/user-1/drive?$select=id,owner",
        error: { statusCode: 404 },
      });

      const { containers, documents } = await collectSnapshot(
        connector.syncPermissionSnapshot(syncParams()),
      );

      const top = containers.get("user:user-1");
      expect(top?.audienceResolutionFailed).toBe(true);
      expect(top?.permissions.users).toEqual([]);
      expect(documents.map((d) => d.sourceId)).toEqual(["I1"]);
    });

    it("an empty corpus emits the boundary container without resolving its audience", async () => {
      const connector = new OneDriveConnector();
      installClient(connector);

      const { containers, documents } = await collectSnapshot(
        connector.syncPermissionSnapshot(syncParams({ docs: [] })),
      );

      const top = containers.get("user:user-1");
      expect(top?.audienceResolutionFailed).toBe(false);
      expect(top?.permissions).toEqual({
        isPublic: false,
        users: [],
        groups: [],
      });
      expect(documents).toEqual([]);
      expect(requestedUrls.some((u) => u.includes("/permissions"))).toBe(false);
    });

    it("anonymous links are public; organization links expand to active tenant users", async () => {
      const connector = new OneDriveConnector();
      installClient(connector);
      stubDrive();
      stubDeltaWalk([{ id: "root", parentReference: {} }]);
      stubUsersTier();
      routes.push(
        {
          match: "/drives/D1/root/permissions",
          body: {
            value: [
              { link: { scope: "anonymous" } },
              { link: { scope: "organization" } },
            ],
          },
        },
        {
          match: "/users?$select=mail,userPrincipalName,accountEnabled",
          body: {
            value: [
              { mail: "active@example.com", accountEnabled: true },
              { mail: "gone@example.com", accountEnabled: false },
            ],
          },
        },
      );

      const { containers } = await collectSnapshot(
        connector.syncPermissionSnapshot(syncParams()),
      );

      const top = containers.get("user:user-1");
      expect(top?.permissions.isPublic).toBe(true);
      expect(top?.permissions.users).toContain("active@example.com");
      expect(top?.permissions.users).not.toContain("gone@example.com");
    });

    it("User.Read.All denied: unresolvable principals drop fail-closed, group tokens survive, member overrides still apply", async () => {
      const connector = new OneDriveConnector();
      installClient(connector);
      stubDrive();
      stubDeltaWalk([{ id: "root", parentReference: {} }]);
      routes.push(
        { match: "/users?$select=id&$top=1", error: { statusCode: 403 } },
        {
          match: "/drives/D1/root/permissions",
          body: {
            value: [
              { grantedToV2: { user: { id: "u-alice" } } },
              { grantedToV2: { user: { id: "u-mapped" } } },
              { grantedToV2: { group: { id: "G1" } } },
            ],
          },
        },
      );

      const { containers } = await collectSnapshot(
        connector.syncPermissionSnapshot(
          syncParams({
            resolveMappedEmail: (accountId) =>
              accountId === "u-mapped" ? "mapped@example.com" : null,
          }),
        ),
      );

      const top = containers.get("user:user-1");
      expect(top?.audienceResolutionFailed).toBe(false);
      // alice and the owner are unresolvable without User.Read.All; the
      // admin override rescues u-mapped.
      expect(top?.permissions.users).toEqual(["mapped@example.com"]);
      expect(top?.permissions.groups).toEqual(["entra:G1"]);
    });

    it("resume cursor skips containers strictly before it; scope filters containers", async () => {
      const connector = new OneDriveConnector();
      installClient(connector);
      const config = { ...permConfig, userIds: ["user-1", "user-2"] };
      const docs = [
        { sourceId: "I1", userId: "user-1" },
        { sourceId: "I2", userId: "user-2" },
      ];
      routes.push({
        match: "/users/user-2/drive?$select=id,owner",
        body: { id: "D2", owner: { user: { id: "owner-1" } } },
      });
      stubUsersTier();
      routes.push(
        {
          match: "/drives/D2/root/delta",
          body: {
            value: [{ id: "root2", parentReference: {} }],
            "@odata.deltaLink": "dl-2",
          },
        },
        { match: "/drives/D2/root/permissions", body: { value: [] } },
      );

      const cursored = await collectSnapshot(
        connector.syncPermissionSnapshot(
          syncParams({ config, docs, cursor: "user:user-2" }),
        ),
      );
      expect([...cursored.containers.keys()]).toEqual(["user:user-2"]);

      const scoped = await collectSnapshot(
        connector.syncPermissionSnapshot(
          syncParams({
            config,
            docs,
            scope: { containerKeys: ["user:user-2"] },
          }),
        ),
      );
      expect([...scoped.containers.keys()]).toEqual(["user:user-2"]);
    });

    describe("syncGroups", () => {
      it("rosters entra groups, site groups (empty), and direct grantees incl. the owner", async () => {
        const connector = new OneDriveConnector();
        installClient(connector);
        stubDrive();
        stubUsersTier();
        routes.push(
          {
            match: "/drives/D1/root/permissions",
            body: {
              value: [
                { grantedToV2: { group: { id: "G1" } } },
                {
                  grantedToV2: {
                    siteGroup: { displayName: "Personal Site Members" },
                  },
                },
                {
                  grantedToV2: {
                    user: { id: "u-alice", displayName: "Alice" },
                  },
                },
              ],
            },
          },
          {
            match: "/groups/G1/transitiveMembers",
            body: {
              value: [
                {
                  "@odata.type": "#microsoft.graph.user",
                  id: "m1",
                  displayName: "Member One",
                  mail: "member1@example.com",
                  accountEnabled: true,
                },
                {
                  "@odata.type": "#microsoft.graph.user",
                  id: "m2",
                  displayName: "Hidden Member",
                  accountEnabled: false,
                },
                { "@odata.type": "#microsoft.graph.group", id: "nested-g" },
              ],
            },
          },
          {
            match: "/users/u-alice?$select=mail,userPrincipalName",
            body: { mail: "alice@example.com" },
          },
        );

        const groups: Array<{
          groupId: string;
          members: Array<{ accountId: string; email?: string | null }>;
        }> = [];
        for await (const g of connector.syncGroups(syncParams())) {
          groups.push(g);
        }

        const entra = groups.find((g) => g.groupId === "entra:G1");
        expect(entra?.members.map((m) => m.accountId).sort()).toEqual([
          "m1",
          "m2",
        ]);
        expect(
          entra?.members.find((m) => m.accountId === "m2")?.email,
        ).toBeNull();

        const site = groups.find(
          (g) => g.groupId === "sitegroup:Personal Site Members",
        );
        expect(site?.members).toEqual([]);

        const direct = groups.find((g) => g.groupId === "direct-grants");
        expect(direct?.members.map((m) => m.accountId).sort()).toEqual([
          "owner-1",
          "u-alice",
        ]);
      });

      it("GroupMember.Read.All denied: the group rosters empty (fail-closed)", async () => {
        const connector = new OneDriveConnector();
        installClient(connector);
        stubDrive();
        stubUsersTier();
        routes.push(
          {
            match: "/drives/D1/root/permissions",
            body: { value: [{ grantedToV2: { group: { id: "G1" } } }] },
          },
          {
            match: "/groups/G1/transitiveMembers",
            error: { statusCode: 403 },
          },
        );

        const groups: Array<{ groupId: string; members: unknown[] }> = [];
        for await (const g of connector.syncGroups(syncParams())) {
          groups.push(g);
        }
        expect(groups.find((g) => g.groupId === "entra:G1")?.members).toEqual(
          [],
        );
      });

      it("an unreadable permission surface is skipped, not fail-closed here", async () => {
        const connector = new OneDriveConnector();
        installClient(connector);
        stubDrive();
        stubUsersTier();
        routes.push({
          match: "/drives/D1/root/permissions",
          error: { statusCode: 500 },
        });

        const groups: Array<{ groupId: string }> = [];
        for await (const g of connector.syncGroups(syncParams())) {
          groups.push(g);
        }
        // only the owner's direct-grants roster survives
        expect(groups.map((g) => g.groupId)).toEqual(["direct-grants"]);
      });
    });

    describe("probePermissionChanges", () => {
      it("no stored state: fullRequired with fresh delta tokens", async () => {
        const connector = new OneDriveConnector();
        installClient(connector);
        stubDrive();
        routes.push({
          match: "/drives/D1/root/delta?token=latest",
          body: { "@odata.deltaLink": "dl-fresh" },
        });

        const result = await connector.probePermissionChanges({
          config: permConfig,
          credentials,
          state: null,
        });

        expect(result.fullRequired).toBe(true);
        expect(result.nextState).toEqual({
          deltaTokens: { "user:user-1": "dl-fresh" },
        });
      });

      it("sharing-annotated drift dirties the container; unannotated drift does not (elevated tier)", async () => {
        const connector = new OneDriveConnector();
        installClient(connector);
        stubDrive();
        routes.push({
          match: "stored-token",
          prefer: "deltashowsharingchanges",
          body: {
            value: [
              { id: "I1", parentReference: { id: "root" } },
              {
                id: "I2",
                parentReference: { id: "root" },
                "@microsoft.graph.sharedChanged": "True",
              },
            ],
            "@odata.deltaLink": "dl-next",
          },
        });

        const result = await connector.probePermissionChanges({
          config: permConfig,
          credentials,
          state: { deltaTokens: { "user:user-1": "stored-token" } },
        });

        expect(result.fullRequired).toBe(false);
        expect(result.dirtyContainerKeys).toEqual(["user:user-1"]);
        expect(result.nextState).toEqual({
          deltaTokens: { "user:user-1": "dl-next" },
        });
      });

      it("sharing preference denied (403): degrades to coarse probing where any drift dirties", async () => {
        const connector = new OneDriveConnector();
        installClient(connector);
        stubDrive();
        routes.push(
          {
            match: "stored-token",
            prefer: "deltashowsharingchanges",
            error: { statusCode: 403 },
          },
          {
            match: "stored-token",
            body: {
              value: [{ id: "I1", parentReference: { id: "root" } }],
              "@odata.deltaLink": "dl-next",
            },
          },
        );

        const result = await connector.probePermissionChanges({
          config: permConfig,
          credentials,
          state: { deltaTokens: { "user:user-1": "stored-token" } },
        });

        expect(result.fullRequired).toBe(false);
        expect(result.dirtyContainerKeys).toEqual(["user:user-1"]);
      });

      it("a rejected delta token (410) promotes to a full reconcile", async () => {
        const connector = new OneDriveConnector();
        installClient(connector);
        stubDrive();
        routes.push(
          { match: "stored-token", error: { statusCode: 410 } },
          {
            match: "/drives/D1/root/delta?token=latest",
            body: { "@odata.deltaLink": "dl-fresh" },
          },
        );

        const result = await connector.probePermissionChanges({
          config: permConfig,
          credentials,
          state: { deltaTokens: { "user:user-1": "stored-token" } },
        });

        expect(result.fullRequired).toBe(true);
        expect(result.nextState).toEqual({
          deltaTokens: { "user:user-1": "dl-fresh" },
        });
      });
    });

    describe("refreshContainerAudiences", () => {
      it("re-resolves top-level audiences and skips nested item containers", async () => {
        const connector = new OneDriveConnector();
        installClient(connector);
        stubDrive();
        stubUsersTier();
        routes.push({
          match: "/drives/D1/root/permissions",
          body: { value: [{ grantedToV2: { user: { id: "u-alice" } } }] },
        });
        routes.push({
          match: "/users/u-alice?$select=mail,userPrincipalName",
          body: { mail: "alice@example.com" },
        });

        const yields: Array<{
          containerKey: string;
          permissions: { users?: string[] };
        }> = [];
        for await (const y of connector.refreshContainerAudiences({
          config: permConfig,
          credentials,
          containerKeys: ["user:user-1", "user:user-1/item:I2"],
        })) {
          yields.push(y);
        }

        expect(yields.map((y) => y.containerKey)).toEqual(["user:user-1"]);
        expect(yields[0].permissions.users).toContain("alice@example.com");
        expect(yields[0].permissions.users).toContain("owner@example.com");
      });
    });
  });
});
