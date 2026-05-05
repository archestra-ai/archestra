import { ClientSecretCredential } from "@azure/identity";
import { Client, ResponseType } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";
import type { DriveItem as GraphDriveItem } from "@microsoft/microsoft-graph-types";
import type { ModelInputModality } from "@shared";
import JSZip from "jszip";
import mammoth from "mammoth";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  OneDriveCheckpoint,
  OneDriveConfig,
} from "@/types";
import { OneDriveConfigSchema } from "@/types";
import { stripHtmlTags } from "@/utils/strip-html";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";
import {
  type FolderTraversalAdapter,
  traverseFolders,
} from "../folder-traversal";
import { parsePdfBuffer } from "../pdf-utils";

const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";
const DEFAULT_BATCH_SIZE = 50;
const MAX_CONTENT_LENGTH = 500_000; // 500 KB text limit per document
const MAX_IMAGE_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB image size limit
const INCREMENTAL_SAFETY_BUFFER_MS = 5 * 60 * 1000;

const SUPPORTED_TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".xml",
  ".html",
  ".htm",
  ".log",
  ".yaml",
  ".yml",
]);

const SUPPORTED_BINARY_EXTENSIONS = new Set([".docx", ".pdf", ".pptx"]);

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
]);

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export class OneDriveConnector extends BaseConnector {
  type = "onedrive" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseOneDriveConfig(config);
    if (!parsed) {
      return { valid: false, error: "Invalid OneDrive configuration" };
    }
    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    this.log.debug("Testing OneDrive connection");

    try {
      const config = parseOneDriveConfig(params.config);
      if (!config) {
        return { success: false, error: "Invalid configuration" };
      }

      const client = this.getGraphClient(params.credentials, config);
      const userId = config.userIds[0];

      // Lightweight call: fetch the user's drive metadata
      await client
        .api(`${GRAPH_API_BASE}/users/${userId}/drive`)
        .select("id,name")
        .get();

      this.log.debug("OneDrive connection test successful");
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "OneDrive connection test failed");
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    embeddingInputModalities?: ModelInputModality[];
  }): Promise<number | null> {
    const parsed = parseOneDriveConfig(params.config);
    if (!parsed) return null;

    try {
      const checkpoint = (params.checkpoint as OneDriveCheckpoint | null) ?? {
        type: "onedrive" as const,
      };
      const syncFrom = checkpoint.lastSyncedAt;
      const safetyBufferedSyncFrom = syncFrom
        ? subtractSafetyBuffer(syncFrom)
        : undefined;
      const supportsImages =
        params.embeddingInputModalities?.includes("image") ?? false;

      const client = this.getGraphClient(params.credentials, parsed);
      let total = 0;

      for (const userId of parsed.userIds) {
        total += await this.countUserDriveItems({
          client,
          userId,
          config: parsed,
          syncFrom: safetyBufferedSyncFrom,
          supportsImages,
        });
      }

      return total;
    } catch (error) {
      this.log.warn(
        { error: extractErrorMessage(error) },
        "Failed to estimate total items",
      );
      return null;
    }
  }

  async *sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
    embeddingInputModalities?: ModelInputModality[];
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parseOneDriveConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid OneDrive configuration");
    }

    const checkpoint = (params.checkpoint as OneDriveCheckpoint | null) ?? {
      type: "onedrive" as const,
    };

    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const syncFrom = checkpoint.lastSyncedAt ?? params.startTime?.toISOString();
    const safetyBufferedSyncFrom = syncFrom
      ? subtractSafetyBuffer(syncFrom)
      : undefined;
    const supportsImages =
      params.embeddingInputModalities?.includes("image") ?? false;
    const recursive = parsed.recursive ?? true;
    const maxDepth = parsed.maxDepth;

    const client = this.getGraphClient(params.credentials, parsed);

    const progress = {
      maxLastModified: checkpoint.lastSyncedAt as string | undefined,
      safeLastSyncedAt: checkpoint.lastSyncedAt as string | undefined,
    };

    this.log.debug(
      {
        userIds: parsed.userIds,
        folderId: parsed.folderId,
        recursive,
        syncFrom,
        supportsImages,
      },
      "Starting OneDrive sync",
    );

    for (let i = 0; i < parsed.userIds.length; i++) {
      const userId = parsed.userIds[i];
      const isLastUser = i === parsed.userIds.length - 1;

      yield* this.syncUserDrive({
        client,
        userId,
        config: parsed,
        progress,
        syncFrom: safetyBufferedSyncFrom,
        batchSize,
        supportsImages,
        recursive,
        maxDepth,
        fileTypes: parsed.fileTypes,
        hasMoreUsers: !isLastUser,
      });
    }
  }

  // ===== Private methods =====

  private getGraphClient(
    credentials: ConnectorCredentials,
    config: OneDriveConfig,
  ): Client {
    // Reuses the same credential pattern as SharePoint:
    // credentials.email = Azure AD Application (client) ID
    // credentials.apiToken = Azure AD client secret
    const clientId = credentials.email;

    if (!clientId) {
      throw new Error("Client ID is required");
    }

    const credential = new ClientSecretCredential(
      config.tenantId,
      clientId,
      credentials.apiToken,
    );

    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ["https://graph.microsoft.com/.default"],
    });

    return Client.initWithMiddleware({ authProvider });
  }

  private async *syncUserDrive(params: {
    client: Client;
    userId: string;
    config: OneDriveConfig;
    progress: {
      maxLastModified: string | undefined;
      safeLastSyncedAt: string | undefined;
    };
    syncFrom: string | undefined;
    batchSize: number;
    supportsImages: boolean;
    recursive: boolean;
    maxDepth: number | undefined;
    fileTypes: string[] | undefined;
    hasMoreUsers: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      client,
      userId,
      config,
      progress,
      syncFrom,
      batchSize,
      supportsImages,
      recursive,
      maxDepth,
      fileTypes,
      hasMoreUsers,
    } = params;

    this.log.debug({ userId }, "Syncing OneDrive for user");

    const rootItemId = config.folderId ?? "root";

    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: (folderId) =>
        this.listDirectSubfolders({ client, userId, folderId }),
    };

    const folderGen = traverseFolders(
      adapter,
      { rootFolderId: rootItemId, recursive, maxDepth },
      this.log,
    );

    let next = await folderGen.next();
    while (!next.done) {
      const folderId = next.value;
      next = await folderGen.next();
      const hasMoreFolders = !next.done;

      yield* this.syncFilesInFolder({
        client,
        userId,
        folderId,
        progress,
        syncFrom,
        batchSize,
        supportsImages,
        fileTypes,
        hasMoreFolders: hasMoreFolders || hasMoreUsers,
      });
    }
  }

  private async *syncFilesInFolder(params: {
    client: Client;
    userId: string;
    folderId: string;
    progress: {
      maxLastModified: string | undefined;
      safeLastSyncedAt: string | undefined;
    };
    syncFrom: string | undefined;
    batchSize: number;
    supportsImages: boolean;
    fileTypes: string[] | undefined;
    hasMoreFolders: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      client,
      userId,
      folderId,
      progress,
      syncFrom,
      batchSize,
      supportsImages,
      fileTypes,
      hasMoreFolders,
    } = params;

    let url = buildFolderChildrenUrl(userId, folderId, batchSize);
    let hasMorePages = true;
    let batchIndex = 0;

    while (hasMorePages) {
      await this.rateLimit();

      let result: GraphListResponse<DriveItem>;
      try {
        result = await client.api(url).get();
      } catch (error) {
        throw new Error(
          `OneDrive items query failed for user ${userId}: ${extractErrorMessage(error)}`,
        );
      }

      const files = result.value.filter(
        (item) =>
          item.file &&
          !item.folder &&
          isSupportedFile(item.name, supportsImages, fileTypes) &&
          isModifiedSince(item.lastModifiedDateTime, syncFrom),
      );

      const documents: ConnectorDocument[] = [];

      for (const item of files) {
        const doc = await this.safeItemFetch({
          fetch: async () => {
            const result = await this.downloadFileData(
              client,
              userId,
              item.id,
              item.name,
            );
            if (!result.text.trim() && !result.mediaContent) {
              this.trackSkipped({
                itemId: item.id,
                name: item.name,
                reason: "Empty content — no text or media could be extracted",
              });
              return null;
            }
            return driveItemToDocument(
              item,
              userId,
              result.text,
              result.mediaContent,
            );
          },
          fallback: null,
          itemId: item.id,
          resource: "driveItem",
        });
        if (doc) documents.push(doc);
      }

      const nextLink = result["@odata.nextLink"];
      hasMorePages = !!nextLink;
      if (nextLink) url = nextLink;

      const lastResult = result.value[result.value.length - 1];
      const lastModified = lastResult?.lastModifiedDateTime;

      if (
        lastModified &&
        (!progress.maxLastModified || lastModified > progress.maxLastModified)
      ) {
        progress.maxLastModified = lastModified;
      }

      const hasMore = hasMorePages || hasMoreFolders;

      batchIndex++;
      this.log.debug(
        {
          userId,
          folderId,
          batchIndex,
          itemCount: files.length,
          documentCount: documents.length,
          hasMore,
        },
        "OneDrive batch done",
      );

      const checkpointAt = hasMore
        ? progress.safeLastSyncedAt
        : progress.maxLastModified;

      yield {
        documents,
        failures: this.flushFailures(),
        skipped: this.flushSkipped(),
        checkpoint: buildCheckpoint({
          type: "onedrive",
          itemUpdatedAt: checkpointAt ? new Date(checkpointAt) : undefined,
          previousLastSyncedAt: checkpointAt,
        }),
        hasMore,
      };
    }
  }

  private async listDirectSubfolders(params: {
    client: Client;
    userId: string;
    folderId: string;
  }): Promise<string[]> {
    const { client, userId, folderId } = params;
    let url: string = buildFolderSubfoldersUrl(userId, folderId);
    const subfolderIds: string[] = [];

    while (url) {
      const result = (await client
        .api(url)
        .get()) as GraphListResponse<GraphDriveItem>;
      for (const item of result.value ?? []) {
        if (item.folder && !item.file && item.id) {
          subfolderIds.push(item.id);
        }
      }
      url = result["@odata.nextLink"] ?? "";
    }

    return subfolderIds;
  }

  private async downloadFileData(
    client: Client,
    userId: string,
    itemId: string,
    fileName: string,
  ): Promise<{
    text: string;
    mediaContent?: { mimeType: string; data: string };
  }> {
    const ext = getFileExtension(fileName);
    const contentPath = `/users/${userId}/drive/items/${itemId}/content`;

    if (SUPPORTED_TEXT_EXTENSIONS.has(ext)) {
      const arrayBuffer = (await client
        .api(contentPath)
        .responseType(ResponseType.ARRAYBUFFER)
        .get()) as ArrayBuffer;
      return {
        text: Buffer.from(arrayBuffer)
          .toString("utf-8")
          .slice(0, MAX_CONTENT_LENGTH),
      };
    }

    if (SUPPORTED_BINARY_EXTENSIONS.has(ext)) {
      const arrayBuffer = (await client
        .api(contentPath)
        .responseType(ResponseType.ARRAYBUFFER)
        .get()) as ArrayBuffer;
      const text = await extractTextFromBinary(Buffer.from(arrayBuffer), ext);
      return { text: text.slice(0, MAX_CONTENT_LENGTH) };
    }

    if (SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
      const arrayBuffer = (await client
        .api(contentPath)
        .responseType(ResponseType.ARRAYBUFFER)
        .get()) as ArrayBuffer;
      if (arrayBuffer.byteLength > MAX_IMAGE_SIZE_BYTES) {
        this.log.debug(
          { fileName, sizeBytes: arrayBuffer.byteLength },
          "OneDrive: skipping oversized image",
        );
        return { text: "" };
      }
      const mimeType = IMAGE_MIME_TYPES[ext] ?? "application/octet-stream";
      const data = Buffer.from(arrayBuffer).toString("base64");
      return { text: "", mediaContent: { mimeType, data } };
    }

    this.log.debug(
      { fileName, ext },
      "OneDrive: skipping unsupported file type",
    );
    return { text: "" };
  }

  private async countUserDriveItems(params: {
    client: Client;
    userId: string;
    config: OneDriveConfig;
    syncFrom: string | undefined;
    supportsImages: boolean;
  }): Promise<number> {
    const { client, userId, config, syncFrom, supportsImages } = params;
    const rootItemId = config.folderId ?? "root";
    const recursive = config.recursive ?? true;
    const maxDepth = config.maxDepth;

    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: (folderId) =>
        this.listDirectSubfolders({ client, userId, folderId }),
    };

    let count = 0;
    for await (const folderId of traverseFolders(adapter, {
      rootFolderId: rootItemId,
      recursive,
      maxDepth,
    })) {
      count += await this.countFilesInFolder({
        client,
        userId,
        folderId,
        syncFrom,
        fileTypes: config.fileTypes,
        supportsImages,
      });
    }

    return count;
  }

  private async countFilesInFolder(params: {
    client: Client;
    userId: string;
    folderId: string;
    syncFrom: string | undefined;
    fileTypes: string[] | undefined;
    supportsImages: boolean;
  }): Promise<number> {
    const { client, userId, folderId, syncFrom, fileTypes, supportsImages } =
      params;
    let url = buildFolderChildrenUrl(userId, folderId, 500);
    let count = 0;

    while (url) {
      const result = (await client
        .api(url)
        .get()) as GraphListResponse<DriveItem>;
      count += result.value.filter(
        (item) =>
          item.file &&
          !item.folder &&
          isSupportedFile(item.name, supportsImages, fileTypes) &&
          isModifiedSince(item.lastModifiedDateTime, syncFrom),
      ).length;
      url = result["@odata.nextLink"] ?? "";
    }

    return count;
  }
}

// ===== Module-level helpers =====

type GraphListResponse<T> = {
  value: T[];
  "@odata.nextLink"?: string;
};

type RequiredNonNull<T, K extends keyof T> = {
  [P in K]-?: NonNullable<T[P]>;
};

type DriveItem = RequiredNonNull<
  GraphDriveItem,
  | "id"
  | "name"
  | "webUrl"
  | "lastModifiedDateTime"
  | "createdDateTime"
  | "size"
  | "file"
  | "folder"
  | "parentReference"
>;

function subtractSafetyBuffer(isoDate: string): string {
  return new Date(
    new Date(isoDate).getTime() - INCREMENTAL_SAFETY_BUFFER_MS,
  ).toISOString();
}

function parseOneDriveConfig(
  config: Record<string, unknown>,
): OneDriveConfig | null {
  const result = OneDriveConfigSchema.safeParse({
    type: "onedrive",
    ...config,
  });
  return result.success ? result.data : null;
}

function buildFolderChildrenUrl(
  userId: string,
  itemId: string,
  batchSize: number,
): string {
  const basePath =
    itemId === "root"
      ? `${GRAPH_API_BASE}/users/${userId}/drive/root/children`
      : `${GRAPH_API_BASE}/users/${userId}/drive/items/${itemId}/children`;

  const params = new URLSearchParams({
    $select:
      "id,name,webUrl,lastModifiedDateTime,createdDateTime,size,file,folder,parentReference",
    $orderby: "lastModifiedDateTime asc",
    $top: String(batchSize),
  });

  return `${basePath}?${params.toString()}`;
}

function buildFolderSubfoldersUrl(userId: string, itemId: string): string {
  const basePath =
    itemId === "root"
      ? `${GRAPH_API_BASE}/users/${userId}/drive/root/children`
      : `${GRAPH_API_BASE}/users/${userId}/drive/items/${itemId}/children`;

  const params = new URLSearchParams({
    $select: "id,folder,file",
    $top: "500",
  });

  return `${basePath}?${params.toString()}`;
}

function isSupportedFile(
  name: string,
  supportsImages = false,
  fileTypes?: string[],
): boolean {
  const ext = getFileExtension(name);
  if (fileTypes && fileTypes.length > 0) {
    return fileTypes.includes(ext);
  }
  return (
    SUPPORTED_TEXT_EXTENSIONS.has(ext) ||
    SUPPORTED_BINARY_EXTENSIONS.has(ext) ||
    (supportsImages && SUPPORTED_IMAGE_EXTENSIONS.has(ext))
  );
}

function getFileExtension(name: string): string {
  const lastDot = name.lastIndexOf(".");
  if (lastDot < 0) return "";
  return name.slice(lastDot).toLowerCase();
}

function isModifiedSince(
  itemTimestamp: string | undefined,
  syncFrom: string | undefined,
): boolean {
  if (!syncFrom || !itemTimestamp) {
    return true;
  }

  const itemTime = Date.parse(itemTimestamp);
  const syncTime = Date.parse(syncFrom);

  if (!Number.isNaN(itemTime) && !Number.isNaN(syncTime)) {
    return itemTime >= syncTime;
  }

  return itemTimestamp >= syncFrom;
}

async function extractTextFromBinary(
  buffer: Buffer,
  ext: string,
): Promise<string> {
  switch (ext) {
    case ".docx": {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    case ".pdf": {
      return parsePdfBuffer(buffer);
    }
    case ".pptx": {
      return extractTextFromPptx(buffer);
    }
    default:
      return "";
  }
}

async function extractTextFromPptx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const parts: string[] = [];

  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = Number.parseInt(a.match(/slide(\d+)/)?.[1] ?? "0", 10);
      const numB = Number.parseInt(b.match(/slide(\d+)/)?.[1] ?? "0", 10);
      return numA - numB;
    });

  for (const slidePath of slideFiles) {
    const xml = await zip.files[slidePath].async("text");
    const texts = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g);
    if (texts) {
      const slideText = texts
        .map((text: string) => stripHtmlTags(text))
        .join(" ");
      if (slideText.trim()) parts.push(slideText.trim());
    }
  }

  return parts.join("\n\n");
}

function driveItemToDocument(
  item: DriveItem,
  userId: string,
  content: string,
  mediaContent?: { mimeType: string; data: string },
): ConnectorDocument {
  const title = item.name;
  const fullContent = content ? `# ${title}\n\n${content}` : `# ${title}`;

  return {
    id: item.id,
    title,
    content: mediaContent && !content.trim() ? `# ${title}` : fullContent,
    sourceUrl: item.webUrl,
    metadata: {
      userId,
      driveItemId: item.id,
      fileName: item.name,
      mimeType: item.file?.mimeType,
      size: item.size,
      lastModifiedDateTime: item.lastModifiedDateTime,
      createdDateTime: item.createdDateTime,
      parentPath: item.parentReference?.path,
    },
    updatedAt: new Date(item.lastModifiedDateTime),
    mediaContent,
  };
}
