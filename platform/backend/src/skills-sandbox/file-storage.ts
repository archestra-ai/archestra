import type { StoredBlobRow } from "@/types";

/** Where a new file's bytes were persisted. */
interface StoredBlob {
  /** Future backends extend this union (e.g. "s3"). */
  provider: "db";
  objectKey: string | null;
  dbData: Buffer | null;
}

/**
 * Byte storage for persistent files and sandbox uploads. Postgres-only
 * today; the interface (and the per-row `storage_provider` dispatch in
 * `get`/`delete`) is the seam a future backend implements — adding one is
 * purely additive, old rows keep reading from where their bytes are.
 */
interface FileBytesStorage {
  put(params: {
    fileId: string;
    filename: string;
    data: Buffer;
  }): Promise<StoredBlob>;
  get(row: StoredBlobRow): Promise<Buffer>;
  delete(blob: { provider: string; objectKey: string | null }): Promise<void>;
}

export class FileBytesMissingError extends Error {}

/**
 * Filename a stored file is addressed by: the caller-provided original name
 * when present, else the basename of its container path.
 */
export function storageFilename(params: {
  originalName: string | null;
  path: string;
}): string {
  if (params.originalName) return params.originalName;
  const basename = params.path.split("/").filter(Boolean).pop();
  return basename || "file";
}

export function getFileBytesStorage(): FileBytesStorage {
  return dbProvider;
}

// === internal ===

class DbFileBytesStorage implements FileBytesStorage {
  async put(
    params: Parameters<FileBytesStorage["put"]>[0],
  ): Promise<StoredBlob> {
    return { provider: "db", objectKey: null, dbData: params.data };
  }

  async get(row: StoredBlobRow): Promise<Buffer> {
    // upload rows omit `storage_provider` (always db); files rows carry 'db'.
    if (row.storageProvider != null && row.storageProvider !== "db") {
      throw new Error(
        `file ${row.id} has unknown storage provider ${row.storageProvider}`,
      );
    }
    if (row.data == null) throw new FileBytesMissingError(row.id);
    // pg returns bytea as Buffer; PGlite returns Uint8Array.
    return Buffer.isBuffer(row.data)
      ? row.data
      : Buffer.from(row.data as unknown as Uint8Array);
  }

  async delete(): Promise<void> {
    // db bytes die with the row via the DELETE itself.
  }
}

const dbProvider = new DbFileBytesStorage();
