import config from "@/config";
import type { SkillSandboxFile } from "@/types";
import { FilesystemSandboxFileStorage } from "./file-storage-filesystem";

/**
 * Storage for sandbox file bytes (`skill_sandbox_files`), behind one router:
 *
 *   - `put` writes through the CONFIGURED provider
 *     (ARCHESTRA_SKILLS_SANDBOX_FILE_STORAGE_PROVIDER; default `db` = bytea).
 *   - `get` resolves PER ROW via `storage_provider`, so rows written before a
 *     config change keep reading from where their bytes actually are.
 *   - `delete` only ever has external bytes to remove (db rows die with the
 *     row via ON DELETE CASCADE).
 *
 * See docs/superpowers/specs/2026-06-07-sandbox-file-storage-design.md.
 */
export interface SandboxFileStorage {
  readonly name: "db" | "filesystem" | "router";

  /** Persist bytes for a new file row. Exactly one of objectKey/dbData is set. */
  put(params: {
    sandboxId: string;
    fileId: string;
    kind: "upload" | "artifact";
    filename: string;
    data: Buffer;
  }): Promise<StoredSandboxBlob>;

  /** Read a file row's bytes, normalized to a Buffer. */
  get(file: SkillSandboxFile): Promise<Buffer>;

  /**
   * Remove a file's externally-stored bytes. Resolves per blob like `get`
   * resolves per row: db blobs are a no-op (their bytes die with the row via
   * ON DELETE CASCADE), filesystem blobs unlink their object key.
   */
  delete(blob: {
    provider: "db" | "filesystem";
    objectKey: string | null;
  }): Promise<void>;
}

/** Where a new file's bytes were persisted. */
export interface StoredSandboxBlob {
  provider: "db" | "filesystem";
  objectKey: string | null;
  dbData: Buffer | null;
}

export function getSandboxFileStorage(): SandboxFileStorage {
  return router;
}

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

// === internal ===

/** Passthrough: bytes live in `skill_sandbox_files.data`, exactly as before. */
class DbSandboxFileStorage implements SandboxFileStorage {
  readonly name = "db" as const;

  async put(params: {
    sandboxId: string;
    fileId: string;
    kind: "upload" | "artifact";
    filename: string;
    data: Buffer;
  }): Promise<StoredSandboxBlob> {
    return { provider: "db", objectKey: null, dbData: params.data };
  }

  async get(file: SkillSandboxFile): Promise<Buffer> {
    if (file.data == null) {
      throw new Error(
        `sandbox file ${file.id} has storage_provider 'db' but no data bytes`,
      );
    }
    // pg returns bytea as Buffer; PGlite returns Uint8Array. Callers rely on
    // Buffer semantics, so normalize at the read boundary.
    if (Buffer.isBuffer(file.data)) return file.data;
    return Buffer.from(file.data as unknown as Uint8Array);
  }

  async delete(_blob: {
    provider: "db" | "filesystem";
    objectKey: string | null;
  }): Promise<void> {}
}

class SandboxFileStorageRouter implements SandboxFileStorage {
  readonly name = "router" as const;

  // filesystem provider is constructed lazily so a `db`-configured deployment
  // never touches the storage path (which is undefined there).
  private filesystem: FilesystemSandboxFileStorage | null = null;

  async put(
    params: Parameters<SandboxFileStorage["put"]>[0],
  ): Promise<StoredSandboxBlob> {
    if (config.skillsSandbox.fileStorage.provider === "filesystem") {
      return this.getFilesystem().put(params);
    }
    return dbProvider.put(params);
  }

  async get(file: SkillSandboxFile): Promise<Buffer> {
    if (file.storageProvider === "filesystem") {
      return this.getFilesystem().get(file);
    }
    return dbProvider.get(file);
  }

  async delete(blob: {
    provider: "db" | "filesystem";
    objectKey: string | null;
  }): Promise<void> {
    // per-blob dispatch, mirroring get's per-row dispatch: db bytes live in
    // the row (nothing external to remove), filesystem bytes get unlinked.
    if (blob.provider !== "filesystem" || !blob.objectKey) return;
    return this.getFilesystem().delete(blob.objectKey);
  }

  private getFilesystem(): FilesystemSandboxFileStorage {
    const root = config.skillsSandbox.fileStorage.path;
    if (!root) {
      throw new Error(
        "sandbox filesystem storage requires ARCHESTRA_SKILLS_SANDBOX_FILE_STORAGE_PATH",
      );
    }
    // re-create when the root changes (config is mutated in tests)
    if (!this.filesystem || this.filesystemRoot !== root) {
      this.filesystem = new FilesystemSandboxFileStorage(root);
      this.filesystemRoot = root;
    }
    return this.filesystem;
  }

  private filesystemRoot: string | null = null;
}

const dbProvider = new DbSandboxFileStorage();
const router = new SandboxFileStorageRouter();
