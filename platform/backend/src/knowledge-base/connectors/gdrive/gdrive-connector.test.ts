import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorSyncBatch } from "@/types";
import { GoogleDriveConnector } from "./gdrive-connector";

// The bundled pdf.js build is non-deterministic on repeated in-process parses
// (see pdf-utils.test.ts), so the scanned-PDF path stubs the parse result and
// keeps the real describePdfEmptyText reason formatting.
vi.mock("../pdf-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pdf-utils")>();
  return {
    ...actual,
    parsePdfBuffer: vi.fn().mockResolvedValue({
      text: "",
      status: "no_text_layer",
      pageCount: 12,
    }),
  };
});

// ===== Mock googleapis =====

const mockFilesList = vi.fn();
const mockFilesGet = vi.fn();
const mockFilesExport = vi.fn();
const mockAboutGet = vi.fn();
const mockDrivesList = vi.fn();
const mockDrivesGet = vi.fn();
const mockPermissionsList = vi.fn();
const mockDirectoryUsersList = vi.fn();

/**
 * Every identity a Drive client was built for, in order. Impersonation is the
 * whole point of the delegated modes, and it is invisible in the request
 * mocks — the subject is fixed when the client is constructed, not passed per
 * call — so it is recorded here instead.
 */
const impersonatedSubjects: string[] = [];
/** Client ids handed to an OAuth2 client, and the credentials set on it. */
const oauthClients: Array<{
  clientId?: string;
  credentials: Record<string, unknown>;
}> = [];

vi.mock("googleapis", () => {
  class MockOAuth2 {
    credentials: Record<string, unknown> = {};
    constructor(
      public clientId?: string,
      public clientSecret?: string,
    ) {
      oauthClients.push({ clientId, credentials: this.credentials });
    }
    setCredentials = vi.fn((next: Record<string, unknown>) => {
      this.credentials = next;
      const entry = oauthClients[oauthClients.length - 1];
      if (entry) entry.credentials = next;
    });
  }
  class MockGoogleAuth {
    subject?: string;
    constructor(options?: { clientOptions?: { subject?: string } }) {
      this.subject = options?.clientOptions?.subject;
      if (this.subject) impersonatedSubjects.push(this.subject);
    }
  }

  return {
    google: {
      drive: () => ({
        files: {
          list: (...args: unknown[]) => mockFilesList(...args),
          get: (...args: unknown[]) => mockFilesGet(...args),
          export: (...args: unknown[]) => mockFilesExport(...args),
        },
        drives: {
          list: (...args: unknown[]) => mockDrivesList(...args),
          get: (...args: unknown[]) => mockDrivesGet(...args),
        },
        permissions: {
          list: (...args: unknown[]) => mockPermissionsList(...args),
        },
        about: {
          get: (...args: unknown[]) => mockAboutGet(...args),
        },
      }),
      admin: () => ({
        users: {
          list: (...args: unknown[]) => mockDirectoryUsersList(...args),
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

/** A service-account key, which is what the non-legacy modes require. */
const serviceAccountKey = JSON.stringify({
  type: "service_account",
  client_email: "indexer@example.iam.gserviceaccount.com",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
});
const serviceAccountCredentials = { apiToken: serviceAccountKey };

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
  mockDrivesList.mockReset();
  mockDrivesGet.mockReset();
  mockPermissionsList.mockReset();
  mockDirectoryUsersList.mockReset();
  impersonatedSubjects.length = 0;
  oauthClients.length = 0;
}

/** Minimal valid .docx (OOXML zip) wrapping a single paragraph of text. */
async function buildDocx(text: string): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "arraybuffer" });
}

/** Minimal valid .xlsx (OOXML zip) with one shared string in cell A1. */
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

/** Minimal valid multi-sheet .xlsx: one shared-strings table, N worksheets. */
async function buildMultiSheetXlsx(sheets: string[][]): Promise<ArrayBuffer> {
  const zip = new JSZip();
  const sst = sheets
    .flat()
    .map((c) => `<si><t>${c}</t></si>`)
    .join("");
  zip.file(
    "xl/sharedStrings.xml",
    `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sst}</sst>`,
  );
  let stringIndex = 0;
  sheets.forEach((cells, sheetIdx) => {
    const row = cells
      .map((_, colIdx) => `<c r="${colIdx}1" t="s"><v>${stringIndex++}</v></c>`)
      .join("");
    zip.file(
      `xl/worksheets/sheet${sheetIdx + 1}.xml`,
      `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row>${row}</row></sheetData></worksheet>`,
    );
  });
  return zip.generateAsync({ type: "arraybuffer" });
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
            makeDriveFile("file-3", "archive.zip", {
              mimeType: "application/zip",
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

      // The unsupported files are reported as skipped (not silently dropped) so
      // the run can surface "N found, M imported, K unsupported".
      expect(batches[0].skipped).toHaveLength(2);
      expect(batches[0].skipped?.map((s) => s.name).sort()).toEqual([
        "archive.zip",
        "video.mp4",
      ]);
      expect(
        batches[0].skipped?.every((s) => s.reason === "unsupported_file_type"),
      ).toBe(true);
    });

    it("skips a Google-native type with no export mapping instead of downloading it", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      // A Google Form whose NAME looks like a text file: extension matching
      // must not route it to the raw download path — alt=media always 403s
      // (fileNotDownloadable) for Docs-Editors files, which counted as an
      // item error on every pass.
      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [
            makeDriveFile("form-1", "survey.txt", {
              mimeType: "application/vnd.google-apps.form",
            }),
          ],
          nextPageToken: undefined,
        },
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(0);
      expect(batches[0].skipped?.map((s) => s.name)).toEqual(["survey.txt"]);
      expect(mockFilesGet).not.toHaveBeenCalled();
      expect(mockFilesExport).not.toHaveBeenCalled();
    });

    it("recognizes supported files by mimeType when the name has no extension", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      // A real .docx whose name carries no extension — Drive still reports the
      // OOXML mimeType. The old extension-only check skipped this; it must not.
      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [
            makeDriveFile("file-1", "Signed Contract", {
              mimeType:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            }),
          ],
          nextPageToken: undefined,
        },
      });
      mockFilesGet.mockResolvedValueOnce({
        data: await buildDocx("Extensionless contract body"),
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
      expect(batches[0].documents[0].title).toBe("Signed Contract");
      expect(batches[0].documents[0].content).toContain(
        "Extensionless contract body",
      );
    });

    it("syncs .xlsx spreadsheets", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [
            makeDriveFile("file-1", "budget.xlsx", {
              mimeType:
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            }),
          ],
          nextPageToken: undefined,
        },
      });
      mockFilesGet.mockResolvedValueOnce({
        data: await buildXlsx(["Revenue", "Q1 2024"]),
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
      expect(batches[0].documents[0].content).toContain("Revenue");
      expect(batches[0].documents[0].content).toContain("Q1 2024");
    });

    it("exports Google Sheets as .xlsx so every sheet is ingested, not just the first", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [
            makeDriveFile("gsheet-1", "Quarterly Report", {
              mimeType: "application/vnd.google-apps.spreadsheet",
            }),
          ],
          nextPageToken: undefined,
        },
      });
      // Two sheets: a text/csv export would return only the first.
      mockFilesExport.mockResolvedValueOnce({
        data: await buildMultiSheetXlsx([
          ["Sheet One Revenue"],
          ["Sheet Two Expenses"],
        ]),
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Exported as .xlsx bytes, not text/csv (which Google truncates to sheet 1).
      expect(mockFilesExport).toHaveBeenCalledWith(
        expect.objectContaining({
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
        expect.objectContaining({ responseType: "arraybuffer" }),
      );
      // Content from BOTH sheets is present.
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].content).toContain("Sheet One Revenue");
      expect(batches[0].documents[0].content).toContain("Sheet Two Expenses");
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

      // Empty content file should be skipped — and reported as skipped with
      // the no-text category rather than silently dropped.
      expect(batches[0].documents).toHaveLength(0);
      expect(batches[0].skipped).toHaveLength(1);
      expect(batches[0].skipped?.[0].name).toBe("empty.txt");
      expect(batches[0].skipped?.[0].category).toBe("no_extractable_text");
    });

    it("reports a scanned PDF with no text layer as a categorized skip naming the file", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      mockFilesList.mockResolvedValueOnce({
        data: {
          files: [
            makeDriveFile("file-scan", "scanned-contract.pdf", {
              mimeType: "application/pdf",
            }),
          ],
          nextPageToken: undefined,
        },
      });

      mockFilesGet.mockResolvedValueOnce({
        data: Buffer.from("%PDF-1.4 scanned bytes").buffer,
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(0);
      expect(batches[0].skipped).toHaveLength(1);
      const skip = batches[0].skipped?.[0];
      expect(skip?.name).toBe("scanned-contract.pdf");
      expect(skip?.category).toBe("no_extractable_text");
      expect(skip?.reason).toContain("no extractable text layer");
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
  describe("auth modes", () => {
    it("keeps inferring from the credential when no mode was ever chosen", async () => {
      // A connector created before auth modes existed: a bare token still
      // authenticates as a bare token, so upgrading changes nothing for it.
      resetMocks();
      const connector = new GoogleDriveConnector();
      mockAboutGet.mockResolvedValueOnce({
        data: { user: { emailAddress: "legacy@example.com" } },
      });

      const result = await connector.testConnection({
        config: {},
        credentials,
      });

      expect(result.success).toBe(true);
      expect(impersonatedSubjects).toEqual([]);
      expect(oauthClients.at(-1)?.credentials).toEqual({
        access_token: "test-access-token",
      });
    });

    it("impersonates the delegated admin in the Workspace mode", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();
      mockAboutGet.mockResolvedValueOnce({
        data: { user: { emailAddress: "admin@example.com" } },
      });
      mockDirectoryUsersList.mockResolvedValueOnce({ data: { users: [] } });

      const result = await connector.testConnection({
        config: {
          authMode: "service_account_delegated",
          delegatedAdminEmail: "admin@example.com",
        },
        credentials: serviceAccountCredentials,
      });

      expect(result.success).toBe(true);
      expect(impersonatedSubjects).toContain("admin@example.com");
    });

    it("refuses the Workspace mode without an admin to impersonate", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      const result = await connector.testConnection({
        config: { authMode: "service_account_delegated" },
        credentials: serviceAccountCredentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("delegated admin email");
    });

    it("refuses a service-account mode given something that is not a key", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      const result = await connector.testConnection({
        config: { authMode: "service_account" },
        credentials: { apiToken: "ya29.a-bare-access-token" },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("service account JSON key");
    });

    it("says to connect an account when OAuth has no refresh token yet", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();

      const result = await connector.testConnection({
        config: { authMode: "oauth" },
        credentials: {
          apiToken: "",
          googleOAuth: { clientId: "client-1", clientSecret: "secret-1" },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Connect Google account");
      // Nothing was attempted against Google — there is nothing to attempt with.
      expect(mockAboutGet).not.toHaveBeenCalled();
    });

    it("hands the refresh token, not an access token, to the OAuth client", async () => {
      // The old connector set a bare access_token, which stopped working an
      // hour later with no way to renew it.
      resetMocks();
      const connector = new GoogleDriveConnector();
      mockAboutGet.mockResolvedValueOnce({
        data: { user: { emailAddress: "person@example.com" } },
      });

      const result = await connector.testConnection({
        config: { authMode: "oauth" },
        credentials: {
          apiToken: "",
          googleOAuth: {
            clientId: "client-1",
            clientSecret: "secret-1",
            refreshToken: "refresh-1",
          },
        },
      });

      expect(result.success).toBe(true);
      expect(oauthClients.at(-1)).toMatchObject({
        clientId: "client-1",
        credentials: { refresh_token: "refresh-1" },
      });
    });
  });

  describe("testConnection — validating the configured scope", () => {
    it("fails when the configured folder is not visible to the identity", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();
      mockAboutGet.mockResolvedValueOnce({
        data: {
          user: { emailAddress: "indexer@example.iam.gserviceaccount.com" },
        },
      });
      mockFilesGet.mockRejectedValueOnce(new Error("File not found: folder-1"));

      const result = await connector.testConnection({
        config: { authMode: "service_account", folderId: "folder-1" },
        credentials: serviceAccountCredentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("folder-1");
      expect(result.error).toContain("not visible");
    });

    it("fails when a configured shared drive is not visible to the identity", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();
      mockAboutGet.mockResolvedValueOnce({
        data: {
          user: { emailAddress: "indexer@example.iam.gserviceaccount.com" },
        },
      });
      mockDrivesGet.mockRejectedValueOnce(new Error("notFound"));

      const result = await connector.testConnection({
        config: { authMode: "service_account", driveIds: ["drive-9"] },
        credentials: serviceAccountCredentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("drive-9");
    });

    it("explains an unauthorized delegation instead of echoing the OAuth code", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();
      mockAboutGet.mockRejectedValueOnce(
        new Error(
          "unauthorized_client: Client is unauthorized to retrieve access tokens",
        ),
      );

      const result = await connector.testConnection({
        config: {
          authMode: "service_account_delegated",
          delegatedAdminEmail: "admin@example.com",
        },
        credentials: serviceAccountCredentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Domain-wide delegation");
      expect(result.error).toContain("admin@example.com");
    });

    it("explains a key whose line breaks were flattened", async () => {
      // OpenSSL rejects it before any request goes out, and its own wording
      // ("DECODER routines::unsupported") names nothing an admin can act on.
      resetMocks();
      const connector = new GoogleDriveConnector();
      mockAboutGet.mockRejectedValueOnce(
        new Error("error:1E08010C:DECODER routines::unsupported"),
      );

      const result = await connector.testConnection({
        config: { authMode: "service_account" },
        credentials: serviceAccountCredentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("exactly as Google downloaded it");
    });

    it("separates a directory failure from a sign-in failure", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();
      mockAboutGet.mockResolvedValueOnce({
        data: { user: { emailAddress: "admin@example.com" } },
      });
      mockDirectoryUsersList.mockRejectedValueOnce(new Error("Not Authorized"));

      const result = await connector.testConnection({
        config: {
          authMode: "service_account_delegated",
          delegatedAdminEmail: "admin@example.com",
        },
        credentials: serviceAccountCredentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Signed in");
      expect(result.error).toContain("directory");
    });

    it("does not read the directory when a folder scopes the delegated sync", async () => {
      // Naming a folder is a statement of scope; the pass acts as the admin
      // alone, so directory access is not needed and must not be demanded.
      resetMocks();
      const connector = new GoogleDriveConnector();
      mockAboutGet.mockResolvedValueOnce({
        data: { user: { emailAddress: "admin@example.com" } },
      });
      mockFilesGet.mockResolvedValueOnce({ data: { id: "folder-1" } });

      const result = await connector.testConnection({
        config: {
          authMode: "service_account_delegated",
          delegatedAdminEmail: "admin@example.com",
          folderId: "folder-1",
        },
        credentials: serviceAccountCredentials,
      });

      expect(result.success).toBe(true);
      expect(mockDirectoryUsersList).not.toHaveBeenCalled();
    });
  });

  describe("sync — domain-wide delegation", () => {
    const domainConfig = {
      authMode: "service_account_delegated",
      delegatedAdminEmail: "admin@example.com",
    };

    function drainDomainSync(
      checkpoint: Record<string, unknown> | null = null,
    ) {
      const connector = new GoogleDriveConnector();
      return (async () => {
        const batches: ConnectorSyncBatch[] = [];
        for await (const batch of connector.sync({
          config: domainConfig,
          credentials: serviceAccountCredentials,
          checkpoint,
        })) {
          batches.push(batch);
        }
        return batches;
      })();
    }

    it("walks every shared drive and impersonates every active user", async () => {
      resetMocks();
      mockDrivesList.mockResolvedValueOnce({
        data: { drives: [{ id: "shared-1", name: "Engineering" }] },
      });
      mockDrivesGet.mockResolvedValue({ data: { id: "shared-1" } });
      mockDirectoryUsersList.mockResolvedValueOnce({
        data: {
          users: [
            { primaryEmail: "ada@example.com" },
            { primaryEmail: "grace@example.com" },
            { primaryEmail: "gone@example.com", suspended: true },
            { primaryEmail: "archived@example.com", archived: true },
          ],
        },
      });

      // shared-1, then ada, then grace
      mockFilesList
        .mockResolvedValueOnce({
          data: { files: [makeDriveFile("f-shared", "spec.md")] },
        })
        .mockResolvedValueOnce({
          data: { files: [makeDriveFile("f-ada", "notes.txt")] },
        })
        .mockResolvedValueOnce({ data: { files: [] } });
      mockFilesGet
        .mockResolvedValueOnce({
          data: Buffer.from("shared drive file").buffer,
        })
        .mockResolvedValueOnce({ data: Buffer.from("ada's file").buffer });

      const batches = await drainDomainSync();
      const documents = batches.flatMap((b) => b.documents);

      expect(documents.map((d) => d.title)).toEqual(["spec.md", "notes.txt"]);
      // The admin opens the shared drive; each active user is impersonated in
      // turn. Suspended and archived accounts cannot be, so they are not tried.
      expect(impersonatedSubjects).toContain("ada@example.com");
      expect(impersonatedSubjects).toContain("grace@example.com");
      expect(impersonatedSubjects).not.toContain("gone@example.com");
      expect(impersonatedSubjects).not.toContain("archived@example.com");
    });

    it("indexes a file shared between two people only once", async () => {
      resetMocks();
      mockDrivesList.mockResolvedValueOnce({ data: { drives: [] } });
      mockDirectoryUsersList.mockResolvedValueOnce({
        data: {
          users: [
            { primaryEmail: "ada@example.com" },
            { primaryEmail: "grace@example.com" },
          ],
        },
      });

      const shared = makeDriveFile("f-shared", "handbook.md");
      mockFilesList
        .mockResolvedValueOnce({ data: { files: [shared] } })
        .mockResolvedValueOnce({ data: { files: [shared] } });
      mockFilesGet.mockResolvedValueOnce({
        data: Buffer.from("the handbook").buffer,
      });

      const batches = await drainDomainSync();
      const documents = batches.flatMap((b) => b.documents);

      expect(documents).toHaveLength(1);
      // Downloaded once, not once per viewer.
      expect(mockFilesGet).toHaveBeenCalledTimes(1);
    });

    it("retries a file through another viewer when the first download failed", async () => {
      // Claiming the id at listing time would write the file off for everyone
      // else the moment one identity's download failed.
      resetMocks();
      mockDrivesList.mockResolvedValue({ data: { drives: [] } });
      mockDirectoryUsersList.mockResolvedValue({
        data: {
          users: [
            { primaryEmail: "ada@example.com" },
            { primaryEmail: "grace@example.com" },
          ],
        },
      });

      const shared = makeDriveFile("f-shared", "handbook.md");
      mockFilesList.mockResolvedValue({ data: { files: [shared] } });
      mockFilesGet
        .mockRejectedValueOnce(new Error("403 cannotDownloadFile"))
        .mockResolvedValueOnce({ data: Buffer.from("the handbook").buffer });

      const batches = await drainDomainSync();

      expect(batches.flatMap((b) => b.documents)).toHaveLength(1);
      expect(mockFilesGet).toHaveBeenCalledTimes(2);
    });

    it("impersonates a member when the admin cannot open a shared drive", async () => {
      resetMocks();
      mockDrivesList.mockResolvedValueOnce({
        data: { drives: [{ id: "shared-1" }] },
      });
      mockDrivesGet
        .mockRejectedValueOnce(new Error("notFound"))
        .mockResolvedValueOnce({ data: { id: "shared-1" } });
      mockPermissionsList.mockResolvedValueOnce({
        data: {
          permissions: [
            {
              type: "group",
              role: "organizer",
              emailAddress: "team@example.com",
            },
            {
              type: "user",
              role: "organizer",
              emailAddress: "owner@example.com",
            },
          ],
        },
      });
      mockDirectoryUsersList.mockResolvedValueOnce({ data: { users: [] } });
      mockFilesList.mockResolvedValueOnce({
        data: { files: [makeDriveFile("f-1", "design.md")] },
      });
      mockFilesGet.mockResolvedValueOnce({
        data: Buffer.from("design doc").buffer,
      });

      const batches = await drainDomainSync();

      expect(batches.flatMap((b) => b.documents)).toHaveLength(1);
      expect(impersonatedSubjects).toContain("owner@example.com");
    });

    it("records a shared drive nobody can open instead of dropping it", async () => {
      resetMocks();
      mockDrivesList.mockResolvedValueOnce({
        data: { drives: [{ id: "orphan-drive" }] },
      });
      mockDrivesGet.mockRejectedValue(new Error("notFound"));
      mockPermissionsList.mockResolvedValueOnce({ data: { permissions: [] } });
      mockDirectoryUsersList.mockResolvedValueOnce({ data: { users: [] } });

      const batches = await drainDomainSync();
      const skipped = batches.flatMap((b) => b.skipped ?? []);

      expect(skipped.map((s) => s.itemId)).toContain("orphan-drive");
      // Not silently written off: the next pass crawls it in full.
      const final = batches.at(-1)?.checkpoint as Record<string, unknown>;
      expect(final.domainFullCrawlTargets).toEqual(["drive:orphan-drive"]);
    });

    it("resumes where an interrupted pass stopped", async () => {
      resetMocks();
      mockDrivesList.mockResolvedValue({ data: { drives: [] } });
      mockDirectoryUsersList.mockResolvedValue({
        data: {
          users: [
            { primaryEmail: "ada@example.com" },
            { primaryEmail: "grace@example.com" },
          ],
        },
      });
      mockFilesList.mockResolvedValue({ data: { files: [] } });

      // Stop after the first batch, the way a run out of its time budget does.
      let interrupted: ConnectorSyncBatch | undefined;
      for await (const batch of new GoogleDriveConnector().sync({
        config: domainConfig,
        credentials: serviceAccountCredentials,
        checkpoint: null,
      })) {
        interrupted = batch;
        break;
      }

      const resumeFrom = interrupted?.checkpoint as Record<string, unknown>;
      expect(resumeFrom.domainTargetsCompleted).toBe(1);
      expect(resumeFrom.domainTargetsFingerprint).toEqual(expect.any(String));

      impersonatedSubjects.length = 0;
      for await (const _batch of new GoogleDriveConnector().sync({
        config: domainConfig,
        credentials: serviceAccountCredentials,
        checkpoint: resumeFrom,
      })) {
        // drain
      }

      expect(impersonatedSubjects).not.toContain("ada@example.com");
      expect(impersonatedSubjects).toContain("grace@example.com");
    });

    it("starts over when the domain's membership changed under a resume", async () => {
      // The checkpoint counts targets, so a count taken against a different
      // roster would skip identities this pass never actually visited.
      resetMocks();
      mockDrivesList.mockResolvedValue({ data: { drives: [] } });
      mockDirectoryUsersList.mockResolvedValue({
        data: { users: [{ primaryEmail: "ada@example.com" }] },
      });
      mockFilesList.mockResolvedValue({ data: { files: [] } });

      await drainDomainSync({
        type: "gdrive",
        domainTargetsCompleted: 1,
        domainTargetsFingerprint: "a-roster-that-no-longer-matches",
        domainSyncStartedAt: "2026-01-01T00:00:00.000Z",
      });

      expect(impersonatedSubjects).toContain("ada@example.com");
    });

    it("keeps going when one identity cannot be read, and carries it forward", async () => {
      // An account with no Drive licence is ordinary in a real domain. Failing
      // the run on it would strand every user sorted after it, forever.
      resetMocks();
      mockDrivesList.mockResolvedValue({ data: { drives: [] } });
      mockDirectoryUsersList.mockResolvedValue({
        data: {
          users: [
            { primaryEmail: "ada@example.com" },
            { primaryEmail: "grace@example.com" },
          ],
        },
      });
      mockFilesList
        .mockRejectedValueOnce(new Error("User does not have Drive enabled"))
        .mockResolvedValue({
          data: { files: [makeDriveFile("f-grace", "notes.txt")] },
        });
      mockFilesGet.mockResolvedValue({ data: Buffer.from("grace").buffer });

      const batches = await drainDomainSync();

      // grace still synced despite ada failing first.
      expect(batches.flatMap((b) => b.documents).map((d) => d.title)).toEqual([
        "notes.txt",
      ]);
      expect(
        batches.flatMap((b) => b.skipped ?? []).map((s) => s.itemId),
      ).toContain("ada@example.com");

      // The cursor still advances, but ada is queued for a full crawl next
      // pass — an incremental query would never revisit what it missed.
      const final = batches.at(-1)?.checkpoint as Record<string, unknown>;
      expect(final.lastSyncedAt).toEqual(expect.any(String));
      expect(final.domainFullCrawlTargets).toEqual(["user:ada@example.com"]);
    });

    it("crawls a carried-over target in full rather than incrementally", async () => {
      resetMocks();
      mockDrivesList.mockResolvedValue({ data: { drives: [] } });
      mockDirectoryUsersList.mockResolvedValue({
        data: { users: [{ primaryEmail: "ada@example.com" }] },
      });
      mockFilesList.mockResolvedValue({ data: { files: [] } });

      await drainDomainSync({
        type: "gdrive",
        lastSyncedAt: "2026-06-01T00:00:00.000Z",
        domainFullCrawlTargets: ["user:ada@example.com"],
      });

      // No modifiedTime floor on the query for the carried-over identity.
      const query = mockFilesList.mock.calls[0]?.[0]?.q as string;
      expect(query).not.toContain("modifiedTime");
    });

    it("only advances the cursor once the whole pass is done", async () => {
      resetMocks();
      mockDrivesList.mockResolvedValueOnce({ data: { drives: [] } });
      mockDirectoryUsersList.mockResolvedValueOnce({
        data: { users: [{ primaryEmail: "ada@example.com" }] },
      });
      mockFilesList.mockResolvedValueOnce({
        data: { files: [makeDriveFile("f-1", "a.txt")] },
      });
      mockFilesGet.mockResolvedValueOnce({ data: Buffer.from("a").buffer });

      const batches = await drainDomainSync({
        type: "gdrive",
        lastSyncedAt: "2026-01-01T00:00:00.000Z",
      });

      // Mid-pass the cursor is untouched, so a run that dies partway cannot
      // skip the users it never reached.
      const midPass = batches[0].checkpoint as Record<string, unknown>;
      expect(midPass.lastSyncedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(midPass.domainSyncStartedAt).toBeTruthy();

      // The closing batch advances it and clears the per-target progress.
      const final = batches.at(-1)?.checkpoint as Record<string, unknown>;
      expect(final.lastSyncedAt).not.toBe("2026-01-01T00:00:00.000Z");
      expect(final.domainTargetsCompleted).toBeUndefined();
      expect(batches.at(-1)?.hasMore).toBe(false);
    });

    it("acts as the admin alone when a folder scopes the sync", async () => {
      resetMocks();
      const connector = new GoogleDriveConnector();
      // Folder mode lists subfolders as well as files; neither has anything.
      mockFilesList.mockResolvedValue({ data: { files: [] } });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...domainConfig, folderId: "folder-1" },
        credentials: serviceAccountCredentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(mockDirectoryUsersList).not.toHaveBeenCalled();
      expect(mockDrivesList).not.toHaveBeenCalled();
      expect(impersonatedSubjects).toEqual(["admin@example.com"]);
    });
  });
  describe("permission sync", () => {
    const permConfig = {
      authMode: "oauth",
      connectedAccountEmail: "owner@example.com",
    };
    const oauthCreds = {
      apiToken: "",
      googleOAuth: {
        clientId: "c",
        clientSecret: "s",
        refreshToken: "r",
      },
    };

    async function snapshot(files: unknown[], config = permConfig) {
      resetMocks();
      mockFilesList.mockResolvedValueOnce({ data: { files } });
      const connector = new GoogleDriveConnector();
      const out = [];
      for await (const y of connector.syncPermissionSnapshot({
        config,
        credentials: oauthCreds,
        cursor: null,
        readIngestedDocuments: (async function* () {})() as never,
      } as never)) {
        out.push(y);
      }
      return out;
    }

    it("reads each file's audience from the listing, without extra requests", async () => {
      const out = await snapshot([
        {
          id: "f1",
          name: "plan.md",
          permissions: [
            { type: "user", role: "owner", emailAddress: "Owner@example.com" },
            {
              type: "user",
              role: "reader",
              emailAddress: "reader@example.com",
            },
          ],
        },
      ]);

      expect(out).toEqual([
        {
          kind: "container",
          containerKey: "file:f1",
          permissions: { users: ["owner@example.com", "reader@example.com"] },
          cursor: "file:f1",
        },
        {
          kind: "document",
          sourceId: "f1",
          containerKey: "file:f1",
          cursor: "file:f1",
        },
      ]);
      // The audience rode along with the listing — no per-file lookup.
      expect(mockFilesGet).not.toHaveBeenCalled();
      expect(mockPermissionsList).not.toHaveBeenCalled();
      expect(mockFilesList).toHaveBeenCalledTimes(1);
    });

    it("keeps group grants as groups, for the group pass to expand", async () => {
      const out = await snapshot([
        {
          id: "f2",
          permissions: [
            { type: "group", role: "reader", emailAddress: "eng@example.com" },
          ],
        },
      ]);
      expect(out[0]).toMatchObject({
        permissions: { groups: ["eng@example.com"] },
      });
    });

    it("treats a public link as everyone", async () => {
      const out = await snapshot([
        { id: "f3", permissions: [{ type: "anyone", role: "reader" }] },
      ]);
      expect(out[0]).toMatchObject({ permissions: { isPublic: true } });
    });

    it("treats a grant to our own domain as everyone here", async () => {
      const out = await snapshot([
        {
          id: "f4",
          permissions: [
            { type: "domain", role: "reader", domain: "Example.com" },
          ],
        },
      ]);
      expect(out[0]).toMatchObject({ permissions: { isPublic: true } });
    });

    it("does not widen a partner domain's grant into everyone here", async () => {
      // A share with another company names people this deployment cannot
      // enumerate. Widening it to org:* would hand them to our own users.
      const out = await snapshot([
        {
          id: "f5",
          permissions: [
            { type: "domain", role: "reader", domain: "partner.example.net" },
          ],
        },
      ]);
      expect(out[0]).toMatchObject({ permissions: {} });
      expect(out[0]).not.toMatchObject({ permissions: { isPublic: true } });
    });

    it("ignores a revoked permission", async () => {
      const out = await snapshot([
        {
          id: "f6",
          permissions: [
            { type: "user", emailAddress: "gone@example.com", deleted: true },
            { type: "user", emailAddress: "here@example.com" },
          ],
        },
      ]);
      expect(out[0]).toMatchObject({
        permissions: { users: ["here@example.com"] },
      });
    });

    it("flags an unreadable access list instead of calling it empty", async () => {
      // Drive omits `permissions` when the caller may read the file but not
      // its sharing. Empty and unknown must not look the same downstream.
      const out = await snapshot([{ id: "f7", name: "opaque.md" }]);
      expect(out[0]).toMatchObject({
        containerKey: "file:f7",
        permissions: {},
        audienceResolutionFailed: true,
      });
    });

    it("does not expand groups for an individually connected Drive", async () => {
      // Reading the directory needs delegation; guessing membership would
      // grant people this connector never confirmed.
      resetMocks();
      const connector = new GoogleDriveConnector();
      const out = [];
      for await (const g of connector.syncGroups({
        config: permConfig,
        credentials: oauthCreds,
        cursor: null,
        readIngestedDocuments: (async function* () {})() as never,
      } as never)) {
        out.push(g);
      }
      expect(out).toEqual([]);
      expect(mockDirectoryUsersList).not.toHaveBeenCalled();
    });
  });
});
