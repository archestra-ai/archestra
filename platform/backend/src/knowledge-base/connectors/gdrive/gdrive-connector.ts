import type { ModelInputModality } from "@archestra/shared";
import type { drive_v3 } from "googleapis";
import { google } from "googleapis";
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
import { extractTextFromDocx } from "../docx-text-extractor";
import {
  type FolderTraversalAdapter,
  traverseFolders,
} from "../folder-traversal";
import { parsePdfBuffer } from "../pdf-utils";
import { extractTextFromPptx } from "../pptx-text-extractor";
import { extractTextFromXlsx } from "../xlsx-text-extractor";

const DEFAULT_BATCH_SIZE = 50;
const MAX_CONTENT_LENGTH = 500_000; // 500 KB text limit per document
const MAX_IMAGE_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB image size limit
const INCREMENTAL_SAFETY_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_MAX_DEPTH = 50; // Safety limit for recursive folder traversal

// File extensions whose text content we can extract via direct download
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

// Binary formats we can extract text from with libraries. Keyed by the
// canonical mimeType Drive reports so a file is recognized by what it IS, even
// when its name has no extension; the extension is only a fallback.
type BinaryFormat = ".pdf" | ".docx" | ".pptx" | ".xlsx";
const BINARY_MIME_TYPES: Record<string, BinaryFormat> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    ".pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};

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

// Image mimeTypes we support (mirror of IMAGE_MIME_TYPES values) — lets us
// recognize images by mimeType, not just by filename extension.
const SUPPORTED_IMAGE_MIME_TYPES = new Set(Object.values(IMAGE_MIME_TYPES));

// Google Workspace native files exported as plain text (one logical document).
const GOOGLE_DOC_MIME_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
};

// Google Workspace native files exported as a binary Office format instead of
// text, then run through the same extractor as an uploaded file. A Google Sheet
// exported as CSV is only its FIRST sheet, so export .xlsx and read every sheet.
const GOOGLE_BINARY_EXPORTS: Record<
  string,
  { exportMimeType: string; format: BinaryFormat }
> = {
  "application/vnd.google-apps.spreadsheet": {
    exportMimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    format: ".xlsx",
  },
};

/** Narrowed Drive file type – the fields listed in our $select queries. */
interface DriveFile {
  id: string | null | undefined;
  name: string | null | undefined;
  mimeType: string | null | undefined;
  modifiedTime: string | null | undefined;
  createdTime: string | null | undefined;
  owners?: Array<{ emailAddress?: string | null }>;
  webViewLink: string | null | undefined;
  parents: string[] | null | undefined;
  size: string | null | undefined;
}

/** Response shape from `drive.files.list`. */
interface FileListResponse {
  data: {
    files?: DriveFile[];
    nextPageToken?: string | null;
  };
}

export class GoogleDriveConnector extends BaseConnector {
  type = "gdrive" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseGDriveConfig(config);
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
      const config = parseGDriveConfig(params.config);
      if (!config) {
        return { success: false, error: "Invalid configuration" };
      }

      const drive = this.getDriveClient(params.credentials);

      // Attempt a lightweight API call to verify credentials
      await drive.about.get({ fields: "user" });

      this.log.debug("Google Drive connection test successful");
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "Google Drive connection test failed");
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseGDriveConfig(params.config);
    if (!parsed) return null;

    try {
      const checkpoint =
        (params.checkpoint as GoogleDriveCheckpoint | null) ?? {
          type: "gdrive" as const,
        };
      const syncFrom = checkpoint.lastSyncedAt;
      const safetyBufferedSyncFrom = syncFrom
        ? subtractSafetyBuffer(syncFrom)
        : undefined;

      const drive = this.getDriveClient(params.credentials);
      let total = 0;

      const targetDriveIds =
        parsed.driveIds && parsed.driveIds.length > 0
          ? parsed.driveIds
          : parsed.driveId
            ? [parsed.driveId]
            : [undefined];

      for (const currentDriveId of targetDriveIds) {
        const query = buildFileQuery(parsed, safetyBufferedSyncFrom);
        let pageToken: string | undefined;
        const useSharedDriveApi = hasSharedDriveTarget({
          ...parsed,
          driveId: currentDriveId,
        });

        do {
          await this.rateLimit();
          const res = (await drive.files.list({
            q: query,
            pageSize: 1000,
            pageToken,
            fields: "nextPageToken,files(id)",
            includeItemsFromAllDrives: useSharedDriveApi,
            supportsAllDrives: useSharedDriveApi,
            ...(currentDriveId
              ? { driveId: currentDriveId, corpora: "drive" as const }
              : {}),
          })) as FileListResponse;

          total += res.data.files?.length ?? 0;
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken);
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
    const parsed = parseGDriveConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Google Drive configuration");
    }

    const checkpoint = (params.checkpoint as GoogleDriveCheckpoint | null) ?? {
      type: "gdrive" as const,
    };

    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const syncFrom = checkpoint.lastSyncedAt ?? params.startTime?.toISOString();
    const safetyBufferedSyncFrom = syncFrom
      ? subtractSafetyBuffer(syncFrom)
      : undefined;
    const supportsImages =
      params.embeddingInputModalities?.includes("image") ?? false;

    const drive = this.getDriveClient(params.credentials);

    // Track the highest modifiedTime seen across all yielded batches
    // so the checkpoint only advances monotonically.
    const progress = {
      maxLastModified: checkpoint.lastSyncedAt as string | undefined,
    };

    this.log.debug(
      {
        driveId: parsed.driveId,
        driveIds: parsed.driveIds,
        folderId: parsed.folderId,
        useSharedDriveApi: hasSharedDriveTarget(parsed),
        recursive: parsed.recursive,
        syncFrom,
        supportsImages,
      },
      "Starting Google Drive sync",
    );

    if (parsed.folderId) {
      // Folder-scoped mode — recursive defaults to true
      yield* this.syncFolder({
        drive,
        folderId: parsed.folderId,
        config: parsed,
        progress,
        syncFrom: safetyBufferedSyncFrom,
        batchSize,
        supportsImages,
        recursive: parsed.recursive ?? true,
        maxDepth: parsed.maxDepth ?? DEFAULT_MAX_DEPTH,
      });
    } else {
      // Drive listing mode
      const targetDriveIds =
        parsed.driveIds && parsed.driveIds.length > 0
          ? parsed.driveIds
          : parsed.driveId
            ? [parsed.driveId]
            : [undefined];

      for (const currentDriveId of targetDriveIds) {
        yield* this.syncDriveFiles({
          drive,
          config: { ...parsed, driveId: currentDriveId },
          progress,
          syncFrom: safetyBufferedSyncFrom,
          batchSize,
          supportsImages,
        });
      }
    }
  }

  // ===== Private methods =====

  private getDriveClient(credentials: ConnectorCredentials): drive_v3.Drive {
    // Google Drive uses the apiToken as the OAuth2 access token or service
    // account key. For service account JSON keys, parse and use JWT auth.
    // For simple API tokens / OAuth tokens, use as bearer.
    try {
      // Attempt to parse as a service account JSON key
      const keyData = JSON.parse(credentials.apiToken) as Record<
        string,
        unknown
      >;
      const auth = new google.auth.GoogleAuth({
        credentials: keyData,
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      });
      return google.drive({ version: "v3", auth });
    } catch {
      // Not JSON — treat as an OAuth2 access token
      const auth = new google.auth.OAuth2();
      auth.setCredentials({ access_token: credentials.apiToken });
      return google.drive({ version: "v3", auth });
    }
  }

  private async *syncDriveFiles(params: {
    drive: drive_v3.Drive;
    config: GoogleDriveConfig;
    progress: { maxLastModified: string | undefined };
    syncFrom: string | undefined;
    batchSize: number;
    supportsImages: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { drive, config, progress, syncFrom, batchSize, supportsImages } =
      params;
    const useSharedDriveApi = hasSharedDriveTarget(config);

    const query = buildFileQuery(config, syncFrom);
    let pageToken: string | undefined;
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      let res: FileListResponse;
      try {
        res = (await drive.files.list({
          q: query,
          pageSize: batchSize,
          pageToken,
          fields:
            "nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,owners,webViewLink,parents,size)",
          orderBy: "modifiedTime asc",
          includeItemsFromAllDrives: useSharedDriveApi,
          supportsAllDrives: useSharedDriveApi,
          ...(config.driveId
            ? { driveId: config.driveId, corpora: "drive" as const }
            : {}),
        })) as FileListResponse;
      } catch (error) {
        throw new Error(
          `Google Drive files query failed: ${extractErrorMessage(error)}`,
        );
      }

      // Partition the page into files we can ingest and files whose type is not
      // ingestable. The latter are tracked as skipped (not silently dropped) so
      // the run reports "N found, M imported, K unsupported" — otherwise the
      // total counts every Drive file but only supported types are imported.
      const allFiles = res.data.files ?? [];
      const files: DriveFile[] = [];
      for (const file of allFiles) {
        if (isSupportedFile(file, supportsImages)) {
          files.push(file);
        } else {
          this.trackSkipped({
            itemId: file.id ?? "unknown",
            name: file.name ?? "unknown",
            reason: "unsupported_file_type",
          });
        }
      }

      const documents: ConnectorDocument[] = [];

      for (const file of files) {
        const doc = await this.safeItemFetch({
          fetch: async () => {
            const result = await this.downloadFileContent(
              drive,
              file,
              supportsImages,
            );
            // Skip files with no extractable content or media to avoid indexing
            // title-only documents that provide no search value.
            if (!result.text.trim() && !result.mediaContent) return null;
            return fileToDocument(file, result.text, result.mediaContent);
          },
          fallback: null,
          itemId: file.id ?? "unknown",
          resource: "driveFile",
        });
        if (doc) documents.push(doc);
      }

      // Advance the monotonic high-water mark using all results (not just
      // filtered ones) so the checkpoint moves past unsupported files.
      const lastFile = allFiles[allFiles.length - 1];
      const lastModified = lastFile?.modifiedTime;

      if (
        lastModified &&
        (!progress.maxLastModified || lastModified > progress.maxLastModified)
      ) {
        progress.maxLastModified = lastModified;
      }

      pageToken = res.data.nextPageToken ?? undefined;
      hasMore = !!pageToken;

      batchIndex++;
      this.log.debug(
        {
          batchIndex,
          fileCount: files.length,
          documentCount: documents.length,
          hasMore,
        },
        "Google Drive files batch done",
      );

      yield {
        documents,
        failures: this.flushFailures(),
        skipped: this.flushSkipped(),
        checkpoint: buildCheckpoint({
          type: "gdrive",
          itemUpdatedAt: progress.maxLastModified
            ? new Date(progress.maxLastModified)
            : undefined,
          previousLastSyncedAt: progress.maxLastModified,
        }),
        hasMore,
      };
    }
  }

  /**
   * Folder-scoped sync using lazy breadth-first traversal.
   *
   * Instead of eagerly collecting all subfolder IDs up front (which can OOM
   * or stall on deeply nested drives), we use a BFS queue: discover direct
   * children of the current folder, enqueue them, and yield file batches
   * from each folder as we go.
   */
  private async *syncFolder(params: {
    drive: drive_v3.Drive;
    folderId: string;
    config: GoogleDriveConfig;
    progress: { maxLastModified: string | undefined };
    syncFrom: string | undefined;
    batchSize: number;
    supportsImages: boolean;
    recursive: boolean;
    maxDepth: number;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      drive,
      folderId,
      config,
      progress,
      syncFrom,
      batchSize,
      supportsImages,
      recursive,
      maxDepth,
    } = params;

    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: (parentId: string) =>
        this.listDirectSubfolders(drive, parentId, config),
    };

    const folderGen = traverseFolders(
      adapter,
      { rootFolderId: folderId, recursive, maxDepth },
      this.log,
    );

    let next = await folderGen.next();

    while (!next.done) {
      const currentFolderId = next.value;
      next = await folderGen.next();
      const hasMoreFolders = !next.done;

      yield* this.syncFilesInFolder({
        drive,
        folderId: currentFolderId,
        config,
        progress,
        syncFrom,
        batchSize,
        supportsImages,
        hasMoreFolders,
      });
    }
  }

  /**
   * Sync files within a single folder, yielding paginated batches.
   */
  private async *syncFilesInFolder(params: {
    drive: drive_v3.Drive;
    folderId: string;
    config: GoogleDriveConfig;
    progress: { maxLastModified: string | undefined };
    syncFrom: string | undefined;
    batchSize: number;
    supportsImages: boolean;
    hasMoreFolders: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      drive,
      folderId,
      config,
      progress,
      syncFrom,
      batchSize,
      supportsImages,
      hasMoreFolders,
    } = params;
    const useSharedDriveApi = hasSharedDriveTarget(config);

    // The query is identical for every page of this folder — build it once.
    let query = `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
    if (syncFrom) {
      query += ` and modifiedTime >= '${escapeDriveQueryValue(syncFrom)}'`;
    }
    if (config.fileTypes && config.fileTypes.length > 0) {
      const mimeFilters = config.fileTypes
        .map((ext) => `name contains '${escapeDriveQueryValue(ext)}'`)
        .join(" or ");
      query += ` and (${mimeFilters})`;
    }

    let pageToken: string | undefined;
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      let res: FileListResponse;
      try {
        res = (await drive.files.list({
          q: query,
          pageSize: batchSize,
          pageToken,
          fields:
            "nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,owners,webViewLink,parents,size)",
          orderBy: "modifiedTime asc",
          includeItemsFromAllDrives: useSharedDriveApi,
          supportsAllDrives: useSharedDriveApi,
        })) as FileListResponse;
      } catch (error) {
        throw new Error(
          `Google Drive folder query failed: ${extractErrorMessage(error)}`,
        );
      }

      // Partition the page into files we can ingest and files whose type is not
      // ingestable. The latter are tracked as skipped (not silently dropped) so
      // the run reports "N found, M imported, K unsupported" — otherwise the
      // total counts every Drive file but only supported types are imported.
      const allFiles = res.data.files ?? [];
      const files: DriveFile[] = [];
      for (const file of allFiles) {
        if (isSupportedFile(file, supportsImages)) {
          files.push(file);
        } else {
          this.trackSkipped({
            itemId: file.id ?? "unknown",
            name: file.name ?? "unknown",
            reason: "unsupported_file_type",
          });
        }
      }

      const documents: ConnectorDocument[] = [];

      for (const file of files) {
        const doc = await this.safeItemFetch({
          fetch: async () => {
            const result = await this.downloadFileContent(
              drive,
              file,
              supportsImages,
            );
            if (!result.text.trim() && !result.mediaContent) return null;
            return fileToDocument(file, result.text, result.mediaContent);
          },
          fallback: null,
          itemId: file.id ?? "unknown",
          resource: "driveFile",
        });
        if (doc) documents.push(doc);
      }

      const lastFile = allFiles[allFiles.length - 1];
      const lastModified = lastFile?.modifiedTime;

      if (
        lastModified &&
        (!progress.maxLastModified || lastModified > progress.maxLastModified)
      ) {
        progress.maxLastModified = lastModified;
      }

      pageToken = res.data.nextPageToken ?? undefined;
      hasMore = !!pageToken;

      batchIndex++;
      this.log.debug(
        {
          folderId,
          batchIndex,
          fileCount: files.length,
          documentCount: documents.length,
          hasMore: hasMore || hasMoreFolders,
        },
        "Google Drive folder batch done",
      );

      yield {
        documents,
        failures: this.flushFailures(),
        skipped: this.flushSkipped(),
        checkpoint: buildCheckpoint({
          type: "gdrive",
          itemUpdatedAt: progress.maxLastModified
            ? new Date(progress.maxLastModified)
            : undefined,
          previousLastSyncedAt: progress.maxLastModified,
        }),
        hasMore: hasMore || hasMoreFolders,
      };
    }
  }

  private async listDirectSubfolders(
    drive: drive_v3.Drive,
    parentId: string,
    config: GoogleDriveConfig,
  ): Promise<string[]> {
    const subfolders: string[] = [];
    let pageToken: string | undefined;
    const useSharedDriveApi = hasSharedDriveTarget(config);

    do {
      await this.rateLimit();
      const res = (await drive.files.list({
        q: `'${escapeDriveQueryValue(parentId)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        pageSize: 1000,
        pageToken,
        fields: "nextPageToken,files(id,name)",
        includeItemsFromAllDrives: useSharedDriveApi,
        supportsAllDrives: useSharedDriveApi,
      })) as FileListResponse;

      for (const folder of res.data.files ?? []) {
        if (folder.id) {
          subfolders.push(folder.id);
        }
      }

      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return subfolders;
  }

  private async downloadFileContent(
    drive: drive_v3.Drive,
    file: DriveFile,
    supportsImages: boolean,
  ): Promise<{
    text: string;
    mediaContent?: { mimeType: string; data: string };
  }> {
    const fileName = file.name ?? "";
    const fileId = file.id;
    if (!fileId) return { text: "" };

    const resolved = resolveDriveFile(file, supportsImages);

    // Google Workspace documents: export as text
    if (resolved?.kind === "google") {
      try {
        const res = await drive.files.export(
          { fileId, mimeType: resolved.exportMimeType },
          { responseType: "text" },
        );
        const text =
          typeof res.data === "string"
            ? res.data.slice(0, MAX_CONTENT_LENGTH)
            : "";
        return { text };
      } catch (error) {
        this.log.debug(
          { fileId, fileName, error: extractErrorMessage(error) },
          "Google Drive: failed to export Google Workspace file",
        );
        return { text: "" };
      }
    }

    // Google Sheets (and any other Workspace type worth exporting as Office
    // bytes): export the binary format and extract every sheet — a CSV export
    // would be the first sheet only.
    if (resolved?.kind === "google-binary") {
      try {
        const res = await drive.files.export(
          { fileId, mimeType: resolved.exportMimeType },
          { responseType: "arraybuffer" },
        );
        const buffer = Buffer.from(res.data as ArrayBuffer);
        const text = await extractTextFromBinary(buffer, resolved.format);
        return { text: text.slice(0, MAX_CONTENT_LENGTH) };
      } catch (error) {
        this.log.debug(
          { fileId, fileName, error: extractErrorMessage(error) },
          "Google Drive: failed to export Google Workspace file as Office bytes",
        );
        return { text: "" };
      }
    }

    // Plain text files: download and read as text
    if (resolved?.kind === "text") {
      const buffer = await this.downloadFileBuffer(drive, fileId);
      return {
        text: buffer.toString("utf-8").slice(0, MAX_CONTENT_LENGTH),
      };
    }

    // Binary files (.docx, .pdf, .pptx, .xlsx): download and extract text
    if (resolved?.kind === "binary") {
      const buffer = await this.downloadFileBuffer(drive, fileId);
      const text = await extractTextFromBinary(buffer, resolved.format);
      return { text: text.slice(0, MAX_CONTENT_LENGTH) };
    }

    // Image files: download as base64 for multimodal embedding
    if (resolved?.kind === "image") {
      const buffer = await this.downloadFileBuffer(drive, fileId);
      if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
        this.log.debug(
          { fileName, sizeBytes: buffer.length },
          "Google Drive: skipping oversized image",
        );
        return { text: "" };
      }
      const data = buffer.toString("base64");
      return { text: "", mediaContent: { mimeType: resolved.mimeType, data } };
    }

    this.log.debug(
      { fileName, mimeType: file.mimeType },
      "Google Drive: skipping unsupported file type",
    );
    return { text: "" };
  }

  private async downloadFileBuffer(
    drive: drive_v3.Drive,
    fileId: string,
  ): Promise<Buffer> {
    const res = await drive.files.get(
      // acknowledgeAbuse lets us download files Google has flagged as potentially
      // abusive (often false positives on a user's own drive); without it those
      // return 403 cannotDownloadAbusiveFile and the file is never indexed.
      { fileId, alt: "media", acknowledgeAbuse: true },
      { responseType: "arraybuffer" },
    );
    return Buffer.from(res.data as ArrayBuffer);
  }
}

// ===== Module-level helpers =====

function subtractSafetyBuffer(isoDate: string): string {
  return new Date(
    new Date(isoDate).getTime() - INCREMENTAL_SAFETY_BUFFER_MS,
  ).toISOString();
}

function parseGDriveConfig(
  config: Record<string, unknown>,
): GoogleDriveConfig | null {
  const result = GoogleDriveConfigSchema.safeParse({
    type: "gdrive",
    ...config,
  });
  return result.success ? result.data : null;
}

/**
 * Build the files.list query string based on config and optional sync-from date.
 */
function buildFileQuery(
  config: GoogleDriveConfig,
  syncFrom: string | undefined,
): string {
  const parts: string[] = ["trashed = false"];

  // Exclude folders — we only want files
  parts.push("mimeType != 'application/vnd.google-apps.folder'");

  // If a folderId is set, scope to direct children of that folder
  if (config.folderId) {
    parts.push(`'${escapeDriveQueryValue(config.folderId)}' in parents`);
  }

  // Incremental sync filter
  if (syncFrom) {
    parts.push(`modifiedTime >= '${escapeDriveQueryValue(syncFrom)}'`);
  }

  // File type filter
  if (config.fileTypes && config.fileTypes.length > 0) {
    const fileTypeFilters = config.fileTypes
      .map((ext) => `name contains '${escapeDriveQueryValue(ext)}'`)
      .join(" or ");
    parts.push(`(${fileTypeFilters})`);
  }

  return parts.join(" and ");
}

/**
 * Escape a value for interpolation into a Google Drive query string literal
 * (the single-quoted operand of `'<id>' in parents`, `name contains '<ext>'`,
 * etc.). Drive's grammar uses `\` as the in-string escape char, so backslashes
 * and single quotes must be escaped to keep a value from breaking out of its
 * quotes and altering the query. Folder IDs and connector config are
 * admin-authored (not end-user input), so this is defense-in-depth rather than
 * a known injection vector.
 */
function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

type ResolvedDriveFile =
  | { kind: "google"; exportMimeType: string }
  | { kind: "google-binary"; exportMimeType: string; format: BinaryFormat }
  | { kind: "binary"; format: BinaryFormat }
  | { kind: "image"; mimeType: string }
  | { kind: "text" }
  | null;

/**
 * Decide how to ingest a Drive file, keyed on its mimeType first and falling
 * back to the filename extension. Drive reliably reports mimeType, so this
 * recognizes supported files (PDFs, Office docs, images, text) even when the
 * name has no extension — which the old extension-only check silently skipped.
 * Returns null for types we cannot extract text/media from.
 */
function resolveDriveFile(
  file: DriveFile,
  supportsImages: boolean,
): ResolvedDriveFile {
  const mimeType = file.mimeType ?? "";
  const ext = getFileExtension(file.name ?? "");

  // Google Sheets export as .xlsx (a CSV export is the first sheet only), then
  // go through the same extractor as an uploaded spreadsheet.
  const binaryExport = GOOGLE_BINARY_EXPORTS[mimeType];
  if (binaryExport) return { kind: "google-binary", ...binaryExport };

  // Other Google Workspace native files are exported as text.
  const exportMimeType = GOOGLE_DOC_MIME_TYPES[mimeType];
  if (exportMimeType) return { kind: "google", exportMimeType };

  // Binary formats we extract with libraries (PDF/DOCX/PPTX/XLSX).
  const format = binaryFormatFor(mimeType, ext);
  if (format) return { kind: "binary", format };

  // Images for multimodal embedding, only when the model accepts them.
  if (supportsImages) {
    const imageMimeType = SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)
      ? mimeType
      : SUPPORTED_IMAGE_EXTENSIONS.has(ext)
        ? IMAGE_MIME_TYPES[ext]
        : undefined;
    if (imageMimeType) return { kind: "image", mimeType: imageMimeType };
  }

  // Plain-text files: any text/* mimeType, or a known text extension.
  if (mimeType.startsWith("text/") || SUPPORTED_TEXT_EXTENSIONS.has(ext)) {
    return { kind: "text" };
  }

  return null;
}

function isSupportedFile(file: DriveFile, supportsImages: boolean): boolean {
  return resolveDriveFile(file, supportsImages) !== null;
}

function binaryFormatFor(mimeType: string, ext: string): BinaryFormat | null {
  const byMime = BINARY_MIME_TYPES[mimeType];
  if (byMime) return byMime;
  if (ext === ".pdf" || ext === ".docx" || ext === ".pptx" || ext === ".xlsx") {
    return ext;
  }
  return null;
}

function getFileExtension(name: string): string {
  const lastDot = name.lastIndexOf(".");
  if (lastDot < 0) return "";
  return name.slice(lastDot).toLowerCase();
}

function hasSharedDriveTarget(config: GoogleDriveConfig): boolean {
  return Boolean(config.driveId) || Boolean(config.driveIds?.length);
}

function fileToDocument(
  file: DriveFile,
  content: string,
  mediaContent?: { mimeType: string; data: string },
): ConnectorDocument {
  const title = file.name ?? "Untitled";
  const fullContent = content ? `# ${title}\n\n${content}` : `# ${title}`;

  return {
    id: file.id ?? "",
    title,
    content: mediaContent && !content.trim() ? `# ${title}` : fullContent,
    sourceUrl: file.webViewLink ?? undefined,
    metadata: {
      fileId: file.id,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime,
      createdTime: file.createdTime,
      owners: file.owners?.map((o) => o.emailAddress).filter(Boolean),
      webViewLink: file.webViewLink,
      parents: file.parents,
      size: file.size ? Number(file.size) : undefined,
    },
    updatedAt: file.modifiedTime ? new Date(file.modifiedTime) : undefined,
    mediaContent,
  };
}

async function extractTextFromBinary(
  buffer: Buffer,
  format: BinaryFormat,
): Promise<string> {
  switch (format) {
    case ".docx": {
      return extractTextFromDocx(buffer);
    }
    case ".pdf": {
      return parsePdfBuffer(buffer);
    }
    case ".pptx": {
      return extractTextFromPptx(buffer);
    }
    case ".xlsx": {
      return extractTextFromXlsx(buffer);
    }
  }
}
