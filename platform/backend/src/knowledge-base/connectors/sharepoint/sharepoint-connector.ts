import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  SharePointCheckpoint,
  SharePointConfig,
} from "@/types";
import { SharePointConfigSchema } from "@/types";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";

const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_API_ORIGIN = "https://graph.microsoft.com/";
const DEFAULT_BATCH_SIZE = 50;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const SUPPORTED_FILE_EXTENSIONS = [".docx", ".pdf", ".txt", ".md"];

export class SharePointConnector extends BaseConnector {
  type = "sharepoint" as const;

  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;
  private tokenCacheKey = "";

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseConfig(config);
    if (!parsed) {
      return { valid: false, error: "Invalid SharePoint configuration" };
    }
    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    this.log.debug("Testing SharePoint connection");

    const parsed = parseConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid SharePoint configuration" };
    }

    try {
      const token = await this.getAccessToken(parsed, params.credentials);
      const { hostname, serverRelativePath } = parseSiteUrl(parsed.siteUrl);
      const encodedPath = serverRelativePath
        .split("/")
        .map(encodeURIComponent)
        .join("/");

      const response = await this.fetchWithRetry(
        `${GRAPH_API_BASE}/sites/${encodeURIComponent(hostname)}:/${encodedPath}`,
        { headers: buildGraphHeaders(token) },
      );

      if (!response.ok) {
        const body = await response.text();
        return {
          success: false,
          error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
        };
      }

      this.log.debug("SharePoint connection test successful");
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "SharePoint connection test failed");
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
    const parsed = parseConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid SharePoint configuration");
    }

    const checkpoint = (params.checkpoint as SharePointCheckpoint | null) ?? {
      type: "sharepoint" as const,
    };

    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const allowedExtensions =
      parsed.includeFileTypes ?? SUPPORTED_FILE_EXTENSIONS;

    this.log.debug(
      {
        siteUrl: parsed.siteUrl,
        driveId: parsed.driveId,
        folderPath: parsed.folderPath,
      },
      "Starting SharePoint sync",
    );

    const token = await this.getAccessToken(parsed, params.credentials);
    const siteId = await this.resolveSiteId(parsed, token);
    const driveId =
      parsed.driveId ?? (await this.resolveDefaultDriveId(siteId, token));

    const tokenGetter = () => this.getAccessToken(parsed, params.credentials);

    // Use delta query for incremental sync when we have a deltaLink
    if (checkpoint.deltaLink) {
      yield* this.syncWithDelta({
        driveId,
        getToken: tokenGetter,
        checkpoint,
        batchSize,
        allowedExtensions,
      });
      return;
    }

    yield* this.syncDriveItems({
      driveId,
      folderPath: parsed.folderPath,
      getToken: tokenGetter,
      checkpoint,
      batchSize,
      allowedExtensions,
    });
  }

  // ===== Private methods =====

  private async getAccessToken(
    config: SharePointConfig,
    credentials: ConnectorCredentials,
  ): Promise<string> {
    // Return cached token if still valid (with 5-min buffer) and same credentials
    const cacheKey = `${config.tenantId}:${config.clientId}`;
    if (
      this.cachedToken &&
      this.tokenCacheKey === cacheKey &&
      Date.now() < this.tokenExpiresAt - 5 * 60 * 1000
    ) {
      return this.cachedToken;
    }

    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: credentials.apiToken,
      scope: "https://graph.microsoft.com/.default",
    });

    const response = await this.fetchWithRetry(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to get access token: HTTP ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in?: number;
    };
    this.cachedToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    this.tokenCacheKey = cacheKey;
    return data.access_token;
  }

  private async resolveSiteId(
    config: SharePointConfig,
    token: string,
  ): Promise<string> {
    const { hostname, serverRelativePath } = parseSiteUrl(config.siteUrl);
    const encodedPath = serverRelativePath
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    const response = await this.fetchWithRetry(
      `${GRAPH_API_BASE}/sites/${encodeURIComponent(hostname)}:/${encodedPath}`,
      { headers: buildGraphHeaders(token) },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Failed to resolve site: HTTP ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    const site = (await response.json()) as { id: string };
    return site.id;
  }

  private async resolveDefaultDriveId(
    siteId: string,
    token: string,
  ): Promise<string> {
    // Use /drive (singular) to resolve the default document library directly,
    // rather than /drives which returns all libraries and picking index 0.
    // The /drives list is not ordered by "default" and index 0 may resolve to
    // the wrong library if a site has multiple document libraries.
    const response = await this.fetchWithRetry(
      `${GRAPH_API_BASE}/sites/${siteId}/drive`,
      { headers: buildGraphHeaders(token) },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Failed to get default drive: HTTP ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as { id: string };
    return data.id;
  }

  private async *syncDriveItems(params: {
    driveId: string;
    folderPath: string | undefined;
    getToken: () => Promise<string>;
    checkpoint: SharePointCheckpoint;
    batchSize: number;
    allowedExtensions: string[];
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      driveId,
      folderPath,
      getToken,
      checkpoint,
      batchSize,
      allowedExtensions,
    } = params;

    // Use the delta endpoint from the start so we get a proper deltaLink for future syncs.
    // If the previous run was interrupted mid-pagination, resume from the saved nextLink.
    const encodedDriveId = encodeURIComponent(driveId);
    const initialUrl = folderPath
      ? `${GRAPH_API_BASE}/drives/${encodedDriveId}/root:/${encodeFolderPath(folderPath)}:/delta?$top=${batchSize}`
      : `${GRAPH_API_BASE}/drives/${encodedDriveId}/root/delta?$top=${batchSize}`;
    let url = checkpoint.nextLink ?? initialUrl;

    let batchIndex = 0;

    while (url) {
      await this.rateLimit();

      const token = await getToken();
      this.log.debug(
        { batchIndex, driveId },
        "Fetching SharePoint drive items",
      );

      validateGraphUrl(url);
      const response = await this.fetchWithRetry(url, {
        headers: buildGraphHeaders(token),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Failed to list drive items: HTTP ${response.status}: ${body.slice(0, 200)}`,
        );
      }

      const result = (await response.json()) as DriveItemListResponse;
      const items = result.value;

      const documents: ConnectorDocument[] = [];
      let lastModified: string | undefined;

      for (const item of items) {
        if (item.folder) continue;
        if (item.deleted) continue;
        if (!isSupportedFile(item.name, allowedExtensions)) continue;

        if (item.size > MAX_FILE_SIZE_BYTES) {
          this.log.warn(
            { fileName: item.name, size: item.size },
            "Skipping file exceeding size limit",
          );
          continue;
        }

        const doc = await this.safeItemFetch({
          fetch: async () => {
            const content = await this.downloadFileContent(
              driveId,
              item.id,
              item.name,
              token,
            );
            return driveItemToDocument(item, content);
          },
          fallback: null,
          itemId: item.id,
          resource: "file",
        });

        if (doc) documents.push(doc);
        lastModified = item.lastModifiedDateTime;
      }

      const nextLink = result["@odata.nextLink"];
      const deltaLink = result["@odata.deltaLink"];

      batchIndex++;
      this.log.debug(
        {
          batchIndex,
          itemCount: items.length,
          documentCount: documents.length,
          hasMore: !!nextLink,
        },
        "SharePoint drive items batch done",
      );

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "sharepoint",
          itemUpdatedAt: lastModified,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
          extra: {
            deltaLink: deltaLink ?? checkpoint.deltaLink,
            // Persist nextLink so an interrupted pagination run can resume from
            // the correct page rather than restarting from root/delta.
            nextLink: nextLink,
          },
        }),
        hasMore: !!nextLink,
      };

      url = nextLink ?? "";
    }
  }

  private async *syncWithDelta(params: {
    driveId: string;
    getToken: () => Promise<string>;
    checkpoint: SharePointCheckpoint;
    batchSize: number;
    allowedExtensions: string[];
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { driveId, getToken, checkpoint, allowedExtensions } = params;

    // Resume from nextLink if the previous delta run was interrupted mid-pagination.
    let url = (checkpoint.nextLink ?? checkpoint.deltaLink) as string;
    let batchIndex = 0;

    while (url) {
      await this.rateLimit();

      const token = await getToken();
      this.log.debug({ batchIndex, driveId }, "Fetching SharePoint delta");

      validateGraphUrl(url);
      const response = await this.fetchWithRetry(url, {
        headers: buildGraphHeaders(token),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Delta query failed: HTTP ${response.status}: ${body.slice(0, 200)}`,
        );
      }

      const result = (await response.json()) as DriveItemListResponse;
      const items = result.value;

      const documents: ConnectorDocument[] = [];
      let lastModified: string | undefined;

      for (const item of items) {
        if (item.folder) continue;
        if (item.deleted) continue;
        if (!isSupportedFile(item.name, allowedExtensions)) continue;

        if (item.size > MAX_FILE_SIZE_BYTES) {
          this.log.warn(
            { fileName: item.name, size: item.size },
            "Skipping file exceeding size limit",
          );
          continue;
        }

        const doc = await this.safeItemFetch({
          fetch: async () => {
            const content = await this.downloadFileContent(
              driveId,
              item.id,
              item.name,
              token,
            );
            return driveItemToDocument(item, content);
          },
          fallback: null,
          itemId: item.id,
          resource: "file",
        });

        if (doc) documents.push(doc);
        lastModified = item.lastModifiedDateTime;
      }

      const nextLink = result["@odata.nextLink"];
      const deltaLink = result["@odata.deltaLink"];

      batchIndex++;
      this.log.debug(
        {
          batchIndex,
          itemCount: items.length,
          documentCount: documents.length,
          hasMore: !!nextLink,
        },
        "SharePoint delta batch done",
      );

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "sharepoint",
          itemUpdatedAt: lastModified,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
          extra: {
            deltaLink: deltaLink ?? checkpoint.deltaLink,
            // Persist nextLink so an interrupted delta pagination run can resume
            // from the correct page rather than re-fetching from deltaLink page 1.
            nextLink: nextLink,
          },
        }),
        hasMore: !!nextLink,
      };

      url = nextLink ?? "";
    }
  }

  private async downloadFileContent(
    driveId: string,
    itemId: string,
    fileName: string,
    token: string,
  ): Promise<string> {
    const response = await this.fetchWithRetry(
      `${GRAPH_API_BASE}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`,
      { headers: buildGraphHeaders(token) },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Failed to download ${fileName}: HTTP ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    const ext = getFileExtension(fileName);

    if (ext === ".txt" || ext === ".md") {
      return response.text();
    }

    // For .docx and .pdf, extract raw text from the binary response
    if (ext === ".docx") {
      return extractDocxText(await response.arrayBuffer());
    }

    if (ext === ".pdf") {
      return extractPdfText(await response.arrayBuffer());
    }

    return response.text();
  }
}

// ===== Module-level helpers =====

type DriveItem = {
  id: string;
  name: string;
  webUrl: string;
  lastModifiedDateTime: string;
  createdDateTime: string;
  size: number;
  file?: { mimeType: string };
  folder?: { childCount: number };
  deleted?: { state: string };
  lastModifiedBy?: { user?: { displayName?: string } };
};

type DriveItemListResponse = {
  value: DriveItem[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
};

function parseConfig(config: Record<string, unknown>): SharePointConfig | null {
  const result = SharePointConfigSchema.safeParse({
    type: "sharepoint",
    ...config,
  });
  return result.success ? result.data : null;
}

function parseSiteUrl(siteUrl: string): {
  hostname: string;
  serverRelativePath: string;
} {
  const url = new URL(siteUrl);
  const hostname = url.hostname;
  // URL.pathname is always percent-encoded (e.g. "my%20team").  Decode each
  // segment here so callers that re-encode individual segments with
  // encodeURIComponent() don't produce double-encoded values like "my%2520team".
  const serverRelativePath = url.pathname
    .replace(/^\//, "")
    .split("/")
    .map((s) => decodeURIComponent(s))
    .join("/");
  return { hostname, serverRelativePath };
}

function buildGraphHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
  };
}

function validateGraphUrl(url: string): void {
  if (!url.startsWith(GRAPH_API_ORIGIN)) {
    throw new Error(
      `Refusing to fetch URL outside of Microsoft Graph API: ${url.slice(0, 100)}`,
    );
  }
}

function getFileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) return "";
  return fileName.slice(dotIndex).toLowerCase();
}

function encodeFolderPath(folderPath: string): string {
  // Decode each segment before re-encoding to avoid double-encoding already-escaped
  // paths like "Shared%20Documents/Reports" → "Shared%2520Documents/Reports".
  return folderPath
    .split("/")
    .map((s) => encodeURIComponent(decodeURIComponent(s)))
    .join("/");
}

function isSupportedFile(
  fileName: string,
  allowedExtensions: string[],
): boolean {
  const ext = getFileExtension(fileName);
  return allowedExtensions.includes(ext);
}

function driveItemToDocument(
  item: DriveItem,
  content: string,
): ConnectorDocument {
  const title = item.name;
  const fullContent = content ? `# ${title}\n\n${content}` : `# ${title}`;

  return {
    id: item.id,
    title,
    content: fullContent,
    sourceUrl: item.webUrl,
    metadata: {
      sharepointItemId: item.id,
      fileName: item.name,
      mimeType: item.file?.mimeType,
      size: item.size,
      lastModifiedBy: item.lastModifiedBy?.user?.displayName,
      lastModifiedDateTime: item.lastModifiedDateTime,
      createdDateTime: item.createdDateTime,
    },
    updatedAt: new Date(item.lastModifiedDateTime),
  };
}

/**
 * Minimal .docx text extraction. Docx files are ZIP archives containing
 * XML; the document body lives in word/document.xml. We extract raw text
 * from <w:t> elements without pulling in a heavy dependency.
 */
function extractDocxText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const xmlContent = findZipEntry(bytes, "word/document.xml");
  if (!xmlContent) return "";

  // Pull text from <w:t ...>...</w:t> tags
  const matches = xmlContent.match(/<w:t[^>]*>([^<]*)<\/w:t>/g);
  if (!matches) return "";

  return matches
    .map((m) => {
      const inner = m.replace(/<[^>]+>/g, "");
      return inner;
    })
    .join("");
}

/**
 * Minimal PDF text extraction. Pulls text from stream objects by looking
 * for text-showing operators (Tj, TJ, '). This is best-effort and won't
 * handle every PDF encoding, but covers the majority of simple documents.
 */
function extractPdfText(buffer: ArrayBuffer): string {
  const text = new TextDecoder("latin1").decode(buffer);
  const parts: string[] = [];

  // Match text between BT...ET blocks
  const btBlocks = text.match(/BT[\s\S]*?ET/g);
  if (!btBlocks) return "";

  for (const block of btBlocks) {
    // Tj operator: (text) Tj
    const tjMatches = block.match(/\(([^)]*)\)\s*Tj/g);
    if (tjMatches) {
      for (const m of tjMatches) {
        const inner = m.match(/\(([^)]*)\)/);
        if (inner?.[1]) parts.push(inner[1]);
      }
    }

    // TJ operator: [(text) num (text) ...] TJ
    const tjArrayMatches = block.match(/\[([^\]]*)\]\s*TJ/g);
    if (tjArrayMatches) {
      for (const m of tjArrayMatches) {
        const innerParts = m.match(/\(([^)]*)\)/g);
        if (innerParts) {
          for (const p of innerParts) {
            const val = p.match(/\(([^)]*)\)/);
            if (val?.[1]) parts.push(val[1]);
          }
        }
      }
    }
  }

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Locate and extract a file entry from a ZIP archive.
 * Handles both stored (method 0) and deflated (method 8) entries.
 */
function findZipEntry(bytes: Uint8Array, entryName: string): string | null {
  const { inflateRawSync } = require("node:zlib") as typeof import("node:zlib");
  const decoder = new TextDecoder("utf-8");
  const nameBytes = new TextEncoder().encode(entryName);

  for (let i = 0; i < bytes.length - 4; i++) {
    // Local file header signature: PK\x03\x04
    if (
      bytes[i] !== 0x50 ||
      bytes[i + 1] !== 0x4b ||
      bytes[i + 2] !== 0x03 ||
      bytes[i + 3] !== 0x04
    ) {
      continue;
    }

    const nameLength = bytes[i + 26] | (bytes[i + 27] << 8);
    const extraLength = bytes[i + 28] | (bytes[i + 29] << 8);
    const nameStart = i + 30;
    const nameEnd = nameStart + nameLength;

    if (nameEnd > bytes.length) continue;

    const name = bytes.slice(nameStart, nameEnd);
    if (name.length !== nameBytes.length) continue;

    let match = true;
    for (let j = 0; j < name.length; j++) {
      if (name[j] !== nameBytes[j]) {
        match = false;
        break;
      }
    }
    if (!match) continue;

    const compressionMethod = bytes[i + 8] | (bytes[i + 9] << 8);
    const compressedSize =
      bytes[i + 18] |
      (bytes[i + 19] << 8) |
      (bytes[i + 20] << 16) |
      (bytes[i + 21] << 24);
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > bytes.length) continue;

    const raw = bytes.slice(dataStart, dataEnd);

    // method 0 = stored, method 8 = deflated
    if (compressionMethod === 0) {
      return decoder.decode(raw);
    }

    if (compressionMethod === 8) {
      try {
        return decoder.decode(inflateRawSync(Buffer.from(raw)));
      } catch {
        return null;
      }
    }

    // Unsupported compression method
    return null;
  }

  return null;
}
