import { safeSegment } from "./file-path";

/**
 * Provider-agnostic byte-storage seam. An `ObjectStore` holds bytes addressed by
 * an opaque `key`; an `EnumerableObjectStore` can also list objects placed out of
 * band (no `files` row). Concrete backends (filesystem, s3) implement these.
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
export type StoredObject = {
  key: string;
  name: string;
  size: number;
  modifiedAt: Date;
};

/**
 * A backend that stores bytes under opaque, provider-owned keys.
 * @public — implemented by concrete backends (FilesystemObjectStore, S3ObjectStore) in sibling files.
 */
export interface ObjectStore {
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
export interface EnumerableObjectStore extends ObjectStore {
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
 * The relative folder an owner scope's objects live under (each segment validated
 * by {@link safeSegment}): `<email>/<conversationId>` for a user's no-project
 * conversation files, `<email>` for a headless (no-conversation) user write, and
 * `<project-slug>` for project files.
 */
export function scopeFolder(scope: OwnerScope): string {
  const owner = safeSegment(scope.label);
  if (scope.kind === "user" && scope.conversationId) {
    return `${owner}/${safeSegment(scope.conversationId)}`;
  }
  return owner;
}
