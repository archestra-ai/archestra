import { describe, expect, it, vi } from "vitest";
import type { ConnectorCredentials, ConnectorSyncBatch } from "@/types";
import { GoogleDriveConnector } from "./google-drive-connector";

// Raw access token credentials (simplest auth mode)
const TOKEN_CREDENTIALS: ConnectorCredentials = {
  apiToken: "ya29.test-access-token",
};

// Service account JSON credentials
const SA_CREDENTIALS: ConnectorCredentials = {
  apiToken: JSON.stringify({
    type: "service_account",
    client_email: "test@test-project.iam.gserviceaccount.com",
    private_key:
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4...fake...key=\n-----END RSA PRIVATE KEY-----\n",
    token_uri: "https://oauth2.googleapis.com/token",
  }),
};

// Helper: build a mock Google Drive file object
function makeFile(
  id: string,
  name: string,
  mimeType: string,
  opts?: { modifiedTime?: string; webViewLink?: string },
): {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  createdTime: string;
} {
  return {
    id,
    name,
    mimeType,
    modifiedTime: opts?.modifiedTime ?? "2024-01-15T10:00:00.000Z",
    webViewLink:
      opts?.webViewLink ?? `https://drive.google.com/file/d/${id}/view`,
    createdTime: "2024-01-01T00:00:00.000Z",
  };
}

// Helper: build a mock files list response
function makeFilesListResponse(
  files: ReturnType<typeof makeFile>[],
  opts?: { nextPageToken?: string },
): Response {
  return {
    ok: true,
    json: async () => ({
      files,
      nextPageToken: opts?.nextPageToken,
    }),
  } as unknown as Response;
}

// Helper: build a mock text content response
function makeTextResponse(content: string): Response {
  return {
    ok: true,
    text: async () => content,
  } as unknown as Response;
}

// Helper: build a mock error response
function makeErrorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    text: async () => body,
  } as unknown as Response;
}

describe("GoogleDriveConnector", () => {
  describe("validateConfig", () => {
    it("accepts a minimal config with no optional fields", async () => {
      const connector = new GoogleDriveConnector();
      const result = await connector.validateConfig({ type: "googledrive" });
      expect(result.valid).toBe(true);
    });

    it("accepts a config with driveId and folderId", async () => {
      const connector = new GoogleDriveConnector();
      const result = await connector.validateConfig({
        type: "googledrive",
        driveId: "0AFxxx",
        folderId: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts a config with mimeTypes array", async () => {
      const connector = new GoogleDriveConnector();
      const result = await connector.validateConfig({
        type: "googledrive",
        mimeTypes: [
          "application/vnd.google-apps.document",
          "text/plain",
        ],
      });
      expect(result.valid).toBe(true);
    });

    it("rejects a config with wrong type", async () => {
      const connector = new GoogleDriveConnector();
      const result = await connector.validateConfig({ type: "github" });
      expect(result.valid).toBe(false);
    });
  });

  describe("testConnection", () => {
    it("returns success on a valid API response", async () => {
      const connector = new GoogleDriveConnector();
      vi.spyOn(connector as any, "fetchWithRetry").mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [] }),
      } as unknown as Response);

      const result = await connector.testConnection({
        config: { type: "googledrive" },
        credentials: TOKEN_CREDENTIALS,
      });
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("returns failure on a 401 response", async () => {
      const connector = new GoogleDriveConnector();
      vi.spyOn(connector as any, "fetchWithRetry").mockResolvedValueOnce(
        makeErrorResponse(401, '{"error":"unauthorized"}'),
      );

      const result = await connector.testConnection({
        config: { type: "googledrive" },
        credentials: TOKEN_CREDENTIALS,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("401");
    });

    it("returns failure when the fetch throws", async () => {
      const connector = new GoogleDriveConnector();
      vi.spyOn(connector as any, "fetchWithRetry").mockRejectedValueOnce(
        new Error("network timeout"),
      );

      const result = await connector.testConnection({
        config: { type: "googledrive" },
        credentials: TOKEN_CREDENTIALS,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("network timeout");
    });
  });

  describe("sync", () => {
    it("yields no documents when the drive has no matching files", async () => {
      const connector = new GoogleDriveConnector();
      vi.spyOn(connector as any, "fetchWithRetry").mockResolvedValueOnce(
        makeFilesListResponse([]),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { type: "googledrive" },
        credentials: TOKEN_CREDENTIALS,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(0);
      expect(batches[0].hasMore).toBe(false);
    });

    it("yields a document for a Google Doc file", async () => {
      const connector = new GoogleDriveConnector();
      const file = makeFile(
        "doc-id-1",
        "My Document",
        "application/vnd.google-apps.document",
      );

      // First call: files list; second call: export content
      vi.spyOn(connector as any, "fetchWithRetry")
        .mockResolvedValueOnce(makeFilesListResponse([file]))
        .mockResolvedValueOnce(makeTextResponse("Hello from Google Docs!"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { type: "googledrive" },
        credentials: TOKEN_CREDENTIALS,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      const doc = batches[0].documents[0];
      expect(doc.id).toBe("doc-id-1");
      expect(doc.title).toBe("My Document");
      expect(doc.content).toContain("Hello from Google Docs!");
      expect(doc.sourceUrl).toContain("drive.google.com");
    });

    it("yields a document for a plain text file", async () => {
      const connector = new GoogleDriveConnector();
      const file = makeFile("txt-id-1", "notes.txt", "text/plain");

      vi.spyOn(connector as any, "fetchWithRetry")
        .mockResolvedValueOnce(makeFilesListResponse([file]))
        .mockResolvedValueOnce(makeTextResponse("These are my notes."));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { type: "googledrive" },
        credentials: TOKEN_CREDENTIALS,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].content).toContain("These are my notes.");
    });

    it("skips unsupported file types silently", async () => {
      const connector = new GoogleDriveConnector();
      const file = makeFile("img-id-1", "photo.jpg", "image/jpeg");

      vi.spyOn(connector as any, "fetchWithRetry").mockResolvedValueOnce(
        makeFilesListResponse([file]),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { type: "googledrive" },
        credentials: TOKEN_CREDENTIALS,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Image is skipped — no documents, no failures
      expect(batches[0].documents).toHaveLength(0);
      expect(batches[0].failures ?? []).toHaveLength(0);
    });

    it("follows pagination via nextPageToken", async () => {
      const connector = new GoogleDriveConnector();
      const file1 = makeFile(
        "doc-id-1",
        "Doc 1",
        "application/vnd.google-apps.document",
        { modifiedTime: "2024-01-01T00:00:00.000Z" },
      );
      const file2 = makeFile(
        "doc-id-2",
        "Doc 2",
        "application/vnd.google-apps.document",
        { modifiedTime: "2024-01-02T00:00:00.000Z" },
      );

      vi.spyOn(connector as any, "fetchWithRetry")
        // Page 1
        .mockResolvedValueOnce(
          makeFilesListResponse([file1], { nextPageToken: "page2token" }),
        )
        .mockResolvedValueOnce(makeTextResponse("Content of Doc 1"))
        // Page 2
        .mockResolvedValueOnce(makeFilesListResponse([file2]))
        .mockResolvedValueOnce(makeTextResponse("Content of Doc 2"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { type: "googledrive" },
        credentials: TOKEN_CREDENTIALS,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].hasMore).toBe(true);
      expect(batches[1].hasMore).toBe(false);
      expect(batches[0].documents[0].title).toBe("Doc 1");
      expect(batches[1].documents[0].title).toBe("Doc 2");
    });

    it("advances checkpoint using modifiedTime of last file", async () => {
      const connector = new GoogleDriveConnector();
      const file = makeFile("doc-id-1", "Doc 1", "text/plain", {
        modifiedTime: "2024-03-15T12:00:00.000Z",
      });

      vi.spyOn(connector as any, "fetchWithRetry")
        .mockResolvedValueOnce(makeFilesListResponse([file]))
        .mockResolvedValueOnce(makeTextResponse("content"));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { type: "googledrive" },
        credentials: TOKEN_CREDENTIALS,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].checkpoint.lastSyncedAt).toBe(
        "2024-03-15T12:00:00.000Z",
      );
    });

    it("includes folderId in the query when configured", async () => {
      const connector = new GoogleDriveConnector();
      let capturedUrl = "";
      vi.spyOn(connector as any, "fetchWithRetry").mockImplementationOnce(
        (url: string) => {
          capturedUrl = url;
          return Promise.resolve(makeFilesListResponse([]));
        },
      );

      for await (const _ of connector.sync({
        config: {
          type: "googledrive",
          folderId: "my-folder-id",
        },
        credentials: TOKEN_CREDENTIALS,
        checkpoint: null,
      })) {
        // drain
      }

      expect(capturedUrl).toContain("my-folder-id");
    });

    it("includes driveId in the URL when configured", async () => {
      const connector = new GoogleDriveConnector();
      let capturedUrl = "";
      vi.spyOn(connector as any, "fetchWithRetry").mockImplementationOnce(
        (url: string) => {
          capturedUrl = url;
          return Promise.resolve(makeFilesListResponse([]));
        },
      );

      for await (const _ of connector.sync({
        config: {
          type: "googledrive",
          driveId: "my-shared-drive-id",
        },
        credentials: TOKEN_CREDENTIALS,
        checkpoint: null,
      })) {
        // drain
      }

      expect(capturedUrl).toContain("my-shared-drive-id");
    });

    it("uses checkpoint syncFrom to filter files modified after the last sync", async () => {
      const connector = new GoogleDriveConnector();
      let capturedUrl = "";
      vi.spyOn(connector as any, "fetchWithRetry").mockImplementationOnce(
        (url: string) => {
          capturedUrl = url;
          return Promise.resolve(makeFilesListResponse([]));
        },
      );

      for await (const _ of connector.sync({
        config: { type: "googledrive" },
        credentials: TOKEN_CREDENTIALS,
        checkpoint: {
          type: "googledrive",
          lastSyncedAt: "2024-06-01T00:00:00.000Z",
        },
      })) {
        // drain
      }

      expect(capturedUrl).toContain("modifiedTime");
    });
  });
});
