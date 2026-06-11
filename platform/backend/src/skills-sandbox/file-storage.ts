import config from "@/config";
import type {
  SandboxArtifactRow,
  SandboxFileListItem,
  SandboxFolderListItem,
  SkillSandboxFile,
} from "@/types";
import {
  FilesystemSandboxFileStorage,
  SandboxFileMissingError,
} from "./file-storage-filesystem";

/**
 * Storage for sandbox file bytes (`skill_sandbox_files`), behind one router:
 *
 *   - `put` dispatches on file kind first: uploads ALWAYS go to the db
 *     provider — replay re-reads them on every container rebuild, so they
 *     must outlive anything a user can do to the storage folder. Artifacts
 *     follow the CONFIGURED provider
 *     (ARCHESTRA_SKILLS_SANDBOX_FILE_STORAGE_PROVIDER; default `db` = bytea).
 *   - `get` resolves PER ROW via `storage_provider`, so rows written before a
 *     config change keep reading from where their bytes actually are.
 *   - `delete` only ever has external bytes to remove (db rows die with the
 *     row via ON DELETE CASCADE).
 *   - `listUserFiles` / `ensureFolderDir` / `readUserFile` follow the
 *     configured provider: they describe the user's PFS as it is NOW.
 *
 * See docs/superpowers/specs/2026-06-07-sandbox-file-storage-design.md and
 * docs/superpowers/specs/2026-06-11-xfiles-pfs-extensions-design.md.
 */
interface SandboxFileStorage {
  readonly name: "db" | "filesystem" | "router";

  /** Persist bytes for a new file row. Exactly one of objectKey/dbData is set. */
  put(params: {
    /** Sandbox owner — names the per-user folder of the filesystem provider. */
    userId: string;
    fileId: string;
    kind: "upload" | "artifact";
    filename: string;
    data: Buffer;
    /** PFS folder (validated name) the file lands in; null/omitted = root. */
    folder?: string | null;
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

  /**
   * List a user's PFS: folders and artifact files. `rows`/`folderRows` are the
   * storage-agnostic metadata the models already fetched; the db provider
   * returns them as the listing, the filesystem provider treats the on-disk
   * directory tree (one level deep) as the source of truth.
   */
  listUserFiles(params: {
    userId: string;
    rows: SandboxArtifactRow[];
    folderRows: { id: string; name: string; createdAt: Date }[];
  }): Promise<{
    folders: SandboxFolderListItem[];
    files: SandboxFileListItem[];
  }>;

  /**
   * Make sure a (validated) folder name exists as a real directory where that
   * matters. Filesystem: mkdir, adopting an existing hand-made directory.
   * Db: no-op — the `skill_sandbox_folders` row is the only representation.
   */
  ensureFolderDir(params: { userId: string; name: string }): Promise<void>;

  /**
   * Read a PFS file's bytes by location instead of by row — the only way to
   * reach an orphan (a filesystem file with no `skill_sandbox_files` row).
   * Throws {@link SandboxFileMissingError} when nothing is there, including
   * always under the db provider (orphans cannot exist in db mode).
   */
  readUserFile(params: {
    userId: string;
    folder: string | null;
    filename: string;
  }): Promise<Buffer>;
}

/** Where a new file's bytes were persisted. */
interface StoredSandboxBlob {
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

  async put(
    params: Parameters<SandboxFileStorage["put"]>[0],
  ): Promise<StoredSandboxBlob> {
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

  async listUserFiles(
    params: Parameters<SandboxFileStorage["listUserFiles"]>[0],
  ): Promise<{
    folders: SandboxFolderListItem[];
    files: SandboxFileListItem[];
  }> {
    // the rows ARE the listing — there is no directory to reconcile against.
    return {
      folders: params.folderRows.map((f) => ({
        id: f.id,
        name: f.name,
        createdAt: f.createdAt,
      })),
      files: params.rows.map((row) => ({
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        createdAt: row.createdAt,
        downloadable: true,
        folder: row.folderName,
      })),
    };
  }

  async ensureFolderDir(_params: {
    userId: string;
    name: string;
  }): Promise<void> {}

  async readUserFile(
    params: Parameters<SandboxFileStorage["readUserFile"]>[0],
  ): Promise<Buffer> {
    // orphans cannot exist in db mode; row-backed files are read via get().
    throw new SandboxFileMissingError(
      params.folder ? `${params.folder}/${params.filename}` : params.filename,
    );
  }
}

class SandboxFileStorageRouter implements SandboxFileStorage {
  readonly name = "router" as const;

  // filesystem provider is constructed lazily so a `db`-configured deployment
  // never touches the storage path (which is undefined there).
  private filesystem: FilesystemSandboxFileStorage | null = null;

  async put(
    params: Parameters<SandboxFileStorage["put"]>[0],
  ): Promise<StoredSandboxBlob> {
    // uploads are replay inputs: replay must re-read them for every container
    // rebuild, so they live in Postgres regardless of the configured provider.
    if (params.kind === "upload") {
      return dbProvider.put(params);
    }
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

  async listUserFiles(
    params: Parameters<SandboxFileStorage["listUserFiles"]>[0],
  ): Promise<{
    folders: SandboxFolderListItem[];
    files: SandboxFileListItem[];
  }> {
    if (config.skillsSandbox.fileStorage.provider === "filesystem") {
      return this.getFilesystem().listUserFiles(params);
    }
    return dbProvider.listUserFiles(params);
  }

  async ensureFolderDir(params: {
    userId: string;
    name: string;
  }): Promise<void> {
    if (config.skillsSandbox.fileStorage.provider === "filesystem") {
      return this.getFilesystem().ensureFolderDir(params);
    }
    return dbProvider.ensureFolderDir(params);
  }

  async readUserFile(
    params: Parameters<SandboxFileStorage["readUserFile"]>[0],
  ): Promise<Buffer> {
    if (config.skillsSandbox.fileStorage.provider === "filesystem") {
      return this.getFilesystem().readUserFile(params);
    }
    return dbProvider.readUserFile(params);
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
