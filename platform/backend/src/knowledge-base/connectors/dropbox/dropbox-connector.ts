import JSZip from "jszip";
import mammoth from "mammoth";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  DropboxCheckpoint,
  DropboxConfig,
} from "@/types";
import { DropboxConfigSchema } from "@/types";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";

const DROPBOX_API_BASE = "https://api.dropboxapi.com/2";
const DROPBOX_CONTENT_BASE = "https://content.dropboxapi.com/2";
const DEFAULT_BATCH_SIZE = 50;
const MAX_CONTENT_LENGTH = 500_000; // 500 KB text limit per document
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MB download cap
const INCREMENTAL_SAFETY_BUFFER_MS = 5 * 60 * 1000;

// File extensions whose text content we can extract directly
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

/**
 * Dropbox file metadata returned by `/files/list_folder` and
 * `/files/list_folder/continue`. Only the fields we rely on are typed.
 */
interface DropboxFileEntry {
  ".tag": "file" | "folder" | "deleted";
  id?: string;
  name: string;
  path_lower?: string;
  path_display?: string;
  client_modified?: string;
  server_modified?: string;
  rev?: string;
  size?: number;
  content_hash?: string;
  /** Shared folder identifier; only set when a file lives in a shared namespace. */
  sharing_info?: {
    parent_shared_folder_id?: string;
    shared_folder_id?: string;
  };
}

interface DropboxListFolderResponse {
  entries: DropboxFileEntry[];
  cursor: string;
  has_more: boolean;
}

export class DropboxConnector extends BaseConnector {
  type = "dropbox" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseDropboxConfig(config);
    if (!parsed) {
      return { valid: false, error: "Invalid Dropbox configuration" };
    }
    // folderPath must be "" (root) or start with "/". Empty string is valid.
    if (
      parsed.folderPath &&
      parsed.folderPath !== "" &&
      !parsed.folderPath.startsWith("/")
    ) {
      return {
        valid: false,
        error: `Invalid folderPath: must be "" (root) or start with "/"`,
      };
    }
    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    this.log.debug("Testing Dropbox connection");

    try {
      const response = await this.fetchWithRetry(
        `${DROPBOX_API_BASE}/users/get_current_account`,
        {
          method: "POST",
          headers: buildHeaders(params.credentials),
          // get_current_account expects null body when using JSON content type
          body: "null",
        },
      );

      if (!response.ok) {
        const body = await response.text();
        return {
          success: false,
          error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
        };
      }

      this.log.debug("Dropbox connection test successful");
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "Dropbox connection test failed");
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
    const parsed = parseDropboxConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Dropbox configuration");
    }

    const checkpoint = (params.checkpoint as DropboxCheckpoint | null) ?? {
      type: "dropbox" as const,
    };

    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const recursive = parsed.recursive ?? true;
    // Empty string is valid for Dropbox root. Normalize missing/undefined to "".
    const folderPath = parsed.folderPath ?? "";
    const syncFrom = checkpoint.lastSyncedAt ?? params.startTime?.toISOString();
    const safetyBufferedSyncFrom = syncFrom
      ? subtractSafetyBuffer(syncFrom)
      : undefined;

    this.log.debug(
      {
        folderPath,
        recursive,
        hasCursor: Boolean(checkpoint.cursor),
        syncFrom,
      },
      "Starting Dropbox sync",
    );

    // Use the saved cursor for delta sync when available, otherwise start a
    // fresh listing. The cursor captures Dropbox's internal position and
    // only returns files changed since it was issued.
    if (checkpoint.cursor) {
      yield* this.syncFromCursor({
        config: parsed,
        credentials: params.credentials,
        checkpoint,
        cursor: checkpoint.cursor,
        batchSize,
        safetyBufferedSyncFrom,
      });
      return;
    }

    yield* this.syncFromListFolder({
      config: parsed,
      credentials: params.credentials,
      checkpoint,
      folderPath,
      recursive,
      batchSize,
      safetyBufferedSyncFrom,
    });
  }

  // ===== Private methods =====

  private async *syncFromListFolder(params: {
    config: DropboxConfig;
    credentials: ConnectorCredentials;
    checkpoint: DropboxCheckpoint;
    folderPath: string;
    recursive: boolean;
    batchSize: number;
    safetyBufferedSyncFrom: string | undefined;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      config,
      credentials,
      checkpoint,
      folderPath,
      recursive,
      batchSize,
      safetyBufferedSyncFrom,
    } = params;

    let cursor: string | undefined;
    let hasMore = true;
    let batchIndex = 0;
    let maxServerModified: string | undefined = checkpoint.lastSyncedAt;

    while (hasMore) {
      await this.rateLimit();

      const result = cursor
        ? await this.listFolderContinue(cursor, credentials)
        : await this.listFolder({
            path: folderPath,
            recursive,
            credentials,
            includeSharedFolders: config.includeSharedFolders ?? false,
          });

      const files = result.entries.filter((entry) =>
        isSupportedFileEntry(entry, config.fileTypes),
      );

      const documents: ConnectorDocument[] = [];

      for (const file of files) {
        // Post-filter: skip files unchanged since last sync.
        if (
          safetyBufferedSyncFrom &&
          file.server_modified &&
          file.server_modified <= safetyBufferedSyncFrom
        ) {
          continue;
        }

        const doc = await this.safeItemFetch({
          fetch: async () => {
            const text = await this.downloadFileText(file, credentials);
            if (!text.trim()) return null;
            return fileToDocument(file, text);
          },
          fallback: null,
          itemId: file.id ?? file.path_display ?? file.name,
          resource: "dropboxFile",
        });
        if (doc) documents.push(doc);
      }

      // Advance high-water mark across ALL entries, not just kept documents —
      // this lets the checkpoint progress past unsupported or unchanged files.
      for (const entry of result.entries) {
        if (
          entry[".tag"] === "file" &&
          entry.server_modified &&
          (!maxServerModified || entry.server_modified > maxServerModified)
        ) {
          maxServerModified = entry.server_modified;
        }
      }

      cursor = result.cursor;
      hasMore = result.has_more;

      batchIndex++;
      this.log.debug(
        {
          batchIndex,
          entryCount: result.entries.length,
          supportedCount: files.length,
          documentCount: documents.length,
          hasMore,
        },
        "Dropbox list_folder batch done",
      );

      // Persist the cursor on every batch so subsequent runs can use delta
      // sync. When the batch completes a pass, the cursor points at the
      // current tail of the change log.
      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "dropbox",
          itemUpdatedAt: maxServerModified,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
          extra: { cursor },
        }),
        hasMore,
      };
    }
  }

  private async *syncFromCursor(params: {
    config: DropboxConfig;
    credentials: ConnectorCredentials;
    checkpoint: DropboxCheckpoint;
    cursor: string;
    batchSize: number;
    safetyBufferedSyncFrom: string | undefined;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { config, credentials, checkpoint, safetyBufferedSyncFrom } = params;

    let cursor: string | undefined = params.cursor;
    let hasMore = true;
    let batchIndex = 0;
    let maxServerModified: string | undefined = checkpoint.lastSyncedAt;
    let cursorInvalid = false;

    while (hasMore && cursor) {
      await this.rateLimit();

      let result: DropboxListFolderResponse;
      try {
        result = await this.listFolderContinue(cursor, credentials);
      } catch (error) {
        // Cursor invalidation (e.g. account data migration): fall back to a
        // full listing rather than failing the sync outright. This happens
        // occasionally and is expected behaviour for Dropbox long-lived cursors.
        if (isCursorInvalidError(error)) {
          this.log.warn(
            { error: extractErrorMessage(error) },
            "Dropbox cursor invalidated, falling back to full listing",
          );
          cursorInvalid = true;
          break;
        }
        throw error;
      }

      const files = result.entries.filter((entry) =>
        isSupportedFileEntry(entry, config.fileTypes),
      );

      const documents: ConnectorDocument[] = [];

      for (const file of files) {
        // Even in cursor mode, post-filter by server_modified to skip files
        // re-surfaced by unrelated metadata changes that don't affect content.
        if (
          safetyBufferedSyncFrom &&
          file.server_modified &&
          file.server_modified <= safetyBufferedSyncFrom
        ) {
          continue;
        }

        const doc = await this.safeItemFetch({
          fetch: async () => {
            const text = await this.downloadFileText(file, credentials);
            if (!text.trim()) return null;
            return fileToDocument(file, text);
          },
          fallback: null,
          itemId: file.id ?? file.path_display ?? file.name,
          resource: "dropboxFile",
        });
        if (doc) documents.push(doc);
      }

      for (const entry of result.entries) {
        if (
          entry[".tag"] === "file" &&
          entry.server_modified &&
          (!maxServerModified || entry.server_modified > maxServerModified)
        ) {
          maxServerModified = entry.server_modified;
        }
      }

      cursor = result.cursor;
      hasMore = result.has_more;

      batchIndex++;
      this.log.debug(
        {
          batchIndex,
          entryCount: result.entries.length,
          supportedCount: files.length,
          documentCount: documents.length,
          hasMore,
        },
        "Dropbox cursor batch done",
      );

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "dropbox",
          itemUpdatedAt: maxServerModified,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
          extra: { cursor },
        }),
        hasMore,
      };
    }

    // Restart from a full listing when the cursor was invalidated.
    if (cursorInvalid) {
      const recursive = config.recursive ?? true;
      const folderPath = config.folderPath ?? "";
      yield* this.syncFromListFolder({
        config,
        credentials,
        checkpoint: { ...checkpoint, cursor: undefined },
        folderPath,
        recursive,
        batchSize: params.batchSize,
        safetyBufferedSyncFrom,
      });
    }
  }

  private async listFolder(params: {
    path: string;
    recursive: boolean;
    credentials: ConnectorCredentials;
    includeSharedFolders: boolean;
  }): Promise<DropboxListFolderResponse> {
    const { path, recursive, credentials, includeSharedFolders } = params;
    const body = {
      path,
      recursive,
      include_deleted: false,
      include_media_info: false,
      include_has_explicit_shared_members: false,
      include_mounted_folders: includeSharedFolders,
      // Page size for first call — continue calls don't take a limit.
      limit: 2000,
    };

    const response = await this.fetchWithRetry(
      `${DROPBOX_API_BASE}/files/list_folder`,
      {
        method: "POST",
        headers: buildHeaders(credentials),
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(
        `Dropbox list_folder failed with HTTP ${response.status}: ${errBody.slice(0, 200)}`,
      );
    }

    return (await response.json()) as DropboxListFolderResponse;
  }

  private async listFolderContinue(
    cursor: string,
    credentials: ConnectorCredentials,
  ): Promise<DropboxListFolderResponse> {
    const response = await this.fetchWithRetry(
      `${DROPBOX_API_BASE}/files/list_folder/continue`,
      {
        method: "POST",
        headers: buildHeaders(credentials),
        body: JSON.stringify({ cursor }),
      },
    );

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(
        `Dropbox list_folder/continue failed with HTTP ${response.status}: ${errBody.slice(0, 200)}`,
      );
    }

    return (await response.json()) as DropboxListFolderResponse;
  }

  /**
   * Download a file's content and extract text. Uses the Dropbox content
   * endpoint, which accepts the file selector via the `Dropbox-API-Arg` header.
   */
  private async downloadFileText(
    file: DropboxFileEntry,
    credentials: ConnectorCredentials,
  ): Promise<string> {
    const ext = getFileExtension(file.name);

    // Skip oversize files before downloading to avoid OOM / long transfers.
    if (typeof file.size === "number" && file.size > MAX_DOWNLOAD_BYTES) {
      this.log.debug(
        { fileName: file.name, size: file.size },
        "Dropbox: skipping oversized file",
      );
      return "";
    }

    // Select file by id when available (stable across renames), otherwise fall
    // back to path_lower which is what the Dropbox API requires.
    const pathOrId = file.id ?? file.path_lower ?? file.path_display ?? "";
    if (!pathOrId) return "";

    if (!SUPPORTED_TEXT_EXTENSIONS.has(ext) && !SUPPORTED_BINARY_EXTENSIONS.has(ext)) {
      this.log.debug(
        { fileName: file.name, ext },
        "Dropbox: unsupported file type, skipping",
      );
      return "";
    }

    const buffer = await this.downloadFileBuffer(pathOrId, credentials);

    if (SUPPORTED_TEXT_EXTENSIONS.has(ext)) {
      return buffer.toString("utf-8").slice(0, MAX_CONTENT_LENGTH);
    }

    // Binary extraction
    try {
      const text = await extractTextFromBinary(buffer, ext);
      return text.slice(0, MAX_CONTENT_LENGTH);
    } catch (error) {
      this.log.warn(
        { fileName: file.name, error: extractErrorMessage(error) },
        "Dropbox: binary text extraction failed",
      );
      return "";
    }
  }

  private async downloadFileBuffer(
    pathOrId: string,
    credentials: ConnectorCredentials,
  ): Promise<Buffer> {
    const response = await this.fetchWithRetry(
      `${DROPBOX_CONTENT_BASE}/files/download`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.apiToken}`,
          "Dropbox-API-Arg": JSON.stringify({ path: pathOrId }),
        },
      },
    );

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(
        `Dropbox download failed with HTTP ${response.status}: ${errBody.slice(0, 200)}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

// ===== Module-level helpers =====

function parseDropboxConfig(
  config: Record<string, unknown>,
): DropboxConfig | null {
  const result = DropboxConfigSchema.safeParse({
    type: "dropbox",
    ...config,
  });
  return result.success ? result.data : null;
}

function buildHeaders(
  credentials: ConnectorCredentials,
): Record<string, string> {
  return {
    Authorization: `Bearer ${credentials.apiToken}`,
    "Content-Type": "application/json",
  };
}

function subtractSafetyBuffer(isoDate: string): string {
  return new Date(
    new Date(isoDate).getTime() - INCREMENTAL_SAFETY_BUFFER_MS,
  ).toISOString();
}

function isSupportedFileEntry(
  entry: DropboxFileEntry,
  allowedExtensions: string[] | undefined,
): boolean {
  if (entry[".tag"] !== "file") return false;

  const ext = getFileExtension(entry.name);

  // When a fileTypes filter is set, it takes precedence over our default set.
  // This lets users narrow sync to e.g. just .md files.
  if (allowedExtensions && allowedExtensions.length > 0) {
    const normalized = allowedExtensions.map((e) =>
      e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`,
    );
    return normalized.includes(ext);
  }

  return (
    SUPPORTED_TEXT_EXTENSIONS.has(ext) || SUPPORTED_BINARY_EXTENSIONS.has(ext)
  );
}

function getFileExtension(name: string): string {
  const lastDot = name.lastIndexOf(".");
  if (lastDot < 0) return "";
  return name.slice(lastDot).toLowerCase();
}

function fileToDocument(
  file: DropboxFileEntry,
  content: string,
): ConnectorDocument {
  const title = file.name;
  const fullContent = content ? `# ${title}\n\n${content}` : `# ${title}`;

  // Dropbox doesn't return a direct web URL from the metadata API — construct
  // one pointing at the file's home in the Dropbox web UI when we have a path.
  const sourceUrl = file.path_display
    ? `https://www.dropbox.com/home${file.path_display}`
    : undefined;

  const updatedIso = file.server_modified ?? file.client_modified;

  return {
    id: file.id ?? file.path_lower ?? file.name,
    title,
    content: fullContent,
    sourceUrl,
    metadata: {
      dropboxId: file.id,
      pathLower: file.path_lower,
      pathDisplay: file.path_display,
      size: file.size,
      rev: file.rev,
      serverModified: file.server_modified,
      clientModified: file.client_modified,
      contentHash: file.content_hash,
      sharedFolderId: file.sharing_info?.shared_folder_id,
    },
    updatedAt: updatedIso ? new Date(updatedIso) : undefined,
  };
}

/**
 * Dropbox returns structured errors for cursor invalidation. The shape we care
 * about: `{ error_summary: "reset/..." }` — anything containing "reset"
 * indicates we must restart from a fresh `list_folder`.
 */
function isCursorInvalidError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes("reset") || msg.includes("invalid_cursor");
  }
  return false;
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
      // Lazy import: pdf-parse v1 tries to load a test file at import time.
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
        .map((text: string) => text.replace(/<[^>]*>/g, ""))
        .join(" ");
      if (slideText.trim()) parts.push(slideText.trim());
    }
  }

  return parts.join("\n\n");
}
