import type { files } from "dropbox";
import { Dropbox } from "dropbox";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  DropboxCheckpoint,
  DropboxConfig,
} from "@/types";
import { DropboxConfigSchema } from "@/types";
import { BaseConnector, buildCheckpoint } from "../base-connector";
import {
  type FolderTraversalAdapter,
  traverseFolders,
} from "../folder-traversal";

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_DEPTH = 50;

// Subtract 5 min from syncFrom to guard against clock skew between Dropbox
// servers and our system, so we never skip a file that was modified right
// around the checkpoint boundary.
const INCREMENTAL_SAFETY_BUFFER_MS = 5 * 60 * 1000;

// Supported file extensions for text extraction
const SUPPORTED_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".ts",
  ".js",
  ".py",
  ".json",
  ".yaml",
  ".yml",
  ".html",
  ".css",
  ".csv",
  ".xml",
  ".sh",
  ".env",
  ".toml",
  ".ini",
  ".conf",
]);

type DropboxFileMetadata = files.FileMetadataReference;
type DropboxEntry = files.ListFolderResult["entries"][number];

export class DropboxConnector extends BaseConnector {
  type = "dropbox" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    return this.validateConfigWithSchema({
      config,
      parser: parseDropboxConfig,
      label: "Dropbox",
    });
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    return this.runConnectionTest({
      label: "Dropbox",
      probe: async () => {
        const dbx = getDropboxClient(params.credentials);
        await dbx.usersGetCurrentAccount();
      },
    });
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
    const rootPath = parsed.rootPath
      ? parsed.rootPath.startsWith("/")
        ? parsed.rootPath
        : `/${parsed.rootPath}`
      : "";
    const fileTypes = parsed.fileTypes ?? [];
    const recursive = parsed.recursive ?? true;
    const maxDepth = parsed.maxDepth ?? DEFAULT_MAX_DEPTH;

    const dbx = getDropboxClient(params.credentials);

    this.log.debug(
      { rootPath, fileTypes, cursor: checkpoint.cursor },
      "Starting Dropbox sync",
    );

    if (checkpoint.cursor) {
      yield* this.syncFromCursor(
        dbx,
        checkpoint.cursor,
        checkpoint,
        batchSize,
        fileTypes,
      );
      return;
    }

    yield* this.syncFolderTree(
      dbx,
      rootPath,
      checkpoint,
      batchSize,
      fileTypes,
      recursive,
      maxDepth,
    );
  }

  // ===== Private methods =====

  private async *syncFolderTree(
    dbx: Dropbox,
    rootPath: string,
    checkpoint: DropboxCheckpoint,
    batchSize: number,
    fileTypes: string[],
    recursive: boolean,
    maxDepth: number,
  ): AsyncGenerator<ConnectorSyncBatch> {
    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: (parentPath: string) =>
        this.listSubfolderPaths(dbx, parentPath),
    };

    const folderPaths: string[] = [];
    for await (const folderPath of traverseFolders(
      adapter,
      { rootFolderId: rootPath, recursive, maxDepth },
      this.log,
    )) {
      folderPaths.push(folderPath);
    }

    // Get a root-scoped cursor before syncing so incremental sync
    // can track changes across the entire tree, not just the last folder walked.
    await this.rateLimit();
    const rootCursorResult = await dbx.filesListFolder({
      path: rootPath,
      recursive: true,
      include_deleted: false,
      include_has_explicit_shared_members: false,
    });
    const rootScopedCursor = rootCursorResult.result.cursor;

    for (let fi = 0; fi < folderPaths.length; fi++) {
      const folderPath = folderPaths[fi];
      const isLastFolder = fi === folderPaths.length - 1;

      let cursor: string | undefined;
      let hasMorePages = true;
      let batchIndex = 0;
      const pendingFiles: DropboxFileMetadata[] = [];

      while (hasMorePages) {
        await this.rateLimit();

        let entries: DropboxEntry[];
        let nextCursor: string;
        let hasMore: boolean;

        if (!cursor) {
          const result = await dbx.filesListFolder({
            path: folderPath,
            recursive: false,
            include_deleted: false,
            include_has_explicit_shared_members: false,
          });
          entries = result.result.entries;
          nextCursor = result.result.cursor;
          hasMore = result.result.has_more;
        } else {
          const result = await dbx.filesListFolderContinue({ cursor });
          entries = result.result.entries;
          nextCursor = result.result.cursor;
          hasMore = result.result.has_more;
        }

        cursor = nextCursor;
        hasMorePages = hasMore;
        pendingFiles.push(...filterFiles(entries, fileTypes));

        while (pendingFiles.length >= batchSize) {
          const batch = pendingFiles.splice(0, batchSize);
          batchIndex++;

          const { documents, lastModified } = await this.downloadBatch(
            dbx,
            batch,
            checkpoint.lastSyncedAt,
          );

          this.log.debug(
            { batchIndex, documentCount: documents.length, hasMore: true },
            "Dropbox full-sync batch done",
          );

          yield {
            documents,
            failures: this.flushFailures(),
            checkpoint: buildCheckpoint({
              type: "dropbox",
              itemUpdatedAt: lastModified,
              previousLastSyncedAt: checkpoint.lastSyncedAt,
              extra: { cursor: rootScopedCursor },
            }),
            hasMore: true,
          };
        }
      }

      const filesToProcess = pendingFiles.splice(0);
      const chunksToYield =
        filesToProcess.length > 0
          ? Math.ceil(filesToProcess.length / batchSize)
          : 1;

      for (let ci = 0; ci < chunksToYield; ci++) {
        const batch = filesToProcess.splice(0, batchSize);
        const isLastBatch = ci === chunksToYield - 1;
        batchIndex++;

        const { documents, lastModified } = await this.downloadBatch(
          dbx,
          batch,
          checkpoint.lastSyncedAt,
        );

        this.log.debug(
          {
            batchIndex,
            documentCount: documents.length,
            hasMore: !isLastFolder || !isLastBatch,
          },
          "Dropbox full-sync batch done",
        );

        yield {
          documents,
          failures: this.flushFailures(),
          checkpoint: buildCheckpoint({
            type: "dropbox",
            itemUpdatedAt: lastModified,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
            extra: { cursor: rootScopedCursor },
          }),
          hasMore: !isLastFolder || !isLastBatch,
        };
      }
    }
  }

  private async listSubfolderPaths(
    dbx: Dropbox,
    parentPath: string,
  ): Promise<string[]> {
    const subfolders: string[] = [];
    let cursor: string | undefined;

    do {
      await this.rateLimit();

      let entries: DropboxEntry[];
      let nextCursor: string;
      let hasMore: boolean;

      if (!cursor) {
        const result = await dbx.filesListFolder({
          path: parentPath,
          recursive: false,
          include_deleted: false,
        });
        entries = result.result.entries;
        nextCursor = result.result.cursor;
        hasMore = result.result.has_more;
      } else {
        const result = await dbx.filesListFolderContinue({ cursor });
        entries = result.result.entries;
        nextCursor = result.result.cursor;
        hasMore = result.result.has_more;
      }

      for (const entry of entries) {
        if (entry[".tag"] === "folder") {
          subfolders.push(
            (entry as files.FolderMetadataReference).path_display ?? "",
          );
        }
      }

      cursor = hasMore ? nextCursor : undefined;
    } while (cursor);

    return subfolders;
  }

  private async *syncFromCursor(
    dbx: Dropbox,
    savedCursor: string,
    checkpoint: DropboxCheckpoint,
    batchSize: number,
    fileTypes: string[],
  ): AsyncGenerator<ConnectorSyncBatch> {
    let cursor = savedCursor;
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      this.log.debug({ batchIndex, cursor }, "Fetching Dropbox changes batch");

      const result = await dbx.filesListFolderContinue({ cursor });
      cursor = result.result.cursor;
      hasMore = result.result.has_more;

      const files = filterFiles(result.result.entries, fileTypes);

      for (let i = 0; i < files.length; i += batchSize) {
        const batchFiles = files.slice(i, i + batchSize);
        const batchHasMore = hasMore || i + batchSize < files.length;

        const { documents, lastModified } = await this.downloadBatch(
          dbx,
          batchFiles,
        );

        batchIndex++;
        this.log.debug(
          { batchIndex, documentCount: documents.length, batchHasMore },
          "Dropbox incremental batch done",
        );

        yield {
          documents,
          failures: this.flushFailures(),
          checkpoint: buildCheckpoint({
            type: "dropbox",
            itemUpdatedAt: lastModified,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
            extra: { cursor },
          }),
          hasMore: batchHasMore,
        };
      }

      if (files.length === 0) {
        batchIndex++;
        yield {
          documents: [],
          failures: [],
          checkpoint: buildCheckpoint({
            type: "dropbox",
            itemUpdatedAt: undefined,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
            extra: { cursor },
          }),
          hasMore,
        };
      }
    }
  }

  private async downloadBatch(
    dbx: Dropbox,
    fileList: DropboxFileMetadata[],
    syncFrom?: string,
  ): Promise<{
    documents: ConnectorDocument[];
    lastModified: string | undefined;
  }> {
    const safetyBufferedSyncFrom = syncFrom
      ? subtractSafetyBuffer(syncFrom)
      : undefined;

    const documents: ConnectorDocument[] = [];
    let lastModified: string | undefined;

    for (const file of fileList) {
      if (
        safetyBufferedSyncFrom &&
        file.server_modified <= safetyBufferedSyncFrom
      ) {
        lastModified = lastModified
          ? laterOf(lastModified, file.server_modified)
          : file.server_modified;
        continue;
      }

      const doc = await this.safeItemFetch({
        fetch: async () => {
          const content = await this.downloadFile(dbx, file);
          return fileToDocument(file, content);
        },
        fallback: null,
        itemId: file.id,
        resource: "file",
      });

      if (doc) {
        documents.push(doc);
        lastModified = lastModified
          ? laterOf(lastModified, file.server_modified)
          : file.server_modified;
      }
    }

    return { documents, lastModified };
  }

  private async downloadFile(
    dbx: Dropbox,
    file: DropboxFileMetadata,
  ): Promise<string> {
    await this.rateLimit();

    const result = await dbx.filesDownload({ path: file.id });
    const fileBlob = (result.result as files.FileMetadata & { fileBlob?: Blob })
      .fileBlob;
    if (!fileBlob) return "";
    return fileBlob.text();
  }
}

// ===== Module-level helpers =====

function getDropboxClient(credentials: ConnectorCredentials): Dropbox {
  return new Dropbox({ accessToken: credentials.apiToken });
}

function parseDropboxConfig(
  config: Record<string, unknown>,
): DropboxConfig | null {
  const result = DropboxConfigSchema.safeParse({ type: "dropbox", ...config });
  return result.success ? result.data : null;
}

function filterFiles(
  entries: DropboxEntry[],
  fileTypes: string[],
): DropboxFileMetadata[] {
  return entries.filter((entry): entry is DropboxFileMetadata => {
    if (entry[".tag"] !== "file") return false;
    const file = entry as DropboxFileMetadata;
    const ext = getExtension(file.name);
    if (fileTypes.length > 0) {
      return fileTypes.includes(ext);
    }
    return SUPPORTED_EXTENSIONS.has(ext);
  });
}

function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot === -1 ? "" : filename.slice(lastDot).toLowerCase();
}

function subtractSafetyBuffer(isoDate: string): string {
  return new Date(
    new Date(isoDate).getTime() - INCREMENTAL_SAFETY_BUFFER_MS,
  ).toISOString();
}

function laterOf(a: string, b: string): string {
  return a >= b ? a : b;
}

function fileToDocument(
  file: DropboxFileMetadata,
  content: string,
): ConnectorDocument {
  return {
    id: file.id,
    title: file.name,
    content,
    sourceUrl: `https://www.dropbox.com/home${file.path_display ?? ""}`,
    metadata: {
      dropboxFileId: file.id,
      pathDisplay: file.path_display,
      serverModified: file.server_modified,
      clientModified: file.client_modified,
      size: file.size,
    },
    updatedAt: new Date(file.server_modified),
  };
}
