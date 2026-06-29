import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorSyncBatch } from "@/types";
import { DropboxConnector } from "./dropbox-connector";

// ===== Mock dropbox SDK =====
const mockFilesListFolder = vi.fn();
const mockFilesListFolderContinue = vi.fn();
const mockFilesDownload = vi.fn();
const mockUsersGetCurrentAccount = vi.fn();

vi.mock("dropbox", () => {
  class MockDropbox {
    filesListFolder = (...args: unknown[]) => mockFilesListFolder(...args);
    filesListFolderContinue = (...args: unknown[]) =>
      mockFilesListFolderContinue(...args);
    filesDownload = (...args: unknown[]) => mockFilesDownload(...args);
    usersGetCurrentAccount = (...args: unknown[]) =>
      mockUsersGetCurrentAccount(...args);
  }
  return { Dropbox: MockDropbox };
});

function makeFile(
  id: string,
  name: string,
  opts?: { serverModified?: string; pathDisplay?: string; size?: number },
) {
  return {
    ".tag": "file" as const,
    id,
    name,
    path_display: opts?.pathDisplay ?? `/docs/${name}`,
    client_modified: "2024-01-01T00:00:00Z",
    server_modified: opts?.serverModified ?? "2024-01-15T10:00:00Z",
    size: opts?.size ?? 1024,
  };
}

function makeListFolderResult(
  entries: ReturnType<typeof makeFile>[],
  opts?: { hasMore?: boolean; cursor?: string },
) {
  return {
    result: {
      entries,
      cursor: opts?.cursor ?? "cursor-initial",
      has_more: opts?.hasMore ?? false,
    },
  };
}

function makeContinueResult(
  entries: ReturnType<typeof makeFile>[],
  opts?: { hasMore?: boolean; cursor?: string },
) {
  return {
    result: {
      entries,
      cursor: opts?.cursor ?? "cursor-next",
      has_more: opts?.hasMore ?? false,
    },
  };
}

function makeDownloadResult(content: string) {
  return {
    result: {
      ".tag": "file",
      fileBlob: new Blob([content], { type: "text/plain" }),
    },
  };
}

const credentials = { apiToken: "test-dropbox-token" };

describe("DropboxConnector", () => {
  beforeEach(() => {
    mockFilesListFolder.mockReset();
    mockFilesListFolderContinue.mockReset();
    mockFilesDownload.mockReset();
    mockUsersGetCurrentAccount.mockReset();
  });

  it("has the correct type", () => {
    const connector = new DropboxConnector();
    expect(connector.type).toBe("dropbox");
  });

  describe("validateConfig", () => {
    it("accepts empty config (no fields required)", async () => {
      const connector = new DropboxConnector();
      const result = await connector.validateConfig({});
      expect(result.valid).toBe(true);
    });

    it("accepts config with rootPath", async () => {
      const connector = new DropboxConnector();
      const result = await connector.validateConfig({ rootPath: "/team-docs" });
      expect(result.valid).toBe(true);
    });

    it("accepts config with fileTypes", async () => {
      const connector = new DropboxConnector();
      const result = await connector.validateConfig({
        fileTypes: [".md", ".txt"],
      });
      expect(result.valid).toBe(true);
    });

    it("accepts config with batchSize", async () => {
      const connector = new DropboxConnector();
      const result = await connector.validateConfig({ batchSize: 25 });
      expect(result.valid).toBe(true);
    });

    it("rejects invalid batchSize type", async () => {
      const connector = new DropboxConnector();
      const result = await connector.validateConfig({
        batchSize: "not-a-number",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid Dropbox configuration");
    });
  });

  describe("testConnection", () => {
    it("returns success on OK response", async () => {
      mockUsersGetCurrentAccount.mockResolvedValueOnce({
        result: { account_id: "dbid:abc123", display_name: "Test User" },
      });
      const connector = new DropboxConnector();
      const result = await connector.testConnection({
        config: {},
        credentials,
      });
      expect(result.success).toBe(true);
    });

    it("returns failure when SDK throws", async () => {
      mockUsersGetCurrentAccount.mockRejectedValueOnce(
        new Error("Unauthorized"),
      );
      const connector = new DropboxConnector();
      const result = await connector.testConnection({
        config: {},
        credentials,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unauthorized");
    });

    it("calls usersGetCurrentAccount", async () => {
      mockUsersGetCurrentAccount.mockResolvedValueOnce({ result: {} });
      const connector = new DropboxConnector();
      await connector.testConnection({ config: {}, credentials });
      expect(mockUsersGetCurrentAccount).toHaveBeenCalledTimes(1);
    });
  });

  describe("sync — full sync (no cursor checkpoint)", () => {
    it("yields a batch of documents from list_folder results", async () => {
      const files = [
        makeFile("id:aaa", "readme.md"),
        makeFile("id:bbb", "notes.txt"),
      ];
      mockFilesListFolder.mockResolvedValueOnce(
        makeListFolderResult([], { cursor: "root-cursor-123" }),
      );
      mockFilesListFolder.mockResolvedValueOnce(makeListFolderResult([]));
      mockFilesListFolder.mockResolvedValueOnce(makeListFolderResult(files));
      mockFilesDownload.mockResolvedValueOnce(
        makeDownloadResult("# Hello world"),
      );
      mockFilesDownload.mockResolvedValueOnce(
        makeDownloadResult("Some notes here"),
      );

      const connector = new DropboxConnector();
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
      expect(batches[0].documents[0].id).toBe("id:aaa");
      expect(batches[0].documents[0].title).toBe("readme.md");
      expect(batches[0].documents[1].id).toBe("id:bbb");
    });

    it("skips folders and deleted entries", async () => {
      mockFilesListFolder.mockResolvedValueOnce(
        makeListFolderResult([], { cursor: "root-cursor-123" }),
      );
      mockFilesListFolder.mockResolvedValueOnce(makeListFolderResult([]));
      mockFilesListFolder.mockResolvedValueOnce({
        result: {
          entries: [
            makeFile("id:aaa", "readme.md"),
            {
              ".tag": "folder",
              id: "id:folder1",
              name: "docs",
              path_display: "/docs",
            },
            { ".tag": "deleted", name: "old.txt" },
            makeFile("id:bbb", "notes.txt"),
          ],
          cursor: "cursor-abc",
          has_more: false,
        },
      });
      mockFilesDownload.mockResolvedValueOnce(makeDownloadResult("Hello"));
      mockFilesDownload.mockResolvedValueOnce(makeDownloadResult("World"));

      const connector = new DropboxConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(2);
      expect(batches[0].documents[0].id).toBe("id:aaa");
      expect(batches[0].documents[1].id).toBe("id:bbb");
    });

    it("filters files by fileTypes config when provided", async () => {
      mockFilesListFolder.mockResolvedValueOnce(
        makeListFolderResult([], { cursor: "root-cursor-123" }),
      );
      mockFilesListFolder.mockResolvedValueOnce(makeListFolderResult([]));
      mockFilesListFolder.mockResolvedValueOnce({
        result: {
          entries: [
            makeFile("id:aaa", "readme.md"),
            makeFile("id:bbb", "image.png"),
            makeFile("id:ccc", "notes.txt"),
          ],
          cursor: "cursor-abc",
          has_more: false,
        },
      });
      mockFilesDownload.mockResolvedValueOnce(
        makeDownloadResult("Markdown content"),
      );
      mockFilesDownload.mockResolvedValueOnce(
        makeDownloadResult("Text content"),
      );

      const connector = new DropboxConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { fileTypes: [".md", ".txt"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(2);
      expect(batches[0].documents.map((d) => d.id)).not.toContain("id:bbb");
    });

    it("post-filters unchanged files when lastSyncedAt checkpoint is present but no cursor", async () => {
      const files = [
        makeFile("id:old", "old.md", {
          serverModified: "2024-01-10T00:00:00Z",
        }),
        makeFile("id:new", "new.md", {
          serverModified: "2024-01-20T00:00:00Z",
        }),
      ];
      mockFilesListFolder.mockResolvedValueOnce(
        makeListFolderResult([], { cursor: "root-cursor-123" }),
      );
      mockFilesListFolder.mockResolvedValueOnce(makeListFolderResult([]));
      mockFilesListFolder.mockResolvedValueOnce(makeListFolderResult(files));
      mockFilesDownload.mockResolvedValueOnce(
        makeDownloadResult("New content"),
      );

      const connector = new DropboxConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: { type: "dropbox", lastSyncedAt: "2024-01-15T12:00:00Z" },
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].id).toBe("id:new");
      expect(mockFilesDownload).toHaveBeenCalledTimes(1);
    });

    it("saves cursor in checkpoint after full sync", async () => {
      mockFilesListFolder.mockResolvedValueOnce(makeListFolderResult([]));
      mockFilesListFolder.mockResolvedValueOnce(
        makeListFolderResult([], { cursor: "root-cursor-123" }),
      );
      mockFilesListFolder.mockResolvedValueOnce(
        makeListFolderResult([makeFile("id:aaa", "readme.md")]),
      );
      mockFilesDownload.mockResolvedValueOnce(makeDownloadResult("Content"));

      const connector = new DropboxConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const cp = batches[0].checkpoint as Record<string, unknown>;
      expect(cp.type).toBe("dropbox");
      expect(cp.cursor).toBe("root-cursor-123");
    });

    it("throws when list_folder returns an error", async () => {
      mockFilesListFolder.mockRejectedValueOnce(
        new Error("Dropbox list_folder failed"),
      );

      const connector = new DropboxConnector();
      const generator = connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      });
      await expect(generator.next()).rejects.toThrow();
    });

    it("paginates list_folder via has_more + continue", async () => {
      const file1 = makeFile("id:aaa", "first.md");
      const file2 = makeFile("id:bbb", "second.md");

      mockFilesListFolder.mockResolvedValueOnce(
        makeListFolderResult([], { cursor: "root-cursor-123" }),
      );
      mockFilesListFolder.mockResolvedValueOnce(makeListFolderResult([]));
      mockFilesListFolder.mockResolvedValueOnce(
        makeListFolderResult([file1], {
          hasMore: true,
          cursor: "cursor-page1",
        }),
      );
      mockFilesListFolderContinue.mockResolvedValueOnce(
        makeContinueResult([file2], { cursor: "cursor-page2" }),
      );
      mockFilesDownload.mockResolvedValueOnce(
        makeDownloadResult("First content"),
      );
      mockFilesDownload.mockResolvedValueOnce(
        makeDownloadResult("Second content"),
      );

      const connector = new DropboxConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(2);
      expect(allDocs[0].id).toBe("id:aaa");
      expect(allDocs[1].id).toBe("id:bbb");
    });

    it("skips file and records failure when download fails", async () => {
      const files = [
        makeFile("id:good1", "good1.md"),
        makeFile("id:bad", "bad.md"),
        makeFile("id:good2", "good2.md"),
      ];

      mockFilesListFolder.mockResolvedValueOnce(
        makeListFolderResult([], { cursor: "root-cursor-123" }),
      );
      mockFilesListFolder.mockResolvedValueOnce(makeListFolderResult([]));
      mockFilesListFolder.mockResolvedValueOnce(makeListFolderResult(files));
      mockFilesDownload.mockResolvedValueOnce(
        makeDownloadResult("Good content 1"),
      );
      mockFilesDownload.mockRejectedValueOnce(new Error("Download failed"));
      mockFilesDownload.mockResolvedValueOnce(
        makeDownloadResult("Good content 2"),
      );

      const connector = new DropboxConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(2);
      expect(batches[0].failures).toHaveLength(1);
      const failures = batches[0].failures ?? [];
      expect(failures[0]?.itemId).toBe("id:bad");
    });

    it("includes correct metadata in document", async () => {
      const file = makeFile("id:aaa", "readme.md", {
        serverModified: "2024-03-01T08:00:00Z",
        pathDisplay: "/docs/readme.md",
        size: 2048,
      });

      mockFilesListFolder.mockResolvedValueOnce(
        makeListFolderResult([], { cursor: "root-cursor-123" }),
      );
      mockFilesListFolder.mockResolvedValueOnce(makeListFolderResult([]));
      mockFilesListFolder.mockResolvedValueOnce(makeListFolderResult([file]));
      mockFilesDownload.mockResolvedValueOnce(makeDownloadResult("Content"));

      const connector = new DropboxConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const metadata = batches[0].documents[0].metadata;
      expect(metadata.dropboxFileId).toBe("id:aaa");
      expect(metadata.pathDisplay).toBe("/docs/readme.md");
      expect(metadata.serverModified).toBe("2024-03-01T08:00:00Z");
      expect(metadata.size).toBe(2048);
    });

    it("builds correct sourceUrl from path_display", async () => {
      const file = makeFile("id:aaa", "readme.md", {
        pathDisplay: "/docs/readme.md",
      });

      mockFilesListFolder.mockResolvedValueOnce(
        makeListFolderResult([], { cursor: "root-cursor-123" }),
      );
      mockFilesListFolder.mockResolvedValueOnce(makeListFolderResult([]));
      mockFilesListFolder.mockResolvedValueOnce(makeListFolderResult([file]));
      mockFilesDownload.mockResolvedValueOnce(makeDownloadResult("Content"));

      const connector = new DropboxConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents[0].sourceUrl).toBe(
        "https://www.dropbox.com/home/docs/readme.md",
      );
    });

    it("preserves previous lastSyncedAt when batch has no files", async () => {
      mockFilesListFolder.mockResolvedValueOnce(
        makeListFolderResult([], { cursor: "root-cursor-123" }),
      );
      mockFilesListFolder.mockResolvedValueOnce(makeListFolderResult([]));
      mockFilesListFolder.mockResolvedValueOnce(makeListFolderResult([]));

      const connector = new DropboxConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: { type: "dropbox", lastSyncedAt: "2024-01-01T00:00:00Z" },
      })) {
        batches.push(batch);
      }

      const cp = batches[0].checkpoint as Record<string, unknown>;
      expect(cp.lastSyncedAt).toBe("2024-01-01T00:00:00Z");
    });
  });

  describe("sync — incremental sync (cursor checkpoint)", () => {
    it("uses list_folder/continue when cursor is present in checkpoint", async () => {
      mockFilesListFolderContinue.mockResolvedValueOnce(
        makeContinueResult([makeFile("id:changed", "changed.md")], {
          cursor: "cursor-updated",
        }),
      );
      mockFilesDownload.mockResolvedValueOnce(
        makeDownloadResult("Updated content"),
      );

      const connector = new DropboxConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: {
          type: "dropbox",
          lastSyncedAt: "2024-01-15T12:00:00Z",
          cursor: "cursor-saved",
        },
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].id).toBe("id:changed");
      expect(mockFilesListFolderContinue).toHaveBeenCalledTimes(1);
      expect(mockFilesListFolder).not.toHaveBeenCalled();
    });

    it("advances cursor in checkpoint after incremental sync", async () => {
      mockFilesListFolderContinue.mockResolvedValueOnce(
        makeContinueResult([makeFile("id:aaa", "file.md")], {
          cursor: "cursor-new-456",
        }),
      );
      mockFilesDownload.mockResolvedValueOnce(makeDownloadResult("Content"));

      const connector = new DropboxConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: { type: "dropbox", cursor: "cursor-old-123" },
      })) {
        batches.push(batch);
      }

      const cp = batches[0].checkpoint as Record<string, unknown>;
      expect(cp.cursor).toBe("cursor-new-456");
    });

    it("yields empty batch with updated cursor when changeset is empty", async () => {
      mockFilesListFolderContinue.mockResolvedValueOnce(
        makeContinueResult([], { cursor: "cursor-latest" }),
      );

      const connector = new DropboxConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: { type: "dropbox", cursor: "cursor-old" },
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(0);
      const cp = batches[0].checkpoint as Record<string, unknown>;
      expect(cp.cursor).toBe("cursor-latest");
    });

    it("throws when list_folder/continue returns error", async () => {
      mockFilesListFolderContinue.mockRejectedValueOnce(
        new Error("Reset required"),
      );

      const connector = new DropboxConnector();
      const generator = connector.sync({
        config: {},
        credentials,
        checkpoint: { type: "dropbox", cursor: "expired-cursor" },
      });

      await expect(generator.next()).rejects.toThrow();
    });
  });

  describe("sync — invalid config", () => {
    it("throws when config is invalid", async () => {
      const connector = new DropboxConnector();
      const generator = connector.sync({
        config: { batchSize: "not-a-number" },
        credentials,
        checkpoint: null,
      });
      await expect(generator.next()).rejects.toThrow(
        "Invalid Dropbox configuration",
      );
    });
  });
});
