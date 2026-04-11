import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  GoogleDriveCheckpoint,
  GoogleDriveConfig,
} from "@/types";
import { GoogleDriveConfigSchema } from "@/types";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";

const GOOGLE_DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DEFAULT_BATCH_SIZE = 50;

export class GoogleDriveConnector extends BaseConnector {
  type = "googledrive" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const result = GoogleDriveConfigSchema.safeParse({ type: "googledrive", ...config });
    if (!result.success) {
      return { valid: false, error: "Invalid Google Drive configuration" };
    }
    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    this.log.debug("Testing Google Drive connection");

    try {
      const response = await this.fetchWithRetry(
        `${GOOGLE_DRIVE_API_BASE}/about?fields=user`,
        { headers: buildHeaders(params.credentials) },
      );

      if (!response.ok) {
        const body = await response.text();
        return {
          success: false,
          error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
        };
      }

      this.log.debug("Google Drive connection test successful");
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "Google Drive connection test failed");
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async *sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parseGoogleDriveConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Google Drive configuration");
    }

    const checkpoint = (params.checkpoint as GoogleDriveCheckpoint | null) ?? {
      type: "googledrive" as const,
    };

    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const syncFrom = checkpoint.lastSyncedAt ?? params.startTime?.toISOString();

    this.log.debug(
      { driveId: parsed.driveId, syncFrom },
      "Starting Google Drive sync",
    );

    let pageToken: string | undefined;
    let hasMore = true;

    while (hasMore) {
      await this.rateLimit();

      const query = buildDriveQuery({
        driveId: parsed.driveId,
        syncFrom,
        fileTypes: parsed.fileTypes,
      });

      const url = new URL(`${GOOGLE_DRIVE_API_BASE}/files`);
      url.searchParams.append("q", query);
      url.searchParams.append("pageSize", batchSize.toString());
      url.searchParams.append("fields", "nextPageToken, files(id, name, mimeType, webViewLink, modifiedTime, createdTime)");
      if (pageToken) {
        url.searchParams.append("pageToken", pageToken);
      }
      if (parsed.driveId) {
        url.searchParams.append("supportsAllDrives", "true");
        url.searchParams.append("includeItemsFromAllDrives", "true");
        url.searchParams.append("corpora", "drive");
        url.searchParams.append("driveId", parsed.driveId);
      }

      const response = await this.fetchWithRetry(url.toString(), {
        headers: buildHeaders(params.credentials),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Google Drive API failed: HTTP ${response.status}: ${body.slice(0, 200)}`);
      }

      const result = await response.json();
      const files = result.files ?? [];
      const documents: ConnectorDocument[] = [];

      for (const file of files) {
        const doc = await this.safeItemFetch({
          fetch: async () => {
            const content = await this.fetchFileContent(file, params.credentials);
            return fileToDocument(file, content);
          },
          fallback: null,
          itemId: file.id,
          resource: "file",
        });
        if (doc) documents.push(doc);
      }

      pageToken = result.nextPageToken;
      hasMore = !!pageToken;

      const lastFile = files[files.length - 1];
      const lastModifiedAt = lastFile?.modifiedTime;

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "googledrive",
          itemUpdatedAt: lastModifiedAt,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore,
      };
    }
  }

  private async fetchFileContent(
    file: { id: string; name: string; mimeType: string },
    credentials: ConnectorCredentials,
  ): Promise<string> {
    // If it's a Google Doc, export it as text
    if (file.mimeType === "application/vnd.google-apps.document") {
      const exportUrl = `${GOOGLE_DRIVE_API_BASE}/files/${file.id}/export?mimeType=text/plain`;
      const response = await this.fetchWithRetry(exportUrl, {
        headers: buildHeaders(credentials),
      });
      if (!response.ok) return "";
      return await response.text();
    }

    // For supported text formats, download directly
    const textMimeTypes = ["text/plain", "text/markdown", "text/x-markdown"];
    if (textMimeTypes.includes(file.mimeType)) {
      const downloadUrl = `${GOOGLE_DRIVE_API_BASE}/files/${file.id}?alt=media`;
      const response = await this.fetchWithRetry(downloadUrl, {
        headers: buildHeaders(credentials),
      });
      if (!response.ok) return "";
      return await response.text();
    }

    // TODO: Add support for PDF/Docx extraction if needed via separate utility
    return "";
  }
}

function buildHeaders(credentials: ConnectorCredentials) {
  return {
    Authorization: `Bearer ${credentials.apiToken}`,
    "Content-Type": "application/json",
  };
}

function parseGoogleDriveConfig(config: Record<string, unknown>): GoogleDriveConfig | null {
  const result = GoogleDriveConfigSchema.safeParse({ type: "googledrive", ...config });
  return result.success ? result.data : null;
}

function buildDriveQuery(params: {
  driveId?: string;
  syncFrom?: string;
  fileTypes?: string[];
}): string {
  let query = "trashed = false";

  if (params.syncFrom) {
    query += ` and modifiedTime > '${params.syncFrom}'`;
  }

  const supportedMimeTypes = [
    "application/vnd.google-apps.document",
    "text/plain",
    "text/markdown",
  ];
  
  if (params.fileTypes && params.fileTypes.length > 0) {
    const mimeQuery = params.fileTypes
      .map(t => `mimeType = '${t}'`)
      .join(" or ");
    query += ` and (${mimeQuery})`;
  } else {
    const mimeQuery = supportedMimeTypes
      .map(t => `mimeType = '${t}'`)
      .join(" or ");
    query += ` and (${mimeQuery})`;
  }

  return query;
}

function fileToDocument(file: any, content: string): ConnectorDocument {
  return {
    id: file.id,
    title: file.name,
    content: content || `# ${file.name}`,
    sourceUrl: file.webViewLink,
    metadata: {
      googleDriveFileId: file.id,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime,
      createdTime: file.createdTime,
    },
    updatedAt: new Date(file.modifiedTime),
  };
}
