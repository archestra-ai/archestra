import { describe, expect, it, vi } from "vitest";
import type { ConnectorSyncBatch } from "@/types";
import { DropboxConnector } from "./dropbox-connector";

// ===== Test helpers =====

interface MakeFileOpts {
  id?: string;
  name?: string;
  pathLower?: string;
  pathDisplay?: string;
  size?: number;
  serverModified?: string;
  clientModified?: string;
  rev?: string;
  contentHash?: string;
}

function makeFile(opts?: MakeFileOpts) {
  const name = opts?.name ?? "doc.md";
  return {
    ".tag": "file" as const,
    id: opts?.id ?? `id:${name}`,
    name,
    path_lower: opts?.pathLower ?? `/${name.toLowerCase()}`,
    path_display: opts?.pathDisplay ?? `/${name}`,
    size: opts?.size ?? 100,
    server_modified: opts?.serverModified ?? "2026-01-15T10:00:00Z",
    client_modified: opts?.clientModified ?? "2026-01-14T10:00:00Z",
    rev: opts?.rev ?? "0123abc",
    content_hash: opts?.contentHash ?? "hash",
  };
}

function makeFolder(name: string, pathDisplay?: string) {
  return {
    ".tag": "folder" as const,
    name,
    path_lower: (pathDisplay ?? `/${name}`).toLowerCase(),
    path_display: pathDisplay ?? `/${name}`,
  };
}

function makeListFolderResponse(
  entries: Array<ReturnType<typeof makeFile> | ReturnType<typeof makeFolder>>,
  opts?: { cursor?: string; hasMore?: boolean },
) {
  return {
    ok: true,
    json: async () => ({
      entries,
      cursor: opts?.cursor ?? "cursor-end",
      has_more: opts?.hasMore ?? false,
    }),
  } as unknown as Response;
}

function makeDownloadResponse(text: string) {
  // Dropbox `/files/download` returns raw bytes; mock arrayBuffer().
  return {
    ok: true,
    arrayBuffer: async () => {
      const buf = Buffer.from(text, "utf-8");
      return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer;
    },
  } as unknown as Response;
}

const credentials = { apiToken: "sl.test-access-token" };

// ===== Tests =====

describe("DropboxConnector", () => {
  it("has the correct type", () => {
    const connector = new DropboxConnector();
    expect(connector.type).toBe("dropbox");
  });

  describe("validateConfig", () => {
    it("accepts empty config (root sync)", async () => {
      const connector = new DropboxConnector();
      const result = await connector.validateConfig({});
      expect(result.valid).toBe(true);
    });

    it("accepts config with folderPath starting with /", async () => {
      const connector = new DropboxConnector();
      const result = await connector.validateConfig({ folderPath: "/Docs" });
      expect(result.valid).toBe(true);
    });

    it("accepts empty-string folderPath (Dropbox root)", async () => {
      const connector = new DropboxConnector();
      const result = await connector.validateConfig({ folderPath: "" });
      expect(result.valid).toBe(true);
    });

    it("rejects folderPath that does not start with /", async () => {
      const connector = new DropboxConnector();
      const result = await connector.validateConfig({ folderPath: "Docs" });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("folderPath");
    });

    it("accepts config with fileTypes and recursive", async () => {
      const connector = new DropboxConnector();
      const result = await connector.validateConfig({
        fileTypes: [".md", ".pdf"],
        recursive: true,
      });
      expect(result.valid).toBe(true);
    });

    it("accepts config with batchSize", async () => {
      const connector = new DropboxConnector();
      const result = await connector.validateConfig({ batchSize: 25 });
      expect(result.valid).toBe(true);
    });
  });

  describe("testConnection", () => {
    it("returns success when Dropbox returns 200", async () => {
      const connector = new DropboxConnector();
      vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      ).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ account_id: "dbid:test" }),
      } as Response);

      const result = await connector.testConnection({
        config: {},
        credentials,
      });

      expect(result.success).toBe(true);
    });

    it("returns failure with HTTP status on non-OK response", async () => {
      const connector = new DropboxConnector();
      vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      ).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Expired access token",
      } as Response);

      const result = await connector.testConnection({
        config: {},
        credentials: { apiToken: "invalid" },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("401");
    });

    it("returns failure when fetch throws", async () => {
      const connector = new DropboxConnector();
      vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      ).mockRejectedValueOnce(new Error("Network error"));

      const result = await connector.testConnection({
        config: {},
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Network error");
    });
  });

  describe("sync — fresh listing (no cursor)", () => {
    it("yields documents for supported files and skips folders", async () => {
      const connector = new DropboxConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const fileA = makeFile({ name: "notes.md" });
      const fileB = makeFile({ name: "readme.txt" });
      const folder = makeFolder("subdir");

      // list_folder response
      fetchMock.mockResolvedValueOnce(
        makeListFolderResponse([fileA, folder, fileB]),
      );
      // download calls for fileA and fileB
      fetchMock.mockResolvedValueOnce(makeDownloadResponse("hello markdown"));
      fetchMock.mockResolvedValueOnce(makeDownloadResponse("plain text body"));

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
      expect(batches[0].documents[0].title).toBe("notes.md");
      expect(batches[0].documents[0].content).toContain("hello markdown");
      expect(batches[0].documents[1].title).toBe("readme.txt");
      expect(batches[0].hasMore).toBe(false);
      expect(batches[0].checkpoint.type).toBe("dropbox");
      // Checkpoint should carry a cursor for next delta sync.
      expect(
        (batches[0].checkpoint as { cursor?: string }).cursor,
      ).toBeDefined();
    });

    it("paginates through multiple list_folder batches", async () => {
      const connector = new DropboxConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const fileA = makeFile({ name: "a.md" });
      const fileB = makeFile({ name: "b.md" });

      // first list_folder — hasMore=true, cursor=mid
      fetchMock.mockResolvedValueOnce(
        makeListFolderResponse([fileA], {
          cursor: "mid",
          hasMore: true,
        }),
      );
      fetchMock.mockResolvedValueOnce(makeDownloadResponse("A contents"));

      // second list_folder/continue — hasMore=false
      fetchMock.mockResolvedValueOnce(
        makeListFolderResponse([fileB], {
          cursor: "end",
          hasMore: false,
        }),
      );
      fetchMock.mockResolvedValueOnce(makeDownloadResponse("B contents"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { recursive: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].hasMore).toBe(true);
      expect(batches[0].documents[0].title).toBe("a.md");
      expect(batches[1].hasMore).toBe(false);
      expect(batches[1].documents[0].title).toBe("b.md");
    });

    it("filters by configured fileTypes", async () => {
      const connector = new DropboxConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const mdFile = makeFile({ name: "kept.md" });
      const txtFile = makeFile({ name: "ignored.txt" });

      fetchMock.mockResolvedValueOnce(makeListFolderResponse([mdFile, txtFile]));
      fetchMock.mockResolvedValueOnce(makeDownloadResponse("hello"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { fileTypes: [".md"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("kept.md");
    });

    it("normalizes fileTypes without leading dot", async () => {
      const connector = new DropboxConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const mdFile = makeFile({ name: "kept.md" });
      fetchMock.mockResolvedValueOnce(makeListFolderResponse([mdFile]));
      fetchMock.mockResolvedValueOnce(makeDownloadResponse("hello"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { fileTypes: ["md"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
    });

    it("skips files older than the checkpoint lastSyncedAt", async () => {
      const connector = new DropboxConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      // checkpoint lastSyncedAt = 2026-01-15T12:00:00Z, safety buffer subtracts
      // 5 minutes, so cutoff is 2026-01-15T11:55:00Z.
      const oldFile = makeFile({
        name: "old.md",
        serverModified: "2026-01-14T00:00:00Z",
      });
      const newFile = makeFile({
        name: "new.md",
        serverModified: "2026-01-16T00:00:00Z",
      });

      fetchMock.mockResolvedValueOnce(
        makeListFolderResponse([oldFile, newFile]),
      );
      // Only newFile should be downloaded.
      fetchMock.mockResolvedValueOnce(makeDownloadResponse("new content"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: {
          type: "dropbox",
          lastSyncedAt: "2026-01-15T12:00:00Z",
        },
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("new.md");
    });

    it("includes a Dropbox web URL as sourceUrl", async () => {
      const connector = new DropboxConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const file = makeFile({
        name: "spec.md",
        pathDisplay: "/Projects/spec.md",
      });
      fetchMock.mockResolvedValueOnce(makeListFolderResponse([file]));
      fetchMock.mockResolvedValueOnce(makeDownloadResponse("hello"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents[0].sourceUrl).toBe(
        "https://www.dropbox.com/home/Projects/spec.md",
      );
    });

    it("skips files with empty downloaded content", async () => {
      const connector = new DropboxConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const file = makeFile({ name: "empty.md" });
      fetchMock.mockResolvedValueOnce(makeListFolderResponse([file]));
      fetchMock.mockResolvedValueOnce(makeDownloadResponse("   "));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(0);
    });

    it("records failures via safeItemFetch when a download errors", async () => {
      const connector = new DropboxConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const fileA = makeFile({ name: "good.md" });
      const fileB = makeFile({ name: "bad.md" });

      fetchMock.mockResolvedValueOnce(makeListFolderResponse([fileA, fileB]));
      fetchMock.mockResolvedValueOnce(makeDownloadResponse("good content"));
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "boom",
      } as Response);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("good.md");
      expect(batches[0].failures ?? []).toHaveLength(1);
      expect(batches[0].failures?.[0].resource).toBe("dropboxFile");
    });

    it("skips files exceeding the max download size", async () => {
      const connector = new DropboxConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const bigFile = makeFile({
        name: "huge.md",
        size: 60 * 1024 * 1024, // 60 MB (above our 50 MB cap)
      });
      fetchMock.mockResolvedValueOnce(makeListFolderResponse([bigFile]));
      // No download should be attempted; if it is, we'll fail here.

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(0);
      // Only 1 fetch call — just list_folder, no download.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("sync — delta mode (with cursor)", () => {
    it("uses list_folder/continue when cursor is present", async () => {
      const connector = new DropboxConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const newFile = makeFile({
        name: "changed.md",
        serverModified: "2026-02-01T00:00:00Z",
      });

      fetchMock.mockResolvedValueOnce(
        makeListFolderResponse([newFile], { cursor: "next-cursor" }),
      );
      fetchMock.mockResolvedValueOnce(makeDownloadResponse("changed content"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: {
          type: "dropbox",
          cursor: "saved-cursor",
          lastSyncedAt: "2026-01-15T00:00:00Z",
        },
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("changed.md");

      // Verify list_folder/continue was called (not list_folder).
      const calls = fetchMock.mock.calls;
      expect(calls[0][0]).toContain("/files/list_folder/continue");
    });

    it("falls back to full listing when cursor is invalidated", async () => {
      const connector = new DropboxConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      // First call: cursor invalidation error.
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: async () => '{"error_summary":"reset/..."}',
      } as Response);

      // Fallback full listing — list_folder.
      const file = makeFile({ name: "fallback.md" });
      fetchMock.mockResolvedValueOnce(makeListFolderResponse([file]));
      fetchMock.mockResolvedValueOnce(makeDownloadResponse("fallback content"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: { type: "dropbox", cursor: "stale-cursor" },
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("fallback.md");

      // Verify the fallback actually hit list_folder (not continue).
      const calls = fetchMock.mock.calls;
      expect(calls[0][0]).toContain("/files/list_folder/continue");
      expect(calls[1][0]).toContain("/files/list_folder");
      expect(calls[1][0]).not.toContain("continue");
    });
  });

  describe("fileToDocument metadata", () => {
    it("preserves Dropbox metadata fields", async () => {
      const connector = new DropboxConnector();
      const fetchMock = vi.spyOn(
        connector as unknown as {
          fetchWithRetry: (...args: unknown[]) => unknown;
        },
        "fetchWithRetry",
      );

      const file = makeFile({
        id: "id:file-123",
        name: "hello.md",
        pathLower: "/hello.md",
        pathDisplay: "/Hello.md",
        size: 42,
        rev: "rev-1",
        contentHash: "hash-abc",
        serverModified: "2026-03-01T10:00:00Z",
      });
      fetchMock.mockResolvedValueOnce(makeListFolderResponse([file]));
      fetchMock.mockResolvedValueOnce(makeDownloadResponse("hi"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const doc = batches[0].documents[0];
      expect(doc.id).toBe("id:file-123");
      expect(doc.metadata.dropboxId).toBe("id:file-123");
      expect(doc.metadata.pathLower).toBe("/hello.md");
      expect(doc.metadata.pathDisplay).toBe("/Hello.md");
      expect(doc.metadata.size).toBe(42);
      expect(doc.metadata.rev).toBe("rev-1");
      expect(doc.metadata.contentHash).toBe("hash-abc");
      expect(doc.updatedAt?.toISOString()).toBe("2026-03-01T10:00:00.000Z");
    });
  });
});
