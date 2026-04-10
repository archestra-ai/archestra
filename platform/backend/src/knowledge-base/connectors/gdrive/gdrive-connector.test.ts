import { describe, expect, it, vi } from "vitest";
import type { ConnectorSyncBatch } from "@/types";
import { GoogleDriveConnector } from "./gdrive-connector";

// ===== Mock googleapis =====

const mockFilesList = vi.fn();
const mockFilesGet = vi.fn();
const mockFilesExport = vi.fn();
const mockAboutGet = vi.fn();

vi.mock("googleapis", () => {
  class MockOAuth2 {
    setCredentials = vi.fn();
  }
  class MockGoogleAuth {}

  return {
    google: {
      drive: () => ({
        files: {
          list: (...args: unknown[]) => mockFilesList(...args),
          get: (...args: unknown[]) => mockFilesGet(...args),
          export: (...args: unknown[]) => mockFilesExport(...args),
        },
        about: {
          get: (...args: unknown[]) => mockAboutGet(...args),
        },
      }),
      auth: {
        GoogleAuth: MockGoogleAuth,
        OAuth2: MockOAuth2,
      },
    },
  };
});

const credentials = { apiToken: "test-access-token" };

function makeDriveFile(
  id: string,
  name: string,
  opts?: {
    mimeType?: string;
    modifiedTime?: string;
    size?: string;
    webViewLink?: string;
    parents?: string[];
  },
) {
  return {
    id,
    name,
    mimeType: opts?.mimeType ?? "text/plain",
    modifiedTime: opts?.modifiedTime ?? "2024-01-15T10:00:00.000Z",
    createdTime: "2024-01-01T00:00:00.000Z",
    owners: [{ emailAddress: "user@example.com" }],
    webViewLink:
      opts?.webViewLink ?? `https://drive.google.com/file/d/${id}/view`,
    parents: opts?.parents ?? ["root"],
    size: opts?.size ?? "1024",
  };
}

function resetMocks() {
  mockFilesList.mockReset();
  mockFilesGet.mockReset();
  mockFilesExport.mockReset();
  mockAboutGet.mockReset();
}

describe("GoogleDriveConnector", () => {
  it("has the correct type", () => {
    const connector = new GoogleDriveConnector();
    expect(connector.type).toBe("gdrive");
  });

  describe("validateConfig", () => {
    it("accepts empty config (all fields optional)", async () => {
      const connector = new GoogleDriveConnector();
      const result = await connector.validateConfig({});
      expect(result.valid).toBe(true);
    });

    it("accepts config with driveId", async () => {
      const connector = new GoogleDriveConnector();
      const result = await connector.validateConfig({
        driveId: "shared-drive-123",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts config with folderId and recursive", async () => {
      const connector = new GoogleDriveConnector();
      const result = await connector.validateConfig({
        folderId: "folder-abc",
        recursive: true,
      });
      expect(result.valid).toBe(true);
    });

    it("accepts config with driveIds and includeSharedDrives", async () => {
      const connector = new GoogleDriveConnector();
      const result = await connector.validateConfig({
        driveIds: ["drive-1", "drive-2"],
        includeSharedDrives: true,
      });
      expect(result.valid).toBe(true);
    });

    it("accepts config with fileTypes and batchSize", async () => {
      const connector = new GoogleDriveConnector();
      const result = await connector.validateConfig({
        fileTypes: [".pdf", ".docx"],
        batchSize: 25,
      });
      expect(result.valid).toBe(true);
    });

    it("rejects config with invalid field types", async () => {
      const connector = new GoogleDriveConnector();
      const result = await connector.validateConfig({
        batchSize: "not-a-number",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("testConnection", () => {
    it("returns success when about.get succeeds", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();
      mockAboutGet.mockResolvedValueOnce({
        data: { user: { emailAddress: "test@example.com" } },
      });

      const result = await connector.testConnection({
        config: {},
        credentials,
      });

      expect(result.success).toBe(true);
    });

    it("returns failure when about.get throws", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();
      mockAboutGet.mockRejectedValueOnce(new Error("Invalid credentials"));

      const result = await connector.testConnection({
        config: {},
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid credentials");
    });

    it("returns failure for invalid config", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      const result = await connector.testConnection({
        config: { batchSize: "invalid" },
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid configuration");
    });
  });

  describe("sync — drive listing mode", () => {
    it("syncs text files from drive", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [
            makeDriveFile("file-1", "readme.md"),
            makeDriveFile("file-2", "notes.txt"),
          ],
          nextPageToken: undefined,
        },
      });

      // file downloads
      mockFilesGet
        .mockResolvedValueOnce({
          data: Buffer.from("# Hello World").buffer,
        })
        .mockResolvedValueOnce({
          data: Buffer.from("Some notes").buffer,
        });

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
      expect(batches[0].documents[0].title).toBe("readme.md");
      expect(batches[0].documents[0].content).toContain("# Hello World");
      expect(batches[0].documents[1].title).toBe("notes.txt");
    });

    it("syncs Google Docs via export", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [
            makeDriveFile("gdoc-1", "My Document", {
              mimeType: "application/vnd.google-apps.document",
            }),
          ],
          nextPageToken: undefined,
        },
      });

      mockFilesExport.mockResolvedValueOnce({
        data: "This is the document content",
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("My Document");
      expect(batches[0].documents[0].content).toContain(
        "This is the document content",
      );
    });

    it("skips unsupported file types", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [
            makeDriveFile("file-1", "doc.txt"),
            makeDriveFile("file-2", "video.mp4", {
              mimeType: "video/mp4",
            }),
            makeDriveFile("file-3", "spreadsheet.xlsx", {
              mimeType:
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            }),
          ],
          nextPageToken: undefined,
        },
      });

      mockFilesGet.mockResolvedValueOnce({
        data: Buffer.from("Text content").buffer,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Only doc.txt should be synced
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("doc.txt");
    });

    it("paginates using nextPageToken", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList
        .mockResolvedValueOnce({
          data: {
            files: [makeDriveFile("file-1", "file1.txt")],
            nextPageToken: "token-abc",
          },
        })
        .mockResolvedValueOnce({
          data: {
            files: [makeDriveFile("file-2", "file2.txt")],
            nextPageToken: undefined,
          },
        });

      mockFilesGet
        .mockResolvedValueOnce({
          data: Buffer.from("Content 1").buffer,
        })
        .mockResolvedValueOnce({
          data: Buffer.from("Content 2").buffer,
        });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].documents[0].title).toBe("file1.txt");
      expect(batches[0].hasMore).toBe(true);
      expect(batches[1].documents[0].title).toBe("file2.txt");
      expect(batches[1].hasMore).toBe(false);
    });

    it("applies incremental sync filter via modifiedTime query", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [
            makeDriveFile("file-2", "new.txt", {
              modifiedTime: "2024-01-20T00:00:00.000Z",
            }),
          ],
          nextPageToken: undefined,
        },
      });

      mockFilesGet.mockResolvedValueOnce({
        data: Buffer.from("New content").buffer,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: {
          type: "gdrive",
          lastSyncedAt: "2024-01-15T12:00:00.000Z",
        },
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("new.txt");

      // Verify the query includes modifiedTime filter
      const listArgs = mockFilesList.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(listArgs.q).toContain("modifiedTime >=");
    });

    it("skips file and records failure when download fails", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [
            makeDriveFile("file-1", "good.txt"),
            makeDriveFile("file-2", "bad.txt"),
          ],
          nextPageToken: undefined,
        },
      });

      mockFilesGet
        .mockResolvedValueOnce({
          data: Buffer.from("Good content").buffer,
        })
        .mockRejectedValueOnce(new Error("Internal Server Error"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // good.txt succeeds, bad.txt is recorded as failure
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("good.txt");
      const failures = batches[0].failures ?? [];
      expect(failures).toHaveLength(1);
      expect(failures[0]?.itemId).toBe("file-2");
    });

    it("throws when files.list returns error", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList.mockRejectedValueOnce(new Error("Forbidden"));

      const generator = connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      });
      await expect(generator.next()).rejects.toThrow(
        "Google Drive files query failed",
      );
    });

    it("sets checkpoint from last file modifiedTime", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [
            makeDriveFile("file-1", "first.txt", {
              modifiedTime: "2024-02-01T00:00:00.000Z",
            }),
            makeDriveFile("file-2", "second.txt", {
              modifiedTime: "2024-03-01T00:00:00.000Z",
            }),
          ],
          nextPageToken: undefined,
        },
      });

      mockFilesGet
        .mockResolvedValueOnce({
          data: Buffer.from("First").buffer,
        })
        .mockResolvedValueOnce({
          data: Buffer.from("Second").buffer,
        });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const cp = batches[0].checkpoint as Record<string, unknown>;
      expect(cp.type).toBe("gdrive");
      expect(cp.lastSyncedAt).toBe("2024-03-01T00:00:00.000Z");
    });

    it("preserves previous checkpoint when batch is empty", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [],
          nextPageToken: undefined,
        },
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: {
          type: "gdrive",
          lastSyncedAt: "2024-01-01T00:00:00.000Z",
        },
      })) {
        batches.push(batch);
      }

      const cp = batches[0].checkpoint as Record<string, unknown>;
      expect(cp.lastSyncedAt).toBe("2024-01-01T00:00:00.000Z");
    });

    it("includes metadata in document", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      const file = makeDriveFile("file-meta", "report.md", {
        modifiedTime: "2024-03-01T08:00:00.000Z",
        size: "2048",
      });
      mockFilesList.mockResolvedValueOnce({
        data: { files: [file], nextPageToken: undefined },
      });
      mockFilesGet.mockResolvedValueOnce({
        data: Buffer.from("Report content").buffer,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const metadata = batches[0].documents[0].metadata;
      expect(metadata.fileId).toBe("file-meta");
      expect(metadata.modifiedTime).toBe("2024-03-01T08:00:00.000Z");
      expect(metadata.size).toBe(2048);
      expect(metadata.webViewLink).toBeDefined();
    });

    it("skips files with empty content (avoids title-only documents)", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [makeDriveFile("file-empty", "empty.txt")],
          nextPageToken: undefined,
        },
      });

      mockFilesGet.mockResolvedValueOnce({
        data: Buffer.from("").buffer,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Empty content file should be skipped
      expect(batches[0].documents).toHaveLength(0);
    });
  });

  describe("sync — folder mode", () => {
    it("syncs files from a specific folder", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [
            makeDriveFile("folder-file-1", "readme.md", {
              parents: ["folder-123"],
            }),
          ],
          nextPageToken: undefined,
        },
      });

      mockFilesGet.mockResolvedValueOnce({
        data: Buffer.from("Folder content").buffer,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { folderId: "folder-123" },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("readme.md");

      // Verify query scopes to folder
      const listArgs = mockFilesList.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(listArgs.q).toContain("'folder-123' in parents");
    });

    it("throws when folder query fails", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList.mockRejectedValueOnce(new Error("Folder not found"));

      const generator = connector.sync({
        config: { folderId: "nonexistent" },
        credentials,
        checkpoint: null,
      });

      await expect(generator.next()).rejects.toThrow(
        "Google Drive folder query failed",
      );
    });
  });

  describe("sync — folder mode with recursive traversal", () => {
    it("syncs files from nested subfolders when recursive is true", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      // Call 1: listSubfolders for root folder → returns one subfolder
      mockFilesList
        .mockResolvedValueOnce({
          data: {
            files: [{ id: "subfolder-1" }],
            nextPageToken: undefined,
          },
        })
        // Call 2: listSubfolders for subfolder-1 (no nested subfolders)
        .mockResolvedValueOnce({
          data: { files: [], nextPageToken: undefined },
        })
        // Call 3: Files in root folder
        .mockResolvedValueOnce({
          data: {
            files: [makeDriveFile("root-file", "root.txt")],
            nextPageToken: undefined,
          },
        })
        // Call 4: Files in subfolder
        .mockResolvedValueOnce({
          data: {
            files: [makeDriveFile("sub-file", "nested.txt")],
            nextPageToken: undefined,
          },
        });

      mockFilesGet
        .mockResolvedValueOnce({
          data: Buffer.from("Root content").buffer,
        })
        .mockResolvedValueOnce({
          data: Buffer.from("Nested content").buffer,
        });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { folderId: "root-folder", recursive: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Should get batches from both root and subfolder
      expect(batches.length).toBeGreaterThanOrEqual(2);
      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(2);
      expect(allDocs.map((d) => d.title).sort()).toEqual([
        "nested.txt",
        "root.txt",
      ]);
    });
  });

  describe("checkpoint monotonicity", () => {
    it("does not regress checkpoint when later batches have older timestamps", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      const newerTimestamp = "2024-03-01T10:00:00.000Z";
      const olderTimestamp = "2024-01-15T08:00:00.000Z";

      mockFilesList
        .mockResolvedValueOnce({
          data: {
            files: [
              makeDriveFile("file-1", "newer.txt", {
                modifiedTime: newerTimestamp,
              }),
            ],
            nextPageToken: "next-page",
          },
        })
        .mockResolvedValueOnce({
          data: {
            files: [
              makeDriveFile("file-2", "older.txt", {
                modifiedTime: olderTimestamp,
              }),
            ],
            nextPageToken: undefined,
          },
        });

      mockFilesGet
        .mockResolvedValueOnce({
          data: Buffer.from("Newer content").buffer,
        })
        .mockResolvedValueOnce({
          data: Buffer.from("Older content").buffer,
        });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);

      // First batch: checkpoint should be the newer timestamp
      const cp1 = batches[0].checkpoint as Record<string, unknown>;
      expect(cp1.lastSyncedAt).toBe(newerTimestamp);

      // Second batch: checkpoint should NOT regress to older timestamp
      const cp2 = batches[1].checkpoint as Record<string, unknown>;
      expect(cp2.lastSyncedAt).toBe(newerTimestamp);
    });
  });

  describe("sync — image files", () => {
    it("syncs image files when embeddingInputModalities includes image", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      const imageContent = "fake-png-data";
      const imageBytes = Buffer.from(imageContent);
      const imageArrayBuffer: ArrayBuffer = imageBytes.buffer.slice(
        imageBytes.byteOffset,
        imageBytes.byteOffset + imageBytes.byteLength,
      );
      const expectedBase64 = imageBytes.toString("base64");

      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [
            makeDriveFile("img-1", "diagram.png", {
              mimeType: "image/png",
            }),
          ],
          nextPageToken: undefined,
        },
      });

      mockFilesGet.mockResolvedValueOnce({
        data: imageArrayBuffer,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
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
    });

    it("skips image files when embeddingInputModalities does not include image", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [
            makeDriveFile("file-1", "doc.txt"),
            makeDriveFile("file-2", "photo.png", {
              mimeType: "image/png",
            }),
          ],
          nextPageToken: undefined,
        },
      });

      mockFilesGet.mockResolvedValueOnce({
        data: Buffer.from("Text content").buffer,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
        embeddingInputModalities: ["text"], // no "image"
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("doc.txt");
    });
  });

  describe("estimateTotalItems", () => {
    it("returns count of files from Drive API", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [
            makeDriveFile("f1", "a.txt"),
            makeDriveFile("f2", "b.txt"),
            makeDriveFile("f3", "c.txt"),
          ],
          nextPageToken: undefined,
        },
      });

      const result = await connector.estimateTotalItems({
        config: {},
        credentials,
        checkpoint: null,
      });

      expect(result).toBe(3);
    });

    it("returns null when query fails", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList.mockRejectedValueOnce(new Error("Auth error"));

      const result = await connector.estimateTotalItems({
        config: {},
        credentials,
        checkpoint: null,
      });

      expect(result).toBeNull();
    });
  });
});
