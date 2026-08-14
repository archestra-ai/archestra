import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorSyncBatch, DocumentPermissions } from "@/types";
import { DropboxConnector } from "./dropbox-connector";

// ===== Mock dropbox SDK =====
const mockFilesListFolder = vi.fn();
const mockFilesListFolderContinue = vi.fn();
const mockFilesListFolderGetLatestCursor = vi.fn();
const mockFilesDownload = vi.fn();
const mockUsersGetCurrentAccount = vi.fn();
const mockSharingListFolderMembers = vi.fn();
const mockSharingListFolderMembersContinue = vi.fn();
const mockSharingListFileMembers = vi.fn();
const mockSharingListFileMembersContinue = vi.fn();
const mockTeamGroupsMembersList = vi.fn();
const mockTeamGroupsMembersListContinue = vi.fn();
const mockTeamTokenGetAuthenticatedAdmin = vi.fn();
const mockDropboxCtor = vi.fn();

/**
 * Which client issued each call: user endpoints must ride the acting
 * identity's client (select-user for a team token), team RPCs the bare one.
 */
const callLog: { method: string; options: { selectUser?: string } }[] = [];

vi.mock("dropbox", () => {
  class MockDropbox {
    // Kept so token-flavor tests can answer differently per client: the
    // bare client refuses user endpoints for team tokens while the
    // select-user client answers them.
    private readonly options: { selectUser?: string };
    constructor(options: { selectUser?: string }) {
      this.options = options;
      mockDropboxCtor(options);
    }
    private record(method: string) {
      callLog.push({ method, options: this.options ?? {} });
    }
    teamGroupsMembersList = (...args: unknown[]) => {
      this.record("teamGroupsMembersList");
      return mockTeamGroupsMembersList(...args);
    };
    teamGroupsMembersListContinue = (...args: unknown[]) =>
      mockTeamGroupsMembersListContinue(...args);
    teamTokenGetAuthenticatedAdmin = (...args: unknown[]) =>
      mockTeamTokenGetAuthenticatedAdmin(...args);
    filesListFolder = (...args: unknown[]) => {
      this.record("filesListFolder");
      return mockFilesListFolder(...args);
    };
    filesListFolderContinue = (...args: unknown[]) =>
      mockFilesListFolderContinue(...args);
    filesListFolderGetLatestCursor = (...args: unknown[]) =>
      mockFilesListFolderGetLatestCursor(...args);
    filesDownload = (...args: unknown[]) => {
      this.record("filesDownload");
      return mockFilesDownload(...args);
    };
    usersGetCurrentAccount = () => mockUsersGetCurrentAccount(this.options);
    sharingListFolderMembers = (...args: unknown[]) => {
      this.record("sharingListFolderMembers");
      return mockSharingListFolderMembers(...args);
    };
    sharingListFolderMembersContinue = (...args: unknown[]) =>
      mockSharingListFolderMembersContinue(...args);
    sharingListFileMembers = (...args: unknown[]) => {
      this.record("sharingListFileMembers");
      return mockSharingListFileMembers(...args);
    };
    sharingListFileMembersContinue = (...args: unknown[]) =>
      mockSharingListFileMembersContinue(...args);
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

/** Node shape: the SDK attaches download bytes as `fileBinary` (never `fileBlob`). */
function makeDownloadResult(content: string | ArrayBuffer | Uint8Array) {
  return {
    result: {
      ".tag": "file",
      fileBinary: Buffer.from(
        content instanceof ArrayBuffer ? new Uint8Array(content) : content,
      ),
    },
  };
}

/** Browser/worker shape: bytes arrive as a `fileBlob` instead. */
function makeBlobDownloadResult(content: string) {
  return {
    result: {
      ".tag": "file",
      fileBlob: new Blob([content], { type: "application/octet-stream" }),
    },
  };
}

/** Minimal valid .xlsx (OOXML zip) with one shared string per cell in row 1. */
async function buildXlsx(cells: string[]): Promise<ArrayBuffer> {
  const zip = new JSZip();
  const sst = cells.map((c) => `<si><t>${c}</t></si>`).join("");
  zip.file(
    "xl/sharedStrings.xml",
    `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sst}</sst>`,
  );
  const row = cells
    .map((_, i) => `<c r="${i}1" t="s"><v>${i}</v></c>`)
    .join("");
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row>${row}</row></sheetData></worksheet>`,
  );
  return zip.generateAsync({ type: "arraybuffer" });
}

/**
 * Content-sync listing stubs for a single flat folder: subfolder traversal
 * (none), the root-scoped cursor fetch, then the folder's file entries.
 */
function stubFlatListing(entries: ReturnType<typeof makeFile>[]) {
  mockFilesListFolder.mockResolvedValueOnce(makeListFolderResult([]));
  mockFilesListFolder.mockResolvedValueOnce(
    makeListFolderResult([], { cursor: "root-cursor" }),
  );
  mockFilesListFolder.mockResolvedValueOnce(makeListFolderResult(entries));
}

const credentials = { apiToken: "test-dropbox-token" };

describe("DropboxConnector", () => {
  beforeEach(() => {
    mockFilesListFolder.mockReset();
    mockFilesListFolderContinue.mockReset();
    mockFilesListFolderGetLatestCursor.mockReset();
    mockFilesDownload.mockReset();
    mockUsersGetCurrentAccount.mockReset();
    mockSharingListFolderMembers.mockReset();
    mockSharingListFolderMembersContinue.mockReset();
    mockSharingListFileMembers.mockReset();
    mockSharingListFileMembersContinue.mockReset();
    mockTeamGroupsMembersList.mockReset();
    mockTeamGroupsMembersListContinue.mockReset();
    mockTeamTokenGetAuthenticatedAdmin.mockReset();
    mockDropboxCtor.mockReset();
    callLog.length = 0;
    // sync() and the permission hooks resolve the account first (team-space
    // path rooting); default to a personal account so content-sync tests
    // stay focused on listing/download behavior.
    mockUsersGetCurrentAccount.mockResolvedValue({
      result: {
        account_id: "dbid:owner001",
        email: "Owner@corp.com",
        name: { display_name: "Owner" },
      },
    });
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

  // ===== Document and image extraction =====

  describe("sync — document and image extraction", () => {
    it("ingests an .xlsx workbook through the shared extractor", async () => {
      stubFlatListing([makeFile("id:x1", "budget.xlsx")]);
      mockFilesDownload.mockResolvedValueOnce(
        makeDownloadResult(await buildXlsx(["Quarter", "Spend"])),
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

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].content).toContain("Quarter");
      expect(batches[0].documents[0].content).toContain("Spend");
    });

    it("records an unsupported-type skip instead of silently dropping unknown binaries", async () => {
      stubFlatListing([
        makeFile("id:v1", "video.mp4"),
        makeFile("id:t1", "notes.txt"),
      ]);
      mockFilesDownload.mockResolvedValueOnce(makeDownloadResult("plain text"));

      const connector = new DropboxConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const skipped = batches.flatMap((batch) => batch.skipped ?? []);
      expect(skipped).toEqual([
        expect.objectContaining({
          itemId: "id:v1",
          category: "unsupported_type",
        }),
      ]);
      expect(batches.flatMap((b) => b.documents).map((d) => d.id)).toEqual([
        "id:t1",
      ]);
      expect(mockFilesDownload).toHaveBeenCalledTimes(1);
    });

    it("ingests images as media chunks when the embedding model accepts the format", async () => {
      stubFlatListing([makeFile("id:i1", "diagram.png")]);
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      mockFilesDownload.mockResolvedValueOnce(makeDownloadResult(pngBytes));

      const connector = new DropboxConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
        embeddingInputModalities: ["image"],
        embeddingAcceptedImageMimeTypes: ["image/png"],
      })) {
        batches.push(batch);
      }

      const doc = batches[0].documents[0];
      expect(doc.mediaContent).toEqual({
        mimeType: "image/png",
        data: Buffer.from(pngBytes).toString("base64"),
      });
      expect(doc.content).toBe("# diagram.png");
    });

    it("skips images when the embedding model has no image modality", async () => {
      stubFlatListing([makeFile("id:i1", "diagram.png")]);

      const connector = new DropboxConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches.flatMap((b) => b.documents)).toHaveLength(0);
      expect(batches.flatMap((b) => b.skipped ?? [])).toEqual([
        expect.objectContaining({
          itemId: "id:i1",
          category: "unsupported_type",
        }),
      ]);
      expect(mockFilesDownload).not.toHaveBeenCalled();
    });

    it("reads browser-shaped downloads (fileBlob) too", async () => {
      stubFlatListing([makeFile("id:b1", "notes.txt")]);
      mockFilesDownload.mockResolvedValueOnce(
        makeBlobDownloadResult("from a blob"),
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

      expect(batches[0].documents[0].content).toBe("from a blob");
    });

    it("records a no-text skip for a file that yields nothing extractable", async () => {
      stubFlatListing([makeFile("id:e1", "empty.txt")]);
      mockFilesDownload.mockResolvedValueOnce(makeDownloadResult(""));

      const connector = new DropboxConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches.flatMap((b) => b.documents)).toHaveLength(0);
      expect(batches.flatMap((b) => b.skipped ?? [])).toEqual([
        expect.objectContaining({
          itemId: "id:e1",
          category: "no_extractable_text",
        }),
      ]);
    });
  });

  // ===== Permission sync =====

  function makeCorpusFile(
    id: string,
    opts?: { sharedFolderId?: string; explicitMembers?: boolean },
  ) {
    return {
      ".tag": "file" as const,
      id,
      name: `${id}.md`,
      path_display: `/docs/${id}.md`,
      client_modified: "2024-01-01T00:00:00Z",
      server_modified: "2024-01-15T10:00:00Z",
      size: 10,
      ...(opts?.sharedFolderId
        ? { sharing_info: { parent_shared_folder_id: opts.sharedFolderId } }
        : {}),
      ...(opts?.explicitMembers ? { has_explicit_shared_members: true } : {}),
    };
  }

  function stubWalk(entries: unknown[]) {
    mockFilesListFolder.mockResolvedValue(
      makeListFolderResult(entries as ReturnType<typeof makeFile>[]),
    );
  }

  function stubAccount(email = "Owner@corp.com") {
    mockUsersGetCurrentAccount.mockResolvedValue({
      result: {
        account_id: "dbid:owner",
        email,
        name: { display_name: "Owner" },
      },
    });
  }

  function makeUserMember(
    accountId: string,
    email: string | undefined,
    accessTag = "editor",
    opts?: { inherited?: boolean; displayName?: string },
  ) {
    return {
      access_type: { ".tag": accessTag },
      is_inherited: opts?.inherited ?? false,
      user: {
        account_id: accountId,
        email,
        display_name: opts?.displayName ?? accountId,
        same_team: true,
      },
    };
  }

  function makeGroupMember(
    groupId: string,
    name: string,
    accessTag = "viewer",
  ) {
    return {
      access_type: { ".tag": accessTag },
      group: {
        group_id: groupId,
        group_name: name,
        group_management_type: { ".tag": "company_managed" },
        group_type: { ".tag": "team" },
        is_member: false,
        is_owner: false,
        same_team: true,
      },
    };
  }

  function makeMemberPage(opts: {
    users?: unknown[];
    groups?: unknown[];
    invitees?: unknown[];
    cursor?: string;
  }) {
    return {
      result: {
        users: opts.users ?? [],
        groups: opts.groups ?? [],
        invitees: opts.invitees ?? [],
        ...(opts.cursor ? { cursor: opts.cursor } : {}),
      },
    };
  }

  function readBack(sourceIds: string[]) {
    return async (_args: {
      metadataFilter?: Record<string, string>;
      afterId?: string | null;
      limit: number;
    }) => ({
      documents: sourceIds.map((sourceId) => ({ sourceId, metadata: null })),
      nextAfterId: null,
    });
  }

  function makeSnapshotParams(overrides?: {
    sourceIds?: string[];
    resolveMappedEmail?: (accountId: string) => string | null;
  }) {
    return {
      config: {},
      credentials,
      cursor: null,
      readIngestedDocuments: readBack(overrides?.sourceIds ?? ["id:f1"]),
      ...(overrides?.resolveMappedEmail
        ? { resolveMappedEmail: overrides.resolveMappedEmail }
        : {}),
    };
  }

  async function collectYields<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of gen) out.push(item);
    return out;
  }

  describe("syncPermissionSnapshot", () => {
    it("yields nothing when the delta scope excludes the top-level container", async () => {
      const connector = new DropboxConnector();
      const yields = await collectYields(
        connector.syncPermissionSnapshot({
          ...makeSnapshotParams(),
          scope: { containerKeys: ["sf:elsewhere"] },
        }),
      );
      expect(yields).toEqual([]);
    });

    it("assigns unshared files to the account container with the token account's audience", async () => {
      stubAccount();
      stubWalk([makeCorpusFile("id:f1"), makeCorpusFile("id:f2")]);

      const connector = new DropboxConnector();
      const yields = await collectYields(
        connector.syncPermissionSnapshot(
          makeSnapshotParams({ sourceIds: ["id:f1", "id:f2"] }),
        ),
      );

      expect(yields[0]).toMatchObject({
        kind: "container",
        containerKey: "account",
        permissions: { isPublic: false, users: ["owner@corp.com"], groups: [] },
        audienceResolutionFailed: false,
      });
      expect(yields.slice(1)).toEqual([
        expect.objectContaining({
          kind: "document",
          sourceId: "id:f1",
          containerKey: "account",
        }),
        expect.objectContaining({
          kind: "document",
          sourceId: "id:f2",
          containerKey: "account",
        }),
      ]);
      for (const item of yields) {
        expect((item as { cursor: string }).cursor).toBe("account");
      }
    });

    it("groups shared-folder files under a nested container with the folder's member audience", async () => {
      stubAccount();
      stubWalk([
        makeCorpusFile("id:f1", { sharedFolderId: "sf-1" }),
        makeCorpusFile("id:f2", { sharedFolderId: "sf-1" }),
      ]);
      mockSharingListFolderMembers.mockResolvedValue(
        makeMemberPage({
          users: [
            makeUserMember("dbid:alice", "Alice@corp.com", "editor"),
            makeUserMember("dbid:tom", "tom@corp.com", "traverse"),
          ],
          groups: [makeGroupMember("g:eng123", "Engineering")],
          invitees: [{ invitee: { ".tag": "email", email: "new@corp.com" } }],
        }),
      );

      const connector = new DropboxConnector();
      const yields = await collectYields(
        connector.syncPermissionSnapshot(
          makeSnapshotParams({ sourceIds: ["id:f1", "id:f2"] }),
        ),
      );

      const nested = yields.find(
        (item) =>
          item.kind === "container" && item.containerKey === "account/sf:sf-1",
      );
      expect(nested).toBeDefined();
      expect(nested).toMatchObject({ audienceResolutionFailed: false });
      const permissions = (nested as { permissions: DocumentPermissions })
        .permissions;
      expect([...(permissions.users ?? [])].sort()).toEqual([
        "alice@corp.com",
        "owner@corp.com",
      ]);
      expect(permissions.groups).toEqual(["g:eng123"]);

      // One nested container for both files, yielded before its documents.
      const containerYields = yields.filter(
        (item) => item.kind === "container",
      );
      expect(containerYields).toHaveLength(2);
      const nestedIndex = yields.findIndex((item) => item === nested);
      const docIndexes = yields
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.kind === "document")
        .map(({ index }) => index);
      expect(Math.min(...docIndexes)).toBeGreaterThan(nestedIndex);
      expect(mockSharingListFolderMembers).toHaveBeenCalledTimes(1);
    });

    it("resolves explicit non-inherited file members as exception users", async () => {
      stubAccount();
      stubWalk([makeCorpusFile("id:f1", { explicitMembers: true })]);
      mockSharingListFileMembers.mockResolvedValue(
        makeMemberPage({
          users: [
            makeUserMember("dbid:carol", "carol@corp.com", "viewer"),
            makeUserMember("dbid:dave", "dave@corp.com", "viewer", {
              inherited: true,
            }),
          ],
          groups: [makeGroupMember("g:sales", "Sales")],
        }),
      );

      const connector = new DropboxConnector();
      const yields = await collectYields(
        connector.syncPermissionSnapshot(makeSnapshotParams()),
      );

      const doc = yields.find((item) => item.kind === "document");
      expect(doc).toMatchObject({
        sourceId: "id:f1",
        containerKey: "account",
        exceptionUsers: ["carol@corp.com"],
      });
      expect(mockSharingListFileMembers).toHaveBeenCalledWith(
        expect.objectContaining({ file: "id:f1", include_inherited: false }),
      );
    });

    it("fail-closes a shared folder whose member list cannot be read", async () => {
      stubAccount();
      stubWalk([makeCorpusFile("id:f1", { sharedFolderId: "sf-9" })]);
      mockSharingListFolderMembers.mockRejectedValue(new Error("403"));

      const connector = new DropboxConnector();
      const yields = await collectYields(
        connector.syncPermissionSnapshot(makeSnapshotParams()),
      );

      const nested = yields.find(
        (item) =>
          item.kind === "container" && item.containerKey === "account/sf:sf-9",
      );
      expect(nested).toMatchObject({
        permissions: { isPublic: false, users: [], groups: [] },
        audienceResolutionFailed: true,
      });
      expect(yields.at(-1)).toMatchObject({
        kind: "document",
        sourceId: "id:f1",
        containerKey: "account/sf:sf-9",
      });
    });

    it("fail-closes the whole corpus when the tree walk fails", async () => {
      mockFilesListFolder.mockRejectedValue(new Error("network"));

      const connector = new DropboxConnector();
      const yields = await collectYields(
        connector.syncPermissionSnapshot(
          makeSnapshotParams({ sourceIds: ["id:f1", "id:f2"] }),
        ),
      );

      expect(yields[0]).toMatchObject({
        kind: "container",
        containerKey: "account",
        permissions: { isPublic: false, users: [], groups: [] },
        audienceResolutionFailed: true,
      });
      expect(
        yields
          .filter((item) => item.kind === "document")
          .map((item) => (item as { sourceId: string }).sourceId)
          .sort(),
      ).toEqual(["id:f1", "id:f2"]);
    });

    it("emits the fail-closed boundary container for an empty corpus without upstream calls", async () => {
      const connector = new DropboxConnector();
      const yields = await collectYields(
        connector.syncPermissionSnapshot(makeSnapshotParams({ sourceIds: [] })),
      );

      expect(yields).toEqual([
        expect.objectContaining({
          kind: "container",
          containerKey: "account",
          permissions: { isPublic: false, users: [], groups: [] },
          audienceResolutionFailed: false,
        }),
      ]);
      expect(mockFilesListFolder).not.toHaveBeenCalled();
      expect(mockUsersGetCurrentAccount).not.toHaveBeenCalled();
    });

    it("rescues a member without an upstream email through the admin mapping", async () => {
      stubAccount();
      stubWalk([makeCorpusFile("id:f1", { sharedFolderId: "sf-1" })]);
      mockSharingListFolderMembers.mockResolvedValue(
        makeMemberPage({
          users: [
            makeUserMember("dbid:hidden", undefined, "editor"),
            makeUserMember("dbid:gone", undefined, "editor"),
          ],
        }),
      );

      const connector = new DropboxConnector();
      const yields = await collectYields(
        connector.syncPermissionSnapshot(
          makeSnapshotParams({
            resolveMappedEmail: (accountId) =>
              accountId === "dbid:hidden" ? "Mapped@corp.com" : null,
          }),
        ),
      );

      const nested = yields.find(
        (item) =>
          item.kind === "container" && item.containerKey === "account/sf:sf-1",
      );
      const permissions = (nested as { permissions: DocumentPermissions })
        .permissions;
      // The mapped member resolves; the unmapped one is dropped fail-closed.
      expect([...(permissions.users ?? [])].sort()).toEqual([
        "mapped@corp.com",
        "owner@corp.com",
      ]);
    });
  });

  describe("syncGroups", () => {
    it("flags granted groups fail-closed when the token lacks team scopes, rostering direct grantees inline", async () => {
      stubAccount();
      stubWalk([makeCorpusFile("id:f1", { sharedFolderId: "sf-1" })]);
      mockSharingListFolderMembers.mockResolvedValue(
        makeMemberPage({
          users: [makeUserMember("dbid:alice", "alice@corp.com", "editor")],
          groups: [makeGroupMember("g:eng123", "Engineering")],
        }),
      );
      mockTeamGroupsMembersList.mockRejectedValue(
        new Error("missing_scope/groups.read"),
      );

      const connector = new DropboxConnector();
      const yields = await collectYields(
        connector.syncGroups(makeSnapshotParams()),
      );

      expect(yields).toEqual([
        {
          groupId: "g:eng123",
          name: "Engineering",
          members: [],
          membershipResolutionFailed: true,
        },
        {
          groupId: "direct-grants",
          name: null,
          members: [
            expect.objectContaining({
              accountId: "dbid:alice",
              email: "alice@corp.com",
              accountType: "user",
            }),
            expect.objectContaining({
              accountId: "dbid:owner",
              email: "Owner@corp.com",
              accountType: "user",
            }),
          ],
        },
      ]);
    });

    it("does not roster a traverse-only group — it grants no read", async () => {
      stubAccount();
      stubWalk([makeCorpusFile("id:f1", { sharedFolderId: "sf-1" })]);
      mockSharingListFolderMembers.mockResolvedValue(
        makeMemberPage({
          users: [],
          groups: [makeGroupMember("g:walkers", "Walkers", "traverse")],
        }),
      );

      const connector = new DropboxConnector();
      const yields = await collectYields(
        connector.syncGroups(makeSnapshotParams()),
      );

      // Only the owner's direct-grants roster — no group yield at all.
      expect(yields).toEqual([
        {
          groupId: "direct-grants",
          name: null,
          members: [expect.objectContaining({ accountId: "dbid:owner" })],
        },
      ]);
    });

    it("throws when the corpus walk fails instead of yielding a truncated roster", async () => {
      stubAccount();
      mockFilesListFolder.mockRejectedValue(new Error("network"));

      const connector = new DropboxConnector();
      await expect(
        collectYields(connector.syncGroups(makeSnapshotParams())),
      ).rejects.toThrow("network");
    });

    it("skips a folder whose member list cannot be read", async () => {
      stubAccount();
      stubWalk([makeCorpusFile("id:f1", { sharedFolderId: "sf-1" })]);
      mockSharingListFolderMembers.mockRejectedValue(new Error("403"));

      const connector = new DropboxConnector();
      const yields = await collectYields(
        connector.syncGroups(makeSnapshotParams()),
      );

      expect(yields).toEqual([
        {
          groupId: "direct-grants",
          name: null,
          members: [expect.objectContaining({ accountId: "dbid:owner" })],
        },
      ]);
    });

    it("expands granted groups to active members through the access token's team scopes", async () => {
      stubAccount();
      stubWalk([makeCorpusFile("id:f1", { sharedFolderId: "sf-1" })]);
      mockSharingListFolderMembers.mockResolvedValue(
        makeMemberPage({
          groups: [makeGroupMember("g:eng123", "Engineering")],
        }),
      );
      mockTeamGroupsMembersList.mockResolvedValue({
        result: {
          members: [
            {
              access_type: { ".tag": "member" },
              profile: {
                team_member_id: "dbmid:alice",
                account_id: "dbid:alice01",
                email: "alice@corp.com",
                name: { display_name: "Alice QA" },
                status: { ".tag": "active" },
              },
            },
            {
              access_type: { ".tag": "member" },
              profile: {
                team_member_id: "dbmid:pending",
                email: "pending@corp.com",
                name: { display_name: "Pending" },
                status: { ".tag": "invited" },
              },
            },
          ],
          cursor: "c",
          has_more: false,
        },
      });

      const connector = new DropboxConnector();
      const yields = await collectYields(
        connector.syncGroups(makeSnapshotParams()),
      );

      const group = yields.find((y) => y.groupId === "g:eng123");
      expect(group?.members).toEqual([
        {
          accountId: "dbid:alice01",
          displayName: "Alice QA",
          email: "alice@corp.com",
          accountType: "user",
        },
      ]);
      expect(group?.membershipResolutionFailed).toBeUndefined();
      expect(mockTeamGroupsMembersList).toHaveBeenCalledWith(
        expect.objectContaining({
          group: { ".tag": "group_id", group_id: "g:eng123" },
        }),
      );
    });

    it("flags a group whose team expansion fails instead of yielding it silently empty", async () => {
      stubAccount();
      stubWalk([makeCorpusFile("id:f1", { sharedFolderId: "sf-1" })]);
      mockSharingListFolderMembers.mockResolvedValue(
        makeMemberPage({
          groups: [makeGroupMember("g:eng123", "Engineering")],
        }),
      );
      mockTeamGroupsMembersList.mockRejectedValue(new Error("bad token"));

      const connector = new DropboxConnector();
      const yields = await collectYields(
        connector.syncGroups(makeSnapshotParams()),
      );

      expect(yields.find((y) => y.groupId === "g:eng123")).toMatchObject({
        members: [],
        membershipResolutionFailed: true,
      });
    });
  });

  describe("team-linked access token", () => {
    /**
     * A team token: user endpoints refuse the bare client, the admin
     * resolver answers, and the select-user client acts as the admin.
     */
    function stubTeamToken(opts?: { rootInfo?: Record<string, string> }) {
      mockUsersGetCurrentAccount.mockImplementation(
        (options?: { selectUser?: string }) =>
          options?.selectUser
            ? Promise.resolve({
                result: {
                  account_id: "dbid:admin01",
                  email: "admin@corp.com",
                  name: { display_name: "Admin" },
                  ...(opts?.rootInfo ? { root_info: opts.rootInfo } : {}),
                },
              })
            : Promise.reject(new Error("Response failed with a 400 code")),
      );
      mockTeamTokenGetAuthenticatedAdmin.mockResolvedValue({
        result: { admin_profile: { team_member_id: "dbmid:admin01" } },
      });
    }

    it("testConnection acts as the admin who generated the token", async () => {
      stubTeamToken();

      const connector = new DropboxConnector();
      const result = await connector.testConnection({
        config: {},
        credentials,
      });

      expect(result.success).toBe(true);
      expect(mockDropboxCtor).toHaveBeenCalledWith(
        expect.objectContaining({ selectUser: "dbmid:admin01" }),
      );
    });

    it("surfaces the user-endpoint refusal when the token is neither flavor", async () => {
      mockUsersGetCurrentAccount.mockRejectedValue(
        new Error("invalid_access_token"),
      );
      mockTeamTokenGetAuthenticatedAdmin.mockRejectedValue(
        new Error("Response failed with a 400 code"),
      );

      const connector = new DropboxConnector();
      const result = await connector.testConnection({
        config: {},
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("invalid_access_token");
    });

    it("combines select-user with team-space path rooting", async () => {
      stubTeamToken({
        rootInfo: {
          ".tag": "team",
          root_namespace_id: "ns-team-root",
          home_namespace_id: "ns-admin-home",
        },
      });
      mockFilesListFolderGetLatestCursor.mockResolvedValue({
        result: { cursor: "fresh-cursor" },
      });

      const connector = new DropboxConnector();
      await connector.probePermissionChanges({
        config: {},
        credentials,
        state: null,
      });

      expect(mockDropboxCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          selectUser: "dbmid:admin01",
          pathRoot: JSON.stringify({ ".tag": "root", root: "ns-team-root" }),
        }),
      );
    });

    it("expands group rosters while user calls act as the admin", async () => {
      stubTeamToken();
      stubWalk([makeCorpusFile("id:f1", { sharedFolderId: "sf-1" })]);
      mockSharingListFolderMembers.mockResolvedValue(
        makeMemberPage({
          groups: [makeGroupMember("g:eng123", "Engineering")],
        }),
      );
      mockTeamGroupsMembersList.mockResolvedValue({
        result: {
          members: [
            {
              access_type: { ".tag": "member" },
              profile: {
                team_member_id: "dbmid:alice",
                account_id: "dbid:alice01",
                email: "alice@corp.com",
                name: { display_name: "Alice QA" },
                status: { ".tag": "active" },
              },
            },
          ],
          cursor: "c",
          has_more: false,
        },
      });

      const connector = new DropboxConnector();
      const yields = await collectYields(
        connector.syncGroups(makeSnapshotParams()),
      );

      const group = yields.find((y) => y.groupId === "g:eng123");
      expect(group?.members).toEqual([
        expect.objectContaining({ email: "alice@corp.com" }),
      ]);
      expect(group?.membershipResolutionFailed).toBeUndefined();
      // The admin is the acting owner and joins the direct grantees.
      expect(
        yields.find((y) => y.groupId === "direct-grants")?.members,
      ).toEqual([expect.objectContaining({ accountId: "dbid:admin01" })]);
      // Team RPCs must ride the BARE client — Dropbox refuses them from a
      // member context.
      expect(
        callLog
          .filter(({ method }) => method === "teamGroupsMembersList")
          .every(({ options }) => options.selectUser === undefined),
      ).toBe(true);
    });

    it("routes every files and sharing call through the acting admin, with no team space to path-root", async () => {
      // No rootInfo: the admin has no separate team space, so select-user is
      // the ONLY header distinguishing the acting client — dropping it would
      // make every user-endpoint call fail against a real team token.
      stubTeamToken();
      stubWalk([makeCorpusFile("id:f1", { sharedFolderId: "sf-1" })]);
      mockSharingListFolderMembers.mockResolvedValue(
        makeMemberPage({
          users: [makeUserMember("dbid:alice", "alice@corp.com", "editor")],
        }),
      );

      const connector = new DropboxConnector();
      await collectYields(
        connector.syncPermissionSnapshot(makeSnapshotParams()),
      );

      const userEndpointCalls = callLog.filter(
        ({ method }) => !method.startsWith("team"),
      );
      expect(userEndpointCalls.length).toBeGreaterThan(0);
      expect(
        userEndpointCalls.every(
          ({ options }) => options.selectUser === "dbmid:admin01",
        ),
      ).toBe(true);
    });
  });

  describe("probePermissionChanges", () => {
    it("returns fullRequired with a fresh cursor on the first probe", async () => {
      stubAccount();
      mockFilesListFolderGetLatestCursor.mockResolvedValue({
        result: { cursor: "fresh-cursor" },
      });

      const connector = new DropboxConnector();
      const result = await connector.probePermissionChanges({
        config: {},
        credentials,
        state: null,
      });

      expect(result).toEqual({
        dirtyContainerKeys: [],
        fullRequired: true,
        nextState: { cursor: "fresh-cursor" },
      });
      expect(mockFilesListFolderGetLatestCursor).toHaveBeenCalledWith(
        expect.objectContaining({ path: "", recursive: true }),
      );
    });

    it("reports a quiet feed as clean and advances the cursor", async () => {
      stubAccount();
      mockFilesListFolderContinue.mockResolvedValue(
        makeContinueResult([], { cursor: "c2", hasMore: false }),
      );

      const connector = new DropboxConnector();
      const result = await connector.probePermissionChanges({
        config: {},
        credentials,
        state: { cursor: "c1" },
      });

      expect(result).toEqual({
        dirtyContainerKeys: [],
        fullRequired: false,
        nextState: { cursor: "c2" },
      });
    });

    it("dirties the account container on file drift", async () => {
      stubAccount();
      mockFilesListFolderContinue.mockResolvedValue(
        makeContinueResult([makeFile("id:f9", "f9.md")], {
          cursor: "c3",
          hasMore: false,
        }),
      );

      const connector = new DropboxConnector();
      const result = await connector.probePermissionChanges({
        config: {},
        credentials,
        state: { cursor: "c1" },
      });

      expect(result.dirtyContainerKeys).toEqual(["account"]);
      expect(result.fullRequired).toBe(false);
    });

    it("promotes a rejected cursor to a full reconcile", async () => {
      stubAccount();
      mockFilesListFolderContinue.mockRejectedValue(new Error("reset"));
      mockFilesListFolderGetLatestCursor.mockResolvedValue({
        result: { cursor: "fresh-cursor" },
      });

      const connector = new DropboxConnector();
      const result = await connector.probePermissionChanges({
        config: {},
        credentials,
        state: { cursor: "expired" },
      });

      expect(result).toEqual({
        dirtyContainerKeys: [],
        fullRequired: true,
        nextState: { cursor: "fresh-cursor" },
      });
    });

    it("roots API calls at the team namespace for team-space accounts", async () => {
      mockUsersGetCurrentAccount.mockResolvedValue({
        result: {
          account_id: "dbid:owner001",
          email: "owner@corp.com",
          name: { display_name: "Owner" },
          root_info: {
            ".tag": "team",
            root_namespace_id: "ns-team-root",
            home_namespace_id: "ns-member-home",
          },
        },
      });
      mockFilesListFolderGetLatestCursor.mockResolvedValue({
        result: { cursor: "fresh-cursor" },
      });

      const connector = new DropboxConnector();
      await connector.probePermissionChanges({
        config: {},
        credentials,
        state: null,
      });

      expect(mockDropboxCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          pathRoot: JSON.stringify({ ".tag": "root", root: "ns-team-root" }),
        }),
      );
    });

    it("uses a plain client when the account has no separate team root", async () => {
      stubAccount();
      mockFilesListFolderGetLatestCursor.mockResolvedValue({
        result: { cursor: "fresh-cursor" },
      });

      const connector = new DropboxConnector();
      await connector.probePermissionChanges({
        config: {},
        credentials,
        state: null,
      });

      for (const call of mockDropboxCtor.mock.calls) {
        expect(call[0]).not.toHaveProperty("pathRoot");
      }
    });
  });

  describe("refreshContainerAudiences", () => {
    it("re-resolves the account and shared-folder containers", async () => {
      stubAccount();
      mockSharingListFolderMembers.mockResolvedValue(
        makeMemberPage({
          users: [makeUserMember("dbid:alice", "alice@corp.com", "viewer")],
        }),
      );

      const connector = new DropboxConnector();
      const yields = await collectYields(
        connector.refreshContainerAudiences({
          config: {},
          credentials,
          containerKeys: ["account", "account/sf:sf-1", "bogus:key"],
        }),
      );

      expect(yields).toHaveLength(2);
      expect(yields[0]).toMatchObject({
        containerKey: "account",
        permissions: { users: ["owner@corp.com"] },
        audienceResolutionFailed: false,
      });
      expect(yields[1].containerKey).toBe("account/sf:sf-1");
      expect([...(yields[1].permissions.users ?? [])].sort()).toEqual([
        "alice@corp.com",
        "owner@corp.com",
      ]);
    });

    it("fail-closes a container whose folder can no longer be read", async () => {
      stubAccount();
      mockSharingListFolderMembers.mockRejectedValue(new Error("gone"));

      const connector = new DropboxConnector();
      const yields = await collectYields(
        connector.refreshContainerAudiences({
          config: {},
          credentials,
          containerKeys: ["account/sf:sf-1"],
        }),
      );

      expect(yields).toEqual([
        {
          containerKey: "account/sf:sf-1",
          permissions: { isPublic: false, users: [], groups: [] },
          audienceResolutionFailed: true,
        },
      ]);
    });
  });

  describe("scopeKeyForDocument", () => {
    it("maps every stored document to the single top-level container", () => {
      const connector = new DropboxConnector();
      expect(connector.scopeKeyForDocument({})).toBe("account");
      expect(connector.scopeKeyForDocument({ pathDisplay: "/docs/a.md" })).toBe(
        "account",
      );
    });
  });
});
