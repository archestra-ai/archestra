import { ClientSecretCredential } from "@azure/identity";
import { Client, ResponseType } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";
import type {
  DriveItem as GraphDriveItem,
  SitePage as GraphSitePage,
} from "@microsoft/microsoft-graph-types";
import type { ModelInputModality } from "@shared";
import JSZip from "jszip";
import mammoth from "mammoth";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  SharePointCheckpoint,
  SharePointConfig,
} from "@/types";
import { SharePointConfigSchema } from "@/types";
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

// File extensions whose text content we can extract via Graph download
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

// Binary file extensions we can extract text from using libraries
const SUPPORTED_BINARY_EXTENSIONS = new Set([".docx", ".pdf", ".pptx"]);

// Image file extensions supported for multimodal embedding
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
]);

// MIME type mapping for image extensions
const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export class SharePointConnector extends BaseConnector {
  type = "sharepoint" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseSharePointConfig(config);
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

    try {
      const config = parseSharePointConfig(params.config);
      if (!config) {
        return { success: false, error: "Invalid configuration" };
      }

      const client = this.getGraphClient(params.credentials, config);
      const siteResolution = await this.resolveSite(client, config.siteUrl);

      if (!siteResolution.siteId) {
        return {
          success: false,
          error: buildResolveSiteErrorMessage(siteResolution.error),
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

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseSharePointConfig(params.config);
    if (!parsed) return null;

    try {
      const checkpoint = (params.checkpoint as SharePointCheckpoint | null) ?? {
        type: "sharepoint" as const,
      };
      const syncFrom = checkpoint.lastSyncedAt;
      const safetyBufferedSyncFrom = syncFrom
        ? subtractSafetyBuffer(syncFrom)
        : undefined;

      const client = this.getGraphClient(params.credentials, parsed);
      const siteResolution = await this.resolveSite(client, parsed.siteUrl);

      if (!siteResolution.siteId) {
        return null;
      }

      const driveIds =
        parsed.driveIds && parsed.driveIds.length > 0
          ? parsed.driveIds
          : await this.listDriveIds(client, siteResolution.siteId);

      let total = 0;

      const recursive = parsed.recursive ?? true;
      const maxDepth = parsed.maxDepth;

      for (const driveId of driveIds) {
        total += await this.countDriveItems({
          client,
          driveId,
          folderPath: parsed.folderPath,
          recursive,
          maxDepth,
          syncFrom: safetyBufferedSyncFrom,
        });
      }

      if (parsed.includePages !== false) {
        total += await this.countSitePages({
          client,
          siteId: siteResolution.siteId,
          syncFrom: safetyBufferedSyncFrom,
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
    const parsed = parseSharePointConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid SharePoint configuration");
    }

    const checkpoint = (params.checkpoint as SharePointCheckpoint | null) ?? {
      type: "sharepoint" as const,
    };

    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const syncFrom = checkpoint.lastSyncedAt ?? params.startTime?.toISOString();
    const safetyBufferedSyncFrom = syncFrom
      ? subtractSafetyBuffer(syncFrom)
      : undefined;
    const supportsImages =
      params.embeddingInputModalities?.includes("image") ?? false;

    // Single client instance — SDK handles token acquisition and refresh automatically.
    const client = this.getGraphClient(params.credentials, parsed);
    const siteResolution = await this.resolveSite(client, parsed.siteUrl);

    if (!siteResolution.siteId) {
      throw new Error(buildResolveSiteErrorMessage(siteResolution.error));
    }
    const siteId = siteResolution.siteId;

    // Track the highest lastModifiedDateTime seen across all phases (drives + pages)
    // so the checkpoint only advances monotonically and a later phase with older
    // timestamps cannot regress progress from an earlier phase.
    // safeLastSyncedAt is the original checkpoint value and never changes — it is
    // emitted on intermediate batches (hasMore=true) so a resumed run always
    // re-visits any not-yet-processed folders/drives rather than skipping them
    // because the checkpoint advanced past their file timestamps.
    const progress = {
      maxLastModified: checkpoint.lastSyncedAt as string | undefined,
      safeLastSyncedAt: checkpoint.lastSyncedAt as string | undefined,
    };

    const recursive = parsed.recursive ?? true;
    const maxDepth = parsed.maxDepth;

    this.log.debug(
      {
        siteId,
        driveIds: parsed.driveIds,
        folderPath: parsed.folderPath,
        recursive,
        includePages: parsed.includePages,
        syncFrom,
        supportsImages,
      },
      "Starting SharePoint sync",
    );

    // Sync drive items (documents/files)
    yield* this.syncDriveItems({
      client,
      siteId,
      config: parsed,
      recursive,
      maxDepth,
      progress,
      syncFrom: safetyBufferedSyncFrom,
      batchSize,
      supportsImages,
    });

    // Sync site pages if enabled
    if (parsed.includePages !== false) {
      yield* this.syncSitePages({
        client,
        siteId,
        progress,
        syncFrom: safetyBufferedSyncFrom,
        batchSize,
      });
    }
  }

  // ===== Private methods =====

  private getGraphClient(
    credentials: ConnectorCredentials,
    config: SharePointConfig,
  ): Client {
    // SharePoint reuses ConnectorCredentials.email to store the Azure AD
    // Application (client) ID so we can fit the existing connector credential
    // schema without a SharePoint-specific secret shape.
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

  private async resolveSite(
    client: Client,
    siteUrl: string,
  ): Promise<{ siteId: string | null; error?: string }> {
    const url = new URL(siteUrl);
    const hostname = url.hostname;
    const sitePath = url.pathname.replace(/^\//, "").replace(/\/$/, "");

    const apiPath = sitePath
      ? `/sites/${hostname}:/${sitePath}`
      : `/sites/${hostname}`;

    try {
      const site = (await client.api(apiPath).get()) as { id: string };
      return { siteId: site.id ?? null };
    } catch (error) {
      const message = formatSharePointGraphError({
        error,
        apiPath,
      });
      this.log.warn(
        { siteUrl, apiPath, error: message },
        "Failed to resolve SharePoint site",
      );
      return { siteId: null, error: message };
    }
  }

  private async *syncDriveItems(params: {
    client: Client;
    siteId: string;
    config: SharePointConfig;
    recursive: boolean;
    maxDepth: number | undefined;
    progress: {
      maxLastModified: string | undefined;
      safeLastSyncedAt: string | undefined;
    };
    syncFrom: string | undefined;
    batchSize: number;
    supportsImages: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      client,
      siteId,
      config,
      recursive,
      maxDepth,
      progress,
      syncFrom,
      batchSize,
      supportsImages,
    } = params;

    const driveIds =
      config.driveIds && config.driveIds.length > 0
        ? config.driveIds
        : await this.listDriveIds(client, siteId);

    for (let i = 0; i < driveIds.length; i++) {
      const driveId = driveIds[i];
      const isLastDrive = i === driveIds.length - 1;

      yield* this.syncSingleDrive({
        client,
        driveId,
        folderPath: config.folderPath,
        recursive,
        maxDepth,
        progress,
        syncFrom,
        batchSize,
        hasMoreDrives: !isLastDrive,
        supportsImages,
      });
    }
  }

  private async listDriveIds(
    client: Client,
    siteId: string,
  ): Promise<string[]> {
    let result: { value: Array<{ id: string }> };

    try {
      result = await client
        .api(`${GRAPH_API_BASE}/sites/${siteId}/drives?$select=id`)
        .get();
    } catch (error) {
      throw new Error(`Failed to list drives: ${extractErrorMessage(error)}`);
    }

    return result.value.map((d) => d.id);
  }

  private async *syncSingleDrive(params: {
    client: Client;
    driveId: string;
    folderPath: string | undefined;
    recursive: boolean;
    maxDepth: number | undefined;
    progress: {
      maxLastModified: string | undefined;
      safeLastSyncedAt: string | undefined;
    };
    syncFrom: string | undefined;
    batchSize: number;
    hasMoreDrives: boolean;
    supportsImages: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      client,
      driveId,
      folderPath,
      recursive,
      maxDepth,
      progress,
      syncFrom,
      batchSize,
      hasMoreDrives,
      supportsImages,
    } = params;

    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: (parentId) =>
        this.listDirectSubfolders({
          client,
          driveId,
          parentId,
          rootFolderPath: folderPath,
        }),
    };

    const folderGen = traverseFolders(
      adapter,
      { rootFolderId: "root", recursive, maxDepth },
      this.log,
    );

    let next = await folderGen.next();
    while (!next.done) {
      const folderId = next.value;
      next = await folderGen.next();
      const hasMoreFolders = !next.done;

      yield* this.syncFilesInFolder({
        client,
        driveId,
        folderId,
        rootFolderPath: folderId === "root" ? folderPath : undefined,
        progress,
        syncFrom,
        batchSize,
        hasMoreFolders: hasMoreFolders || hasMoreDrives,
        supportsImages,
      });
    }
  }

  private async *syncFilesInFolder(params: {
    client: Client;
    driveId: string;
    folderId: string;
    rootFolderPath: string | undefined;
    progress: {
      maxLastModified: string | undefined;
      safeLastSyncedAt: string | undefined;
    };
    syncFrom: string | undefined;
    batchSize: number;
    hasMoreFolders: boolean;
    supportsImages: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      client,
      driveId,
      folderId,
      rootFolderPath,
      progress,
      syncFrom,
      batchSize,
      hasMoreFolders,
      supportsImages,
    } = params;

    let url: string =
      folderId === "root"
        ? buildRootChildrenUrl(driveId, rootFolderPath, batchSize)
        : buildItemChildrenUrl(driveId, folderId, batchSize);
    let hasMorePages = true;
    let batchIndex = 0;

    while (hasMorePages) {
      await this.rateLimit();

      let result: GraphListResponse<DriveItem>;
      try {
        result = await client.api(url).get();
      } catch (error) {
        throw new Error(
          `Drive items query failed: ${extractErrorMessage(error)}`,
        );
      }

      const items = result.value.filter(
        (item) =>
          item.file &&
          !item.folder &&
          isSupportedFile(item.name, supportsImages) &&
          // Client-side incremental filter: Graph API does not support
          // $filter on lastModifiedDateTime for drive item children.
          isModifiedSince(item.lastModifiedDateTime, syncFrom),
      );

      const documents: ConnectorDocument[] = [];

      for (const item of items) {
        const doc = await this.safeItemFetch({
          fetch: async () => {
            const result = await this.downloadFileData(
              client,
              driveId,
              item.id,
              item.name,
            );
            // Skip files with no extractable content or media to avoid indexing
            // title-only documents that provide no search value.
            if (!result.text.trim() && !result.mediaContent) return null;
            return driveItemToDocument(
              item,
              driveId,
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

      // Use unfiltered results for checkpoint so it advances past non-text
      // files that were skipped by the client-side filter.
      const lastResult = result.value[result.value.length - 1];
      const lastModified = lastResult?.lastModifiedDateTime;

      // Advance the monotonic high-water mark
      if (
        lastModified &&
        (!progress.maxLastModified || lastModified > progress.maxLastModified)
      ) {
        progress.maxLastModified = lastModified;
      }

      const hasMore = hasMorePages || hasMoreFolders;

      // Only advance the checkpoint on the final batch. Intermediate batches
      // (hasMore=true) keep the original checkpoint so a resumed run re-visits
      // not-yet-processed folders whose files may have older timestamps.
      const checkpointAt = hasMore
        ? progress.safeLastSyncedAt
        : progress.maxLastModified;

      batchIndex++;
      this.log.debug(
        {
          driveId,
          folderId,
          batchIndex,
          itemCount: items.length,
          documentCount: documents.length,
          hasMore,
        },
        "SharePoint drive batch done",
      );

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "sharepoint",
          itemUpdatedAt: checkpointAt ? new Date(checkpointAt) : undefined,
          previousLastSyncedAt: checkpointAt,
        }),
        hasMore,
      };
    }
  }

  private async listDirectSubfolders(params: {
    client: Client;
    driveId: string;
    parentId: string;
    rootFolderPath: string | undefined;
  }): Promise<string[]> {
    const { client, driveId, parentId, rootFolderPath } = params;
    const subfolders: string[] = [];

    let url: string | undefined =
      parentId === "root"
        ? buildRootSubfoldersUrl(driveId, rootFolderPath, 500)
        : buildItemSubfoldersUrl(driveId, parentId, 500);

    while (url) {
      await this.rateLimit();
      const result = (await client.api(url).get()) as GraphListResponse<{
        id: string;
        folder?: object;
        file?: object;
      }>;
      for (const item of result.value) {
        if (item.folder && !item.file) {
          subfolders.push(item.id);
        }
      }
      url = result["@odata.nextLink"];
    }

    return subfolders;
  }

  private async downloadFileData(
    client: Client,
    driveId: string,
    itemId: string,
    fileName: string,
  ): Promise<{
    text: string;
    mediaContent?: { mimeType: string; data: string };
  }> {
    const ext = getFileExtension(fileName);
    const contentPath = `/drives/${driveId}/items/${itemId}/content`;

    // Plain text files: download and read as text
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

    // Binary files (.docx, .pdf, .pptx): download as buffer and extract text
    if (SUPPORTED_BINARY_EXTENSIONS.has(ext)) {
      const arrayBuffer = (await client
        .api(contentPath)
        .responseType(ResponseType.ARRAYBUFFER)
        .get()) as ArrayBuffer;
      const text = await extractTextFromBinary(Buffer.from(arrayBuffer), ext);
      return { text: text.slice(0, MAX_CONTENT_LENGTH) };
    }

    // Image files: download as base64 for multimodal embedding
    if (SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
      const arrayBuffer = (await client
        .api(contentPath)
        .responseType(ResponseType.ARRAYBUFFER)
        .get()) as ArrayBuffer;
      if (arrayBuffer.byteLength > MAX_IMAGE_SIZE_BYTES) {
        this.log.debug(
          { fileName, sizeBytes: arrayBuffer.byteLength },
          "SharePoint: skipping oversized image",
        );
        return { text: "" };
      }
      const mimeType = IMAGE_MIME_TYPES[ext] ?? "application/octet-stream";
      const data = Buffer.from(arrayBuffer).toString("base64");
      return { text: "", mediaContent: { mimeType, data } };
    }

    this.log.debug(
      { fileName, ext },
      "SharePoint: skipping unsupported file type",
    );
    return { text: "" };
  }

  private async *syncSitePages(params: {
    client: Client;
    siteId: string;
    progress: {
      maxLastModified: string | undefined;
      safeLastSyncedAt: string | undefined;
    };
    syncFrom: string | undefined;
    batchSize: number;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { client, siteId, progress, syncFrom, batchSize } = params;

    let url = buildSitePagesUrl(siteId, batchSize);
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      let result: GraphListResponse<SitePage>;
      try {
        result = await client.api(url).get();
      } catch (error) {
        throw new Error(
          `Site pages query failed: ${extractErrorMessage(error)}`,
        );
      }

      const documents: ConnectorDocument[] = [];

      // Client-side incremental filter for pages (same reason as drive items:
      // $filter on lastModifiedDateTime is not reliably supported by the pages API).
      const pages = syncFrom
        ? result.value.filter((p) =>
            isModifiedSince(p.lastModifiedDateTime, syncFrom),
          )
        : result.value;

      for (const page of pages) {
        const doc = await this.safeItemFetch({
          fetch: async () => {
            const content = await this.fetchPageContent(
              client,
              siteId,
              page.id,
            );
            // Skip pages with no extractable content to avoid indexing
            // title-only documents that provide no search value.
            if (!content.trim()) return null;
            return sitePageToDocument(page, siteId, content);
          },
          fallback: null,
          itemId: page.id,
          resource: "sitePage",
        });
        if (doc) documents.push(doc);
      }

      const nextLink = result["@odata.nextLink"];
      hasMore = !!nextLink;
      if (nextLink) url = nextLink;

      const lastPage = result.value[result.value.length - 1];
      const lastModified = lastPage?.lastModifiedDateTime;

      // Advance the monotonic high-water mark
      if (
        lastModified &&
        (!progress.maxLastModified || lastModified > progress.maxLastModified)
      ) {
        progress.maxLastModified = lastModified;
      }

      const checkpointAt = hasMore
        ? progress.safeLastSyncedAt
        : progress.maxLastModified;

      batchIndex++;
      this.log.debug(
        {
          batchIndex,
          pageCount: result.value.length,
          documentCount: documents.length,
          hasMore,
        },
        "SharePoint site pages batch done",
      );

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "sharepoint",
          itemUpdatedAt: checkpointAt ? new Date(checkpointAt) : undefined,
          previousLastSyncedAt: checkpointAt,
        }),
        hasMore,
      };
    }
  }

  private async fetchPageContent(
    client: Client,
    siteId: string,
    pageId: string,
  ): Promise<string> {
    const apiPath = `${GRAPH_API_BASE}/sites/${siteId}/pages/${pageId}/microsoft.graph.sitePage/webParts`;

    let result: {
      value: Array<{
        "@odata.type"?: string;
        innerHtml?: string;
        data?: { properties?: Record<string, unknown> };
      }>;
    };

    try {
      result = await client.api(apiPath).get();
    } catch (error) {
      throw new Error(
        `Failed to fetch page content for ${pageId}: ${extractErrorMessage(error)}`,
      );
    }

    const parts: string[] = [];
    for (const webPart of result.value) {
      if (webPart.innerHtml) {
        parts.push(stripHtmlTags(webPart.innerHtml));
      }
    }

    return parts.join("\n\n").slice(0, MAX_CONTENT_LENGTH);
  }

  private async countDriveItems(params: {
    client: Client;
    driveId: string;
    folderPath: string | undefined;
    recursive: boolean;
    maxDepth: number | undefined;
    syncFrom: string | undefined;
  }): Promise<number> {
    const { client, driveId, folderPath, recursive, maxDepth, syncFrom } =
      params;

    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: (parentId) =>
        this.listDirectSubfolders({
          client,
          driveId,
          parentId,
          rootFolderPath: folderPath,
        }),
    };

    let count = 0;
    for await (const folderId of traverseFolders(
      adapter,
      { rootFolderId: "root", recursive, maxDepth },
      this.log,
    )) {
      count += await this.countFilesInFolder({
        client,
        driveId,
        folderId,
        rootFolderPath: folderId === "root" ? folderPath : undefined,
        syncFrom,
      });
    }

    return count;
  }

  private async countFilesInFolder(params: {
    client: Client;
    driveId: string;
    folderId: string;
    rootFolderPath: string | undefined;
    syncFrom: string | undefined;
  }): Promise<number> {
    const { client, driveId, folderId, rootFolderPath, syncFrom } = params;

    let url: string | undefined =
      folderId === "root"
        ? buildRootChildrenUrl(driveId, rootFolderPath, 500)
        : buildItemChildrenUrl(driveId, folderId, 500);

    let count = 0;
    while (url) {
      const result = (await client
        .api(url)
        .get()) as GraphListResponse<DriveItem>;
      count += result.value.filter(
        (item) =>
          item.file &&
          !item.folder &&
          isSupportedFile(item.name) &&
          isModifiedSince(item.lastModifiedDateTime, syncFrom),
      ).length;
      url = result["@odata.nextLink"] ?? undefined;
    }

    return count;
  }

  private async countSitePages(params: {
    client: Client;
    siteId: string;
    syncFrom: string | undefined;
  }): Promise<number> {
    let url = buildSitePagesUrl(params.siteId, 500);
    let count = 0;

    while (url) {
      const result = (await params.client
        .api(url)
        .get()) as GraphListResponse<SitePage>;
      count += result.value.filter((page) =>
        isModifiedSince(page.lastModifiedDateTime, params.syncFrom),
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

// Narrowed from @microsoft/microsoft-graph-types using Pick + Required + NonNullable.
// Our $select queries guarantee these fields are present and non-null.
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

type SitePage = RequiredNonNull<
  GraphSitePage,
  | "id"
  | "name"
  | "title"
  | "webUrl"
  | "lastModifiedDateTime"
  | "createdDateTime"
  | "description"
>;

function subtractSafetyBuffer(isoDate: string): string {
  return new Date(
    new Date(isoDate).getTime() - INCREMENTAL_SAFETY_BUFFER_MS,
  ).toISOString();
}

function parseSharePointConfig(
  config: Record<string, unknown>,
): SharePointConfig | null {
  const result = SharePointConfigSchema.safeParse({
    type: "sharepoint",
    ...config,
  });
  return result.success ? result.data : null;
}

function buildResolveSiteErrorMessage(error?: string): string {
  if (!error) {
    return "Could not resolve SharePoint site. Verify the site URL and app permissions.";
  }

  return `Could not resolve SharePoint site. ${error}`;
}

function formatSharePointGraphError(params: {
  error: unknown;
  apiPath: string;
}): string {
  const { error, apiPath } = params;
  const parts = [`Graph path: ${apiPath}`];

  const statusCode = getGraphStatusCode(error);
  if (statusCode !== null) {
    parts.push(`status: ${statusCode}`);
  }

  const graphCode = getGraphCode(error);
  if (graphCode) {
    parts.push(`code: ${graphCode}`);
  }

  const requestId = getGraphRequestId(error);
  if (requestId) {
    parts.push(`request-id: ${requestId}`);
  }

  const clientRequestId = getGraphClientRequestId(error);
  if (clientRequestId) {
    parts.push(`client-request-id: ${clientRequestId}`);
  }

  const message = extractGraphErrorMessage(error);
  if (message) {
    parts.push(`message: ${message}`);
  }

  return parts.join("; ");
}

function extractGraphErrorMessage(error: unknown): string {
  const bodyMessage = getGraphBodyMessage(error);
  if (bodyMessage) {
    return bodyMessage;
  }

  return extractErrorMessage(error);
}

function getGraphStatusCode(error: unknown): number | null {
  const value = (error as { statusCode?: unknown })?.statusCode;
  return typeof value === "number" ? value : null;
}

function getGraphCode(error: unknown): string | null {
  const value = (error as { code?: unknown })?.code;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getGraphRequestId(error: unknown): string | null {
  const direct = (error as { requestId?: unknown })?.requestId;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }

  return getHeaderValue(error, "request-id");
}

function getGraphClientRequestId(error: unknown): string | null {
  return getHeaderValue(error, "client-request-id");
}

function getHeaderValue(error: unknown, headerName: string): string | null {
  const headers = (error as { headers?: unknown })?.headers;
  if (!headers || typeof headers !== "object" || !("get" in headers)) {
    return null;
  }

  const get = (headers as { get?: unknown }).get;
  if (typeof get !== "function") {
    return null;
  }

  const value = get.call(headers, headerName);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getGraphBodyMessage(error: unknown): string | null {
  const body = (error as { body?: unknown })?.body;
  if (typeof body !== "string" || body.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(body) as {
      message?: unknown;
      error?: { message?: unknown; innerError?: { date?: unknown } };
    };

    if (typeof parsed.message === "string" && parsed.message.length > 0) {
      return parsed.message;
    }

    const nested = parsed.error?.message;
    if (typeof nested === "string" && nested.length > 0) {
      return nested;
    }
  } catch {
    return body;
  }

  return null;
}

function buildRootChildrenUrl(
  driveId: string,
  folderPath: string | undefined,
  batchSize: number,
): string {
  const basePath = folderPath
    ? `${GRAPH_API_BASE}/drives/${driveId}/root:/${encodeGraphPath(folderPath)}:/children`
    : `${GRAPH_API_BASE}/drives/${driveId}/root/children`;

  const params = new URLSearchParams({
    $select:
      "id,name,webUrl,lastModifiedDateTime,createdDateTime,size,file,folder,parentReference",
    $orderby: "lastModifiedDateTime asc",
    $top: String(batchSize),
  });

  return `${basePath}?${params.toString()}`;
}

function buildItemChildrenUrl(
  driveId: string,
  itemId: string,
  batchSize: number,
): string {
  const params = new URLSearchParams({
    $select:
      "id,name,webUrl,lastModifiedDateTime,createdDateTime,size,file,folder,parentReference",
    $orderby: "lastModifiedDateTime asc",
    $top: String(batchSize),
  });

  return `${GRAPH_API_BASE}/drives/${driveId}/items/${itemId}/children?${params.toString()}`;
}

function buildRootSubfoldersUrl(
  driveId: string,
  folderPath: string | undefined,
  batchSize: number,
): string {
  const basePath = folderPath
    ? `${GRAPH_API_BASE}/drives/${driveId}/root:/${encodeGraphPath(folderPath)}:/children`
    : `${GRAPH_API_BASE}/drives/${driveId}/root/children`;

  const params = new URLSearchParams({
    $select: "id,folder,file",
    $top: String(batchSize),
  });

  return `${basePath}?${params.toString()}`;
}

function buildItemSubfoldersUrl(
  driveId: string,
  itemId: string,
  batchSize: number,
): string {
  const params = new URLSearchParams({
    $select: "id,folder,file",
    $top: String(batchSize),
  });

  return `${GRAPH_API_BASE}/drives/${driveId}/items/${itemId}/children?${params.toString()}`;
}

function buildSitePagesUrl(siteId: string, batchSize: number): string {
  const params = new URLSearchParams({
    $select:
      "id,name,title,webUrl,lastModifiedDateTime,createdDateTime,description",
    $orderby: "lastModifiedDateTime asc",
    $top: String(batchSize),
  });

  return `${GRAPH_API_BASE}/sites/${siteId}/pages?${params.toString()}`;
}

function isSupportedFile(name: string, supportsImages = false): boolean {
  const ext = getFileExtension(name);
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

function encodeGraphPath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
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

  // PPTX slides are stored as ppt/slides/slide1.xml, slide2.xml, etc.
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = Number.parseInt(a.match(/slide(\d+)/)?.[1] ?? "0", 10);
      const numB = Number.parseInt(b.match(/slide(\d+)/)?.[1] ?? "0", 10);
      return numA - numB;
    });

  for (const slidePath of slideFiles) {
    const xml = await zip.files[slidePath].async("text");
    // Extract text from <a:t> tags (DrawingML text runs)
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
  driveId: string,
  content: string,
  mediaContent?: { mimeType: string; data: string },
): ConnectorDocument {
  const title = item.name;
  const fullContent = content ? `# ${title}\n\n${content}` : `# ${title}`;

  return {
    id: item.id,
    title,
    // For media-only documents, store the title as the text content so
    // the document record is human-readable in the UI.
    content: mediaContent && !content.trim() ? `# ${title}` : fullContent,
    sourceUrl: item.webUrl,
    metadata: {
      driveId,
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

function sitePageToDocument(
  page: SitePage,
  siteId: string,
  content: string,
): ConnectorDocument {
  const title = page.title || page.name;
  const fullContent = content ? `# ${title}\n\n${content}` : `# ${title}`;

  return {
    id: `page-${page.id}`,
    title,
    content: fullContent,
    sourceUrl: page.webUrl,
    metadata: {
      siteId,
      pageId: page.id,
      pageName: page.name,
      description: page.description,
      lastModifiedDateTime: page.lastModifiedDateTime,
      createdDateTime: page.createdDateTime,
    },
    updatedAt: new Date(page.lastModifiedDateTime),
  };
}
