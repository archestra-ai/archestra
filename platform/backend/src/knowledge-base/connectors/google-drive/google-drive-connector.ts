import { createSign } from "node:crypto";
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

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const DEFAULT_BATCH_SIZE = 50;
const MAX_CONTENT_LENGTH = 500_000; // 500 KB text limit
const INCREMENTAL_SAFETY_BUFFER_MS = 5 * 60 * 1000;

// MIME types for supported Google Docs formats (exported as plain text)
const GOOGLE_DOC_EXPORT_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

// Non-Google file MIME types we can ingest as-is
const SUPPORTED_DOWNLOAD_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/json",
]);

type ServiceAccountKey = {
  type: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  createdTime?: string;
  webViewLink?: string;
  size?: string;
  parents?: string[];
};

type DriveFilesListResponse = {
  files: DriveFile[];
  nextPageToken?: string;
};

export class GoogleDriveConnector extends BaseConnector {
  type = "googledrive" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseGoogleDriveConfig(config);
    if (!parsed) {
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
      const accessToken = await getAccessToken(params.credentials);

      // List the root files to verify auth works
      const response = await this.fetchWithRetry(
        `${DRIVE_API_BASE}/files?pageSize=1&fields=files(id,name)`,
        {
          headers: buildHeaders(accessToken),
        },
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
    const safetyBufferedSyncFrom = syncFrom
      ? subtractSafetyBuffer(syncFrom)
      : undefined;

    this.log.debug(
      {
        driveId: parsed.driveId,
        folderId: parsed.folderId,
        mimeTypes: parsed.mimeTypes,
        syncFrom,
      },
      "Starting Google Drive sync",
    );

    const accessToken = await getAccessToken(params.credentials);

    let pageToken: string | undefined;
    let batchIndex = 0;
    let hasMore = true;

    while (hasMore) {
      await this.rateLimit();

      try {
        this.log.debug({ batchIndex, pageToken }, "Fetching Drive files page");

        const query = buildQuery({
          folderId: parsed.folderId,
          mimeTypes: parsed.mimeTypes,
          modifiedAfter: safetyBufferedSyncFrom,
        });

        const listUrl = buildListUrl({
          query,
          pageSize: batchSize,
          pageToken,
          driveId: parsed.driveId,
        });

        const response = await this.fetchWithRetry(listUrl, {
          headers: buildHeaders(accessToken),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(
            `Google Drive files list failed: HTTP ${response.status}: ${body.slice(0, 200)}`,
          );
        }

        const result = (await response.json()) as DriveFilesListResponse;
        const files = result.files ?? [];

        const documents: ConnectorDocument[] = [];

        for (const file of files) {
          const doc = await this.safeItemFetch({
            fetch: async () => {
              const content = await fetchFileContent(
                file,
                accessToken,
                this.fetchWithRetry.bind(this),
              );
              if (content === null) return null;
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

        batchIndex++;
        this.log.debug(
          {
            batchIndex,
            fileCount: files.length,
            documentCount: documents.length,
            hasMore,
          },
          "Drive files batch done",
        );

        yield {
          documents,
          failures: this.flushFailures(),
          checkpoint: buildCheckpoint({
            type: "googledrive",
            itemUpdatedAt: lastFile?.modifiedTime,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
          }),
          hasMore,
        };
      } catch (error) {
        this.log.error(
          { batchIndex, error: extractErrorMessage(error) },
          "Google Drive sync batch failed",
        );
        throw error;
      }
    }
  }
}

// ===== Auth helpers =====

/**
 * Obtain a Google OAuth 2.0 access token from the provided credentials.
 *
 * Supports two modes:
 * 1. Service Account JSON — pass the full JSON key file content as `apiToken`.
 * 2. Bearer access token — pass a raw access token as `apiToken` directly.
 */
async function getAccessToken(credentials: ConnectorCredentials): Promise<string> {
  const raw = credentials.apiToken.trim();

  // Try to parse as service account JSON
  let saKey: ServiceAccountKey | null = null;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      parsed.type === "service_account" &&
      typeof parsed.client_email === "string" &&
      typeof parsed.private_key === "string"
    ) {
      saKey = parsed as ServiceAccountKey;
    }
  } catch {
    // Not JSON — treat as raw access token
  }

  if (!saKey) {
    // Raw access token mode
    return raw;
  }

  // Service account JWT flow
  return exchangeServiceAccountJwt(saKey);
}

async function exchangeServiceAccountJwt(key: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + 3600;
  const tokenUri = key.token_uri ?? GOOGLE_TOKEN_URL;

  const header = base64urlEncode(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  );
  const payload = base64urlEncode(
    JSON.stringify({
      iss: key.client_email,
      scope: TOKEN_SCOPE,
      aud: tokenUri,
      exp: expiry,
      iat: now,
    }),
  );

  const signingInput = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signingInput);
  const signature = sign
    .sign(key.private_key)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const jwt = `${signingInput}.${signature}`;

  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Service account token exchange failed: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

function base64urlEncode(input: string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// ===== Drive API helpers =====

function buildHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
}

function buildQuery(params: {
  folderId?: string;
  mimeTypes?: string[];
  modifiedAfter?: string;
}): string {
  const parts: string[] = ["trashed = false"];

  if (params.folderId) {
    parts.push(`'${params.folderId}' in parents`);
  }

  if (params.mimeTypes && params.mimeTypes.length > 0) {
    const mimeFilter = params.mimeTypes
      .map((m) => `mimeType = '${m}'`)
      .join(" or ");
    parts.push(`(${mimeFilter})`);
  } else {
    // Default: only sync Google Docs formats and common text files
    const defaultMimes = [
      ...Object.keys(GOOGLE_DOC_EXPORT_TYPES),
      ...Array.from(SUPPORTED_DOWNLOAD_MIME_TYPES),
    ];
    const mimeFilter = defaultMimes.map((m) => `mimeType = '${m}'`).join(" or ");
    parts.push(`(${mimeFilter})`);
  }

  if (params.modifiedAfter) {
    parts.push(`modifiedTime > '${params.modifiedAfter}'`);
  }

  return parts.join(" and ");
}

function buildListUrl(params: {
  query: string;
  pageSize: number;
  pageToken?: string;
  driveId?: string;
}): string {
  const fields = [
    "nextPageToken",
    "files(id,name,mimeType,modifiedTime,createdTime,webViewLink,size,parents)",
  ].join(",");

  const searchParams = new URLSearchParams({
    q: params.query,
    pageSize: String(params.pageSize),
    fields,
    orderBy: "modifiedTime asc",
  });

  if (params.driveId) {
    searchParams.set("driveId", params.driveId);
    searchParams.set("includeItemsFromAllDrives", "true");
    searchParams.set("supportsAllDrives", "true");
    searchParams.set("corpora", "drive");
  }

  if (params.pageToken) {
    searchParams.set("pageToken", params.pageToken);
  }

  return `${DRIVE_API_BASE}/files?${searchParams.toString()}`;
}

async function fetchFileContent(
  file: DriveFile,
  accessToken: string,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<string | null> {
  const headers = buildHeaders(accessToken);

  // Google Workspace formats — export as plain text
  const exportMimeType = GOOGLE_DOC_EXPORT_TYPES[file.mimeType];
  if (exportMimeType) {
    const url = `${DRIVE_API_BASE}/files/${file.id}/export?mimeType=${encodeURIComponent(exportMimeType)}`;
    const response = await fetchFn(url, { headers });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Export failed for ${file.name}: HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    const text = await response.text();
    return text.slice(0, MAX_CONTENT_LENGTH);
  }

  // Plain text and similar formats — download directly
  if (SUPPORTED_DOWNLOAD_MIME_TYPES.has(file.mimeType)) {
    const url = `${DRIVE_API_BASE}/files/${file.id}?alt=media`;
    const response = await fetchFn(url, { headers });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Download failed for ${file.name}: HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    const text = await response.text();
    return text.slice(0, MAX_CONTENT_LENGTH);
  }

  // Unsupported type — skip
  return null;
}

function fileToDocument(file: DriveFile, content: string): ConnectorDocument {
  return {
    id: file.id,
    title: file.name,
    content: content ? `# ${file.name}\n\n${content}` : `# ${file.name}`,
    sourceUrl: file.webViewLink,
    metadata: {
      driveFileId: file.id,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime,
      createdTime: file.createdTime,
      parents: file.parents,
    },
    updatedAt: file.modifiedTime ? new Date(file.modifiedTime) : undefined,
  };
}

function parseGoogleDriveConfig(
  config: Record<string, unknown>,
): GoogleDriveConfig | null {
  const result = GoogleDriveConfigSchema.safeParse({ type: "googledrive", ...config });
  return result.success ? result.data : null;
}

function subtractSafetyBuffer(isoDate: string): string {
  return new Date(
    new Date(isoDate).getTime() - INCREMENTAL_SAFETY_BUFFER_MS,
  ).toISOString();
}
