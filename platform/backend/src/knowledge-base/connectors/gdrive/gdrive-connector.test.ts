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

    it("accepts config with driveIds", async () => {
      const connector = new GoogleDriveConnector();
      const result = await connector.validateConfig({
        driveIds: ["drive-1", "drive-2"],
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

      // BFS: listDirectSubfolders for folder-123 (no subfolders)
      mockFilesList.mockResolvedValueOnce({
        data: { files: [], nextPageToken: undefined },
      });

      // Files in folder-123
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

      // Verify file query scopes to folder
      const fileListCall = mockFilesList.mock.calls[1][0] as Record<
        string,
        unknown
      >;
      expect(fileListCall.q).toContain("'folder-123' in parents");
    });

    it("throws when folder query fails", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      // BFS: listDirectSubfolders succeeds (no subfolders)
      mockFilesList.mockResolvedValueOnce({
        data: { files: [], nextPageToken: undefined },
      });

      // File listing fails
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

    it("enables shared-drive API flags in folder mode when driveIds are provided", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [makeDriveFile("folder-file-1", "shared-folder-file.txt")],
          nextPageToken: undefined,
        },
      });
      mockFilesGet.mockResolvedValueOnce({
        data: Buffer.from("shared folder content").buffer,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          folderId: "folder-123",
          driveIds: ["shared-drive-1"],
          recursive: false,
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      const call = mockFilesList.mock.calls[0][0] as Record<string, unknown>;
      expect(call.includeItemsFromAllDrives).toBe(true);
      expect(call.supportsAllDrives).toBe(true);
    });
  });

  describe("sync — folder mode with recursive traversal", () => {
    it("syncs files from nested subfolders (BFS traversal)", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      // BFS step 1: listDirectSubfolders for root-folder → returns subfolder-1
      mockFilesList
        .mockResolvedValueOnce({
          data: {
            files: [{ id: "subfolder-1" }],
            nextPageToken: undefined,
          },
        })
        // BFS step 2: Files in root folder
        .mockResolvedValueOnce({
          data: {
            files: [makeDriveFile("root-file", "root.txt")],
            nextPageToken: undefined,
          },
        })
        // BFS step 3: listDirectSubfolders for subfolder-1 (no children)
        .mockResolvedValueOnce({
          data: { files: [], nextPageToken: undefined },
        })
        // BFS step 4: Files in subfolder-1
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

    it("traverses 3 levels deep (root → L1 → L2)", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList
        // BFS: listDirectSubfolders for root → L1
        .mockResolvedValueOnce({
          data: { files: [{ id: "L1" }], nextPageToken: undefined },
        })
        // Files in root
        .mockResolvedValueOnce({
          data: {
            files: [makeDriveFile("f-root", "root.txt")],
            nextPageToken: undefined,
          },
        })
        // BFS: listDirectSubfolders for L1 → L2
        .mockResolvedValueOnce({
          data: { files: [{ id: "L2" }], nextPageToken: undefined },
        })
        // Files in L1
        .mockResolvedValueOnce({
          data: {
            files: [makeDriveFile("f-L1", "level1.txt")],
            nextPageToken: undefined,
          },
        })
        // BFS: listDirectSubfolders for L2 → no children
        .mockResolvedValueOnce({
          data: { files: [], nextPageToken: undefined },
        })
        // Files in L2
        .mockResolvedValueOnce({
          data: {
            files: [makeDriveFile("f-L2", "level2.txt")],
            nextPageToken: undefined,
          },
        });

      mockFilesGet
        .mockResolvedValueOnce({ data: Buffer.from("root").buffer })
        .mockResolvedValueOnce({ data: Buffer.from("L1").buffer })
        .mockResolvedValueOnce({ data: Buffer.from("L2").buffer });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { folderId: "root", recursive: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(3);
      expect(allDocs.map((d) => d.title).sort()).toEqual([
        "level1.txt",
        "level2.txt",
        "root.txt",
      ]);
    });

    it("skips empty intermediate folders", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList
        // BFS: listDirectSubfolders for root → EmptyFolder
        .mockResolvedValueOnce({
          data: { files: [{ id: "empty-folder" }], nextPageToken: undefined },
        })
        // Files in root (has one file)
        .mockResolvedValueOnce({
          data: {
            files: [makeDriveFile("f1", "root.txt")],
            nextPageToken: undefined,
          },
        })
        // BFS: listDirectSubfolders for EmptyFolder → no children
        .mockResolvedValueOnce({
          data: { files: [], nextPageToken: undefined },
        })
        // Files in EmptyFolder (no files)
        .mockResolvedValueOnce({
          data: { files: [], nextPageToken: undefined },
        });

      mockFilesGet.mockResolvedValueOnce({
        data: Buffer.from("root content").buffer,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { folderId: "root", recursive: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(1);
      expect(allDocs[0].title).toBe("root.txt");
    });

    it("stops descending at maxDepth", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList
        // BFS: listDirectSubfolders for root (depth 0 < maxDepth 1) → L1
        .mockResolvedValueOnce({
          data: { files: [{ id: "L1" }], nextPageToken: undefined },
        })
        // Files in root
        .mockResolvedValueOnce({
          data: {
            files: [makeDriveFile("f-root", "root.txt")],
            nextPageToken: undefined,
          },
        })
        // depth 1 === maxDepth 1, so no listDirectSubfolders for L1
        // Files in L1
        .mockResolvedValueOnce({
          data: {
            files: [makeDriveFile("f-L1", "level1.txt")],
            nextPageToken: undefined,
          },
        });

      mockFilesGet
        .mockResolvedValueOnce({ data: Buffer.from("root").buffer })
        .mockResolvedValueOnce({ data: Buffer.from("L1").buffer });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { folderId: "root", recursive: true, maxDepth: 1 },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      // Root (depth 0) files + L1 (depth 1) files, but NOT L1's children
      expect(allDocs).toHaveLength(2);
      // listDirectSubfolders was called once (for root, depth 0) but NOT for L1 (depth 1 >= maxDepth)
      // Total files.list calls: 1 (subfolders of root) + 1 (files in root) + 1 (files in L1) = 3
      expect(mockFilesList).toHaveBeenCalledTimes(3);
    });

    it("handles multiple branches (BranchA, BranchB)", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList
        // BFS: listDirectSubfolders for root → BranchA + BranchB
        .mockResolvedValueOnce({
          data: {
            files: [{ id: "branchA" }, { id: "branchB" }],
            nextPageToken: undefined,
          },
        })
        // Files in root (empty)
        .mockResolvedValueOnce({
          data: { files: [], nextPageToken: undefined },
        })
        // BFS: listDirectSubfolders for BranchA → no children
        .mockResolvedValueOnce({
          data: { files: [], nextPageToken: undefined },
        })
        // Files in BranchA
        .mockResolvedValueOnce({
          data: {
            files: [makeDriveFile("fA", "branchA.txt")],
            nextPageToken: undefined,
          },
        })
        // BFS: listDirectSubfolders for BranchB → no children
        .mockResolvedValueOnce({
          data: { files: [], nextPageToken: undefined },
        })
        // Files in BranchB
        .mockResolvedValueOnce({
          data: {
            files: [makeDriveFile("fB", "branchB.txt")],
            nextPageToken: undefined,
          },
        });

      mockFilesGet
        .mockResolvedValueOnce({ data: Buffer.from("A").buffer })
        .mockResolvedValueOnce({ data: Buffer.from("B").buffer });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { folderId: "root", recursive: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(2);
      expect(allDocs.map((d) => d.title).sort()).toEqual([
        "branchA.txt",
        "branchB.txt",
      ]);
    });

    it("skips branch when subfolder discovery fails", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList
        // BFS: listDirectSubfolders for root → returns badFolder
        .mockResolvedValueOnce({
          data: { files: [{ id: "bad-folder" }], nextPageToken: undefined },
        })
        // Files in root
        .mockResolvedValueOnce({
          data: {
            files: [makeDriveFile("f1", "root.txt")],
            nextPageToken: undefined,
          },
        })
        // BFS: listDirectSubfolders for bad-folder → throws
        .mockRejectedValueOnce(new Error("Permission denied"))
        // Files in bad-folder still returned (even though subfolders failed)
        .mockResolvedValueOnce({
          data: {
            files: [makeDriveFile("f2", "accessible.txt")],
            nextPageToken: undefined,
          },
        });

      mockFilesGet
        .mockResolvedValueOnce({ data: Buffer.from("root").buffer })
        .mockResolvedValueOnce({ data: Buffer.from("accessible").buffer });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { folderId: "root", recursive: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Should get files from both root and bad-folder (files work, subfolders don't)
      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(2);
      expect(allDocs.map((d) => d.title).sort()).toEqual([
        "accessible.txt",
        "root.txt",
      ]);
    });

    it("does not recurse when recursive is explicitly false", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      // No listDirectSubfolders call — only file listing
      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [makeDriveFile("f1", "root-only.txt")],
          nextPageToken: undefined,
        },
      });

      mockFilesGet.mockResolvedValueOnce({
        data: Buffer.from("root only").buffer,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { folderId: "root", recursive: false },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(1);
      expect(allDocs[0].title).toBe("root-only.txt");
      // Only 1 files.list call (for files in root), no subfolder discovery
      expect(mockFilesList).toHaveBeenCalledTimes(1);
    });

    it("applies incremental sync filter across recursive folders", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      const checkpoint = {
        type: "gdrive" as const,
        lastSyncedAt: "2024-06-01T00:00:00.000Z",
      };

      mockFilesList
        // BFS: listDirectSubfolders for root → sub
        .mockResolvedValueOnce({
          data: { files: [{ id: "sub" }], nextPageToken: undefined },
        })
        // Files in root (filtered by modifiedTime)
        .mockResolvedValueOnce({
          data: { files: [], nextPageToken: undefined },
        })
        // BFS: listDirectSubfolders for sub → no children
        .mockResolvedValueOnce({
          data: { files: [], nextPageToken: undefined },
        })
        // Files in sub (one modified after checkpoint)
        .mockResolvedValueOnce({
          data: {
            files: [
              makeDriveFile("f1", "updated.txt", {
                modifiedTime: "2024-06-15T10:00:00.000Z",
              }),
            ],
            nextPageToken: undefined,
          },
        });

      mockFilesGet.mockResolvedValueOnce({
        data: Buffer.from("updated content").buffer,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { folderId: "root", recursive: true },
        credentials,
        checkpoint,
      })) {
        batches.push(batch);
      }

      // Verify the modifiedTime filter is applied to subfolder queries
      const subFolderFileQuery = mockFilesList.mock.calls[3][0] as Record<
        string,
        unknown
      >;
      expect(subFolderFileQuery.q).toContain("modifiedTime >=");

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(1);
      expect(allDocs[0].title).toBe("updated.txt");
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

  describe("sync — multiple driveIds", () => {
    it("iterates over each driveId and syncs files from each", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      // Drive A files
      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [makeDriveFile("fA", "driveA-file.txt")],
          nextPageToken: undefined,
        },
      });
      // Drive B files
      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [makeDriveFile("fB", "driveB-file.txt")],
          nextPageToken: undefined,
        },
      });

      mockFilesGet
        .mockResolvedValueOnce({ data: Buffer.from("Drive A content").buffer })
        .mockResolvedValueOnce({ data: Buffer.from("Drive B content").buffer });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          driveIds: ["shared-drive-A", "shared-drive-B"],
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(2);
      expect(allDocs.map((d) => d.title).sort()).toEqual([
        "driveA-file.txt",
        "driveB-file.txt",
      ]);

      // Verify each call used the correct driveId + corpora
      const callA = mockFilesList.mock.calls[0][0] as Record<string, unknown>;
      expect(callA.driveId).toBe("shared-drive-A");
      expect(callA.corpora).toBe("drive");
      expect(callA.includeItemsFromAllDrives).toBe(true);
      expect(callA.supportsAllDrives).toBe(true);

      const callB = mockFilesList.mock.calls[1][0] as Record<string, unknown>;
      expect(callB.driveId).toBe("shared-drive-B");
      expect(callB.corpora).toBe("drive");
      expect(callB.includeItemsFromAllDrives).toBe(true);
      expect(callB.supportsAllDrives).toBe(true);
    });

    it("falls back to My Drive when driveIds is empty", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [makeDriveFile("f1", "my-drive-file.txt")],
          nextPageToken: undefined,
        },
      });

      mockFilesGet.mockResolvedValueOnce({
        data: Buffer.from("My Drive content").buffer,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { driveIds: [] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches.flatMap((b) => b.documents)).toHaveLength(1);

      // No driveId/corpora should be set (My Drive mode)
      const call = mockFilesList.mock.calls[0][0] as Record<string, unknown>;
      expect(call.driveId).toBeUndefined();
      expect(call.corpora).toBeUndefined();
      expect(call.includeItemsFromAllDrives).toBe(false);
      expect(call.supportsAllDrives).toBe(false);
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

    it("sums counts across multiple driveIds", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      // Drive A: 2 files
      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [makeDriveFile("f1", "a.txt"), makeDriveFile("f2", "b.txt")],
          nextPageToken: undefined,
        },
      });
      // Drive B: 1 file
      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [makeDriveFile("f3", "c.txt")],
          nextPageToken: undefined,
        },
      });

      const result = await connector.estimateTotalItems({
        config: {
          driveIds: ["drive-A", "drive-B"],
        },
        credentials,
        checkpoint: null,
      });

      expect(result).toBe(3);
      expect(mockFilesList).toHaveBeenCalledTimes(2);
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
