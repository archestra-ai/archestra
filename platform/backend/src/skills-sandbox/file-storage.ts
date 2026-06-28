import { randomUUID } from "node:crypto";
import { type Dirent, constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import config from "@/config";
import type { StoredBlobRow } from "@/types";
import { resolveWithinRoot, safeSegment, UnsafePathError } from "./file-path";
import {
  type EnumerableObjectStore,
  FileBytesMissingError,
  FilePathConflictError,
  type OwnerScope,
  type StoredObject,
  scopeFolder,
} from "./object-store";
import { buildS3Client, S3ObjectStore } from "./s3-storage";

export { FileBytesMissingError } from "./object-store";

/**
 * Filesystem byte backend + provider dispatch. The provider-agnostic seam
 * (`ObjectStore`/`EnumerableObjectStore`) lives in `./object-store`; this module
 * implements it for a mounted filesystem (`FilesystemObjectStore`), selects the
 * active backend (`objectStoreFor`/`getObjectStore`), and dispatches a row's bytes
 * per `storageProvider` via `readRowBytes`/`deleteRowBytes`. Postgres `bytea` is
 * NOT an `ObjectStore`: bytes live inline in the row, so it has no external key
 * namespace and nothing can be dropped in out of band.
 */

/**
 * Filename a stored file is addressed by: the caller-provided original name when
 * present, else the basename of its container path.
 */
export function storageFilename(params: {
  originalName: string | null;
  path: string;
}): string {
  if (params.originalName) return params.originalName;
  const basename = params.path.split("/").filter(Boolean).pop();
  return basename || "file";
}

/** The configured external store, or null when bytes live inline in Postgres. */
export function getObjectStore(): EnumerableObjectStore | null {
  return objectStoreFor(config.fileStorage.provider);
}

/** Read a row's bytes — inline (`db`) or via the row's external store. */
export async function readRowBytes(row: StoredBlobRow): Promise<Buffer> {
  const store = objectStoreFor(row.storageProvider);
  if (store) {
    if (!row.objectKey) throw new FileBytesMissingError(row.id);
    return store.read(row.objectKey);
  }
  // inline db bytes: pg returns Buffer, PGlite returns Uint8Array.
  if (row.data == null) throw new FileBytesMissingError(row.id);
  return Buffer.isBuffer(row.data)
    ? row.data
    : Buffer.from(row.data as unknown as Uint8Array);
}

/** Remove a row's external bytes; inline `db` bytes die with the row (no-op). */
export async function deleteRowBytes(blob: {
  provider: string;
  objectKey: string | null;
}): Promise<void> {
  const store = objectStoreFor(blob.provider);
  if (store && blob.objectKey) await store.remove(blob.objectKey);
}

// === internal ===

/**
 * Bytes on a mounted filesystem, laid out `<root>/<folder>/<name>` (the folder is
 * the owner's email — optionally `/conversationId` — or project slug). Writes are atomic + exclusive (temp file +
 * `link`), reads refuse symlinks (`O_NOFOLLOW`), and every path is confined to
 * the root.
 *
 * @public — constructed directly in tests against a temp root.
 */
export class FilesystemObjectStore implements EnumerableObjectStore {
  constructor(private readonly getRoot: () => string) {}

  async write(params: {
    scope: OwnerScope;
    name: string;
    data: Buffer;
    overwrite?: boolean;
  }): Promise<{ key: string }> {
    const root = this.getRoot();
    const folder = scopeFolder(params.scope);
    const filename = safeSegment(params.name);
    const key = `${folder}/${filename}`;
    const finalPath = resolveWithinRoot(root, ...folder.split("/"), filename);
    const dir = path.dirname(finalPath);
    await fs.mkdir(dir, { recursive: true });
    // the owner folder itself must not be a symlink escaping the root.
    await this.assertRealWithinRoot(root, dir);

    // write fully to a temp file, then publish atomically. Default publish is
    // exclusive (`link` fails EEXIST if taken, so we never clobber a row-backed
    // or hand-dropped object); `overwrite` (edit_file) replaces in place via
    // `rename`, which atomically swaps the destination.
    const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
    const handle = await fs.open(tmpPath, "wx");
    try {
      await handle.writeFile(params.data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (params.overwrite) {
      try {
        await fs.rename(tmpPath, finalPath);
      } catch (error) {
        await fs.unlink(tmpPath).catch(() => {});
        throw error;
      }
      return { key };
    }
    try {
      await fs.link(tmpPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new FilePathConflictError(key);
      }
      throw error;
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
    return { key };
  }

  async read(key: string): Promise<Buffer> {
    const root = this.getRoot();
    const full = resolveWithinRoot(root, ...key.split("/"));
    await this.assertRealWithinRoot(root, full);
    try {
      const handle = await fs.open(
        full,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      try {
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ELOOP") {
        throw new FileBytesMissingError(key);
      }
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    const root = this.getRoot();
    const full = resolveWithinRoot(root, ...key.split("/"));
    await this.assertRealWithinRoot(root, path.dirname(full));
    await fs.unlink(full).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    // best-effort: drop the owner folder once its last object is gone.
    await fs.rmdir(path.dirname(full)).catch(() => {});
  }

  async enumerate(scope: OwnerScope): Promise<StoredObject[]> {
    const root = this.getRoot();
    let folder: string;
    try {
      folder = scopeFolder(scope);
    } catch {
      return [];
    }
    const dir = resolveWithinRoot(root, ...folder.split("/"));
    try {
      await this.assertRealWithinRoot(root, dir);
    } catch {
      // a symlinked folder escaping the root surfaces nothing, never throws.
      return [];
    }
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    // keep only addressable, top-level regular files, then stat in parallel.
    const names = entries
      .filter((entry) => entry.isFile()) // skips subdirectories and symlinks
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          // un-addressable (control chars) or trimmed names can't round-trip.
          return safeSegment(name) === name;
        } catch {
          return false;
        }
      });
    const stats = await Promise.all(
      names.map((name) => fs.lstat(path.join(dir, name))),
    );
    return names.map((name, i) => ({
      key: `${folder}/${name}`,
      name,
      size: stats[i].size,
      modifiedAt: stats[i].mtime,
    }));
  }

  /**
   * Defend against a symlinked owner folder: resolve symlinks in `target` and
   * confirm the real path is still within the real root. A non-existent target
   * is fine (the lexical guard already ran; the op itself handles ENOENT). This
   * closes static-symlink escapes; a concurrent swap (TOCTOU) is out of scope.
   */
  private async assertRealWithinRoot(
    root: string,
    target: string,
  ): Promise<void> {
    const realRoot = await fs.realpath(root);
    let real: string;
    try {
      real = await fs.realpath(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new UnsafePathError("resolved path escapes the storage root");
    }
  }
}

const filesystemStore = new FilesystemObjectStore(
  () => config.fileStorage.filesystemRoot,
);

// The real S3 client is built once from config (memoized); a test may inject a
// fake via __setS3ClientForTests. Both are read lazily through thunks so the
// singleton tracks config mutations in tests.
let cachedS3Client: S3Client | null = null;
let s3ClientOverride: S3Client | null = null;

/** @public — test seam: inject a fake S3 client (or null to reset) for the store. */
export function __setS3ClientForTests(client: S3Client | null): void {
  s3ClientOverride = client;
  cachedS3Client = null;
}

const s3Store = new S3ObjectStore({
  getClient: () => {
    if (s3ClientOverride) return s3ClientOverride;
    if (!cachedS3Client) cachedS3Client = buildS3Client(config.fileStorage.s3);
    return cachedS3Client;
  },
  getBucket: () => config.fileStorage.s3.bucket,
  getKeyPrefix: () => config.fileStorage.s3.keyPrefix,
});

/** The store a given provider's rows live in; null = inline Postgres (`db`). */
function objectStoreFor(
  provider: string | null | undefined,
): EnumerableObjectStore | null {
  if (provider === "filesystem") return filesystemStore;
  if (provider === "s3") return s3Store;
  return null;
}
