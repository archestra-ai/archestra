import type { SkillSandboxFile } from "@/types";

/**
 * Storage adapter for sandbox file bytes (`skill_sandbox_files`). Phase 1
 * ships only the `db` passthrough (bytes stay in the `data` bytea column);
 * Phase 2 adds a `filesystem` provider selected via config, at which point
 * `put` returns an `objectKey` instead of `dbData` and `get` resolves per-row
 * via the `storage_provider` column.
 * See docs/superpowers/specs/2026-06-07-sandbox-file-storage-design.md.
 *
 * Not exported yet: callers depend on `getSandboxFileStorage()` only. Phase 2
 * exports the interface when the filesystem provider (its own file) implements it.
 */
interface SandboxFileStorage {
  readonly name: "db" | "filesystem";

  /** Persist bytes for a new file row. Exactly one of objectKey/dbData is set. */
  put(params: {
    sandboxId: string;
    fileId: string;
    kind: "upload" | "artifact";
    filename: string;
    data: Buffer;
  }): Promise<{ objectKey: string | null; dbData: Buffer | null }>;

  /** Read a file row's bytes, normalized to a Buffer. */
  get(file: SkillSandboxFile): Promise<Buffer>;

  /** Remove externally-stored bytes. No-op for the db provider. */
  delete(objectKey: string): Promise<void>;
}

export function getSandboxFileStorage(): SandboxFileStorage {
  return dbSandboxFileStorage;
}

/**
 * Filename a stored file is addressed by: the caller-provided original name
 * when present, else the basename of its container path. Used by Phase 2's
 * filesystem provider for browsable on-disk names; computed at the call sites
 * now so they don't change when the provider does.
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
  }): Promise<{ objectKey: string | null; dbData: Buffer | null }> {
    return { objectKey: null, dbData: params.data };
  }

  async get(file: SkillSandboxFile): Promise<Buffer> {
    // pg returns bytea as Buffer; PGlite returns Uint8Array. Callers rely on
    // Buffer semantics, so normalize at the read boundary.
    if (Buffer.isBuffer(file.data)) return file.data;
    return Buffer.from(file.data as unknown as Uint8Array);
  }

  async delete(_objectKey: string): Promise<void> {}
}

const dbSandboxFileStorage = new DbSandboxFileStorage();
