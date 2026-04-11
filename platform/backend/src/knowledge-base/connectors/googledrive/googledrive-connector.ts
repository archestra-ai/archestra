import { google, type drive_v3 } from "googleapis";
import type { ModelInputModality } from "@shared";
import mammoth from "mammoth";
import JSZip from "jszip";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  GoogleDriveCheckpoint,
  GoogleDriveConfig,
} from "@/types";
import { GoogleDriveConfigSchema } from "@/types";
import { stripHtmlTags } from "@/utils/strip-html";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";

const DEFAULT_BATCH_SIZE = 50;
const MAX_CONTENT_LENGTH = 500_000; // 500 KB text limit per document
const MAX_IMAGE_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB image size limit
const INCREMENTAL_SAFETY_BUFFER_MS = 5 * 60 * 1000;
const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

// Google Workspace MIME types and their export targets
const GOOGLE_WORKSPACE_EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

// Regular text file MIME types we can read directly
const SUPPORTED_TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "text/xml",
  "text/html",
  "text/x-log",
  "application/yaml",
]);

// File extensions whose MIME types are extractable as binary
const SUPPORTED_BINARY_EXTENSIONS = new Set([".docx", ".pdf", ".pptx"]);

// Image MIME types supported for multimodal embedding
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

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
      const config = parseGoogleDriveConfig(params.config);
      if (!config) {
        return { success: false, error: "Invalid configuration" };
      }

      const drive = buildDriveClient(params.credentials);
      await drive.files.list({ pageSize: 1, fields: "files(id)" });

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
    embeddingInputModalities?: ModelInputModality[];
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
    const supportsImages =
      params.embeddingInputModalities?.includes("image") ?? false;

    const drive = buildDriveClient(params.credentials);

    // Track monotonic high-water mark across all sync phases
    const progress = {
      maxLastModified: checkpoint.lastSyncedAt as string | undefined,
    };

    this.log.debug(
      {
        sharedDriveIds: parsed.sharedDriveIds,
        folderId: parsed.folderId,
        syncFrom,
        supportsImages,
      },
      "Starting Google Drive sync",
    );

    // Phase 1: sync My Drive (or folder within it)
    yield* this.syncDriveFiles({
      drive,
      config: parsed,
      progress,
      syncFrom: safetyBufferedSyncFrom,
      batchSize,
      supportsImages,
      driveId: undefined,
    });

    // Phase 2: sync shared drives
    if (parsed.sharedDriveIds && parsed.sharedDriveIds.length > 0) {
      for (const sharedDriveId of parsed.sharedDriveIds) {
        yield* this.syncDriveFiles({
          drive,
          config: parsed,
          progress,
          syncFrom: safetyBufferedSyncFrom,
          batchSize,
          supportsImages,
          driveId: sharedDriveId,
        });
      }
    }
  }

  // ===== Private methods =====

  private async *syncDriveFiles(params: {
    drive: ReturnType<typeof buildDriveClient>;
    config: GoogleDriveConfig;
    progress: { maxLastModified: string | undefined };
    syncFrom: string | undefined;
    batchSize: number;
    supportsImages: boolean;
    driveId: string | undefined;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { drive, config, progress, syncFrom, batchSize, supportsImages, driveId } =
      params;

    let nextPageToken: string | undefined;
    let batchIndex = 0;

    do {
      await this.rateLimit();

      const listParams = buildListParams({
        batchSize,
        folderId: config.folderId,
        syncFrom,
        driveId,
        pageToken: nextPageToken,
      });

      let responseData: drive_v3.Schema$FileList;
      try {
        const response = await drive.files.list(listParams);
        responseData = response.data;
      } catch (error) {
        throw new Error(
          `Google Drive files.list failed: ${extractErrorMessage(error)}`,
        );
      }

      const files = responseData.files ?? [];
      nextPageToken = responseData.nextPageToken ?? undefined;
      const hasMore = !!nextPageToken;

      const documents: ConnectorDocument[] = [];

      for (const file of files) {
        if (!file.id || !file.name || !file.mimeType) continue;
        if (!isSupportedFile(file.mimeType, supportsImages)) continue;

        const doc = await this.safeItemFetch({
          fetch: async () => {
            const result = await this.fetchFileData(
              drive,
              file.id!,
              file.name!,
              file.mimeType!,
            );
            if (!result.text.trim() && !result.mediaContent) return null;
            return buildDocument(file, result.text, result.mediaContent);
          },
          fallback: null,
          itemId: file.id,
          resource: "driveFile",
        });
        if (doc) documents.push(doc);

        const modifiedTime = file.modifiedTime;
        if (
          modifiedTime &&
          (!progress.maxLastModified || modifiedTime > progress.maxLastModified)
        ) {
          progress.maxLastModified = modifiedTime;
        }
      }

      batchIndex++;
      this.log.debug(
        {
          driveId: driveId ?? "my-drive",
          batchIndex,
          fileCount: files.length,
          documentCount: documents.length,
          hasMore,
        },
        "Google Drive batch done",
      );

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "googledrive",
          itemUpdatedAt: progress.maxLastModified
            ? new Date(progress.maxLastModified)
            : undefined,
          previousLastSyncedAt: progress.maxLastModified,
        }),
        hasMore,
      };
    } while (nextPageToken);
  }

  private async fetchFileData(
    drive: ReturnType<typeof buildDriveClient>,
    fileId: string,
    fileName: string,
    mimeType: string,
  ): Promise<{
    text: string;
    mediaContent?: { mimeType: string; data: string };
  }> {
    // Google Workspace documents: export as text
    const exportMime = GOOGLE_WORKSPACE_EXPORT_MIME[mimeType];
    if (exportMime) {
      try {
        const response = (await drive.files.export({
          fileId,
          mimeType: exportMime,
        })) as { data: string };
        const text = String(response.data ?? "");
        return { text: text.slice(0, MAX_CONTENT_LENGTH) };
      } catch (error) {
        throw new Error(
          `Export failed for ${fileName}: ${extractErrorMessage(error)}`,
        );
      }
    }

    // Image files: download as base64 for multimodal embedding
    if (SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
      const buffer = await this.downloadFileBuffer(drive, fileId, fileName);
      if (buffer.byteLength > MAX_IMAGE_SIZE_BYTES) {
        this.log.debug(
          { fileName, sizeBytes: buffer.byteLength },
          "Google Drive: skipping oversized image",
        );
        return { text: "" };
      }
      const data = Buffer.from(buffer).toString("base64");
      return { text: "", mediaContent: { mimeType, data } };
    }

    // Plain text files: download and read as UTF-8
    if (SUPPORTED_TEXT_MIME_TYPES.has(mimeType)) {
      const buffer = await this.downloadFileBuffer(drive, fileId, fileName);
      const text = Buffer.from(buffer)
        .toString("utf-8")
        .slice(0, MAX_CONTENT_LENGTH);
      return { text };
    }

    // Binary files (.docx, .pdf, .pptx): extract text
    const ext = getFileExtension(fileName);
    if (SUPPORTED_BINARY_EXTENSIONS.has(ext)) {
      const buffer = await this.downloadFileBuffer(drive, fileId, fileName);
      const text = await extractTextFromBinary(Buffer.from(buffer), ext);
      return { text: text.slice(0, MAX_CONTENT_LENGTH) };
    }

    this.log.debug(
      { fileName, mimeType },
      "Google Drive: skipping unsupported file type",
    );
    return { text: "" };
  }

  private async downloadFileBuffer(
    drive: ReturnType<typeof buildDriveClient>,
    fileId: string,
    fileName: string,
  ): Promise<ArrayBuffer> {
    try {
      const response = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" },
      );
      return response.data as ArrayBuffer;
    } catch (error) {
      throw new Error(
        `Download failed for ${fileName}: ${extractErrorMessage(error)}`,
      );
    }
  }
}

// ===== Module-level helpers =====

function buildDriveClient(credentials: ConnectorCredentials) {
  const auth = new google.auth.JWT({
    email: credentials.email,
    key: credentials.apiToken,
    scopes: [DRIVE_READONLY_SCOPE],
  });
  return google.drive({ version: "v3", auth });
}

function parseGoogleDriveConfig(
  config: Record<string, unknown>,
): GoogleDriveConfig | null {
  const result = GoogleDriveConfigSchema.safeParse({
    type: "googledrive",
    ...config,
  });
  return result.success ? result.data : null;
}

function subtractSafetyBuffer(isoDate: string): string {
  return new Date(
    new Date(isoDate).getTime() - INCREMENTAL_SAFETY_BUFFER_MS,
  ).toISOString();
}

function buildListParams(params: {
  batchSize: number;
  folderId: string | undefined;
  syncFrom: string | undefined;
  driveId: string | undefined;
  pageToken: string | undefined;
}): drive_v3.Params$Resource$Files$List {
  const { batchSize, folderId, syncFrom, driveId, pageToken } = params;

  const qParts: string[] = [
    "trashed=false",
    "mimeType != 'application/vnd.google-apps.folder'",
  ];

  if (folderId) {
    qParts.push(`'${folderId}' in parents`);
  }

  if (syncFrom) {
    qParts.push(`modifiedTime >= '${syncFrom}'`);
  }

  const listParams: drive_v3.Params$Resource$Files$List = {
    q: qParts.join(" and "),
    fields:
      "nextPageToken, files(id, name, mimeType, webViewLink, modifiedTime, createdTime, size, parents)",
    pageSize: batchSize,
    orderBy: "modifiedTime",
  };

  if (pageToken) {
    listParams.pageToken = pageToken;
  }

  if (driveId) {
    listParams.driveId = driveId;
    listParams.corpora = "drive";
    listParams.includeItemsFromAllDrives = true;
    listParams.supportsAllDrives = true;
  }

  return listParams;
}

function isSupportedFile(mimeType: string, supportsImages = false): boolean {
  if (mimeType in GOOGLE_WORKSPACE_EXPORT_MIME) return true;
  if (SUPPORTED_TEXT_MIME_TYPES.has(mimeType)) return true;
  if (supportsImages && SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) return true;

  // Check binary extensions by MIME type
  const binaryMimes = new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ]);
  return binaryMimes.has(mimeType);
}

function getFileExtension(name: string): string {
  const lastDot = name.lastIndexOf(".");
  if (lastDot < 0) return "";
  return name.slice(lastDot).toLowerCase();
}

function buildDocument(
  file: drive_v3.Schema$File,
  content: string,
  mediaContent?: { mimeType: string; data: string },
): ConnectorDocument {
  const title = file.name ?? file.id ?? "Untitled";
  const fullContent = content ? `# ${title}\n\n${content}` : `# ${title}`;

  return {
    id: file.id ?? "",
    title,
    content: mediaContent && !content.trim() ? `# ${title}` : fullContent,
    sourceUrl: file.webViewLink ?? undefined,
    metadata: {
      fileId: file.id,
      fileName: file.name,
      mimeType: file.mimeType,
      size: file.size,
      modifiedTime: file.modifiedTime,
      createdTime: file.createdTime,
      parents: file.parents,
    },
    updatedAt: file.modifiedTime ? new Date(file.modifiedTime) : undefined,
    mediaContent,
  };
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
      const pdfParse = (await import("pdf-parse")).default;
      const result = await pdfParse(buffer);
      return result.text;
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
