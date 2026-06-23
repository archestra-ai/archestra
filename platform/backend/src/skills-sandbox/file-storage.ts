import { randomUUID } from "node:crypto";
import { type Dirent, constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import config from "@/config";
import type { StoredBlobRow } from "@/types";
import { resolveWithinRoot, safeSegment, UnsafePathError } from "./file-path";

/**
 * Provider-agnostic byte storage. The seam is `ObjectStore` — a backend that
 * holds bytes addressed by an opaque `key` (filesystem today; S3/Drive/… later).
 * Postgres `bytea` is NOT an `ObjectStore`: it stores bytes inline in the row, so
 * it has no external key namespace and nothing can be dropped in out of band. The
 * row helpers below (`readRowBytes`/`deleteRowBytes`) dispatch per row between the
 * inline (`db`) case and the row's external store.
 */

/**
 * The owner namespace an object belongs to; `label` is its human folder/prefix.
 * A user's no-project files are nested one level deeper by `conversationId`
 * (`<email>/<conversationId>/<filename>`), so each conversation has its own
 * folder and two conversations may reuse a filename. `conversationId` is null
 * for a headless (no-conversation) write, which falls back to `<email>/<filename>`.
 */
export type OwnerScope =
  | {
      kind: "user";
      userId: string;
      label: string;
      conversationId: string | null;
    }
  | { kind: "project"; projectId: string; label: string };

/** An object a backend holds — may or may not have a `files` row behind it. */
type StoredObject = {
  key: string;
  name: string;
  size: number;
  modifiedAt: Date;
};

/** A backend that stores bytes under opaque, provider-owned keys. */
interface ObjectStore {
  /**
   * Store bytes and return the key they're addressed by. Fails with
   * {@link FilePathConflictError} if an object named `name` already exists in
   * `scope` (exclusive create — never overwrites).
   */
  write(params: {
    scope: OwnerScope;
    name: string;
    data: Buffer;
    /** Replace bytes if the object already exists (edit) instead of failing. */
    overwrite?: boolean;
  }): Promise<{ key: string }>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

/**
 * A store whose namespace can change out of band, so objects placed by hand
 * (no `files` row) can be surfaced.
 */
interface EnumerableObjectStore extends ObjectStore {
  enumerate(scope: OwnerScope): Promise<StoredObject[]>;
}

export class FileBytesMissingError extends Error {}

/** An object with this name already exists in the scope (exclusive create lost). */
export class FilePathConflictError extends Error {
  constructor(name: string) {
    super(`an object named "${name}" already exists`);
    this.name = "FilePathConflictError";
  }
}

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
 * The relative folder an owner scope's objects live under (each segment validated
 * by {@link safeSegment}): `<email>/<conversationId>` for a user's no-project
 * conversation files, `<email>` for a headless (no-conversation) user write, and
 * `<project-slug>` for project files.
 */
function scopeFolder(scope: OwnerScope): string {
  const owner = safeSegment(scope.label);
  if (scope.kind === "user" && scope.conversationId) {
    return `${owner}/${safeSegment(scope.conversationId)}`;
  }
  return owner;
}

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

/** The store a given provider's rows live in; null = inline Postgres (`db`). */
function objectStoreFor(
  provider: string | null | undefined,
): EnumerableObjectStore | null {
  return provider === "filesystem" ? filesystemStore : null;
}
