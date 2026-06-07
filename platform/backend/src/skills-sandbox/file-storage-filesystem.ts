import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { extname, join } from "node:path";
import type {
  SandboxArtifactRow,
  SandboxFileListItem,
  SkillSandboxFile,
} from "@/types";
import { mimeFromExtension } from "./mime-from-extension";

/**
 * Counter cap for Downloads-style collision names. Past this, fall back to a
 * file-id suffix (unique by construction) so publish always terminates.
 */
const COUNTER_LIMIT = 1000;

/**
 * Sandbox file bytes as plain files under a configured root, one flat folder
 * per user: `<root>/<userId>/<filename>`. The folder is the user's artifacts
 * outbox — everything in it is theirs to browse, copy, or delete. Uploads
 * never land here: the router keeps them in Postgres because replay re-reads
 * them on every container rebuild.
 *
 * Writes are crash-safe and never overwrite: bytes land in a temp file, then
 * `link(2)` publishes them at the final name — on EEXIST the name counts up
 * Downloads-style (`report.txt`, `report (1).txt`, `report (2).txt`, ...).
 *
 * POC: filenames are used as-is (no sanitization) and object keys are trusted
 * from the DB (no root-escape check). Add both before any multi-tenant or
 * production use.
 */
export class FilesystemSandboxFileStorage {
  readonly name = "filesystem" as const;

  constructor(private readonly root: string) {}

  async put(params: {
    userId: string;
    fileId: string;
    kind: "upload" | "artifact";
    filename: string;
    data: Buffer;
  }): Promise<{
    provider: "filesystem";
    objectKey: string | null;
    dbData: Buffer | null;
  }> {
    const name = params.filename || "file";
    const relDir = params.userId;
    await mkdir(join(this.root, relDir), { recursive: true });

    const tempPath = join(this.root, relDir, `.${randomUUID()}.tmp`);
    await writeFile(tempPath, params.data, { flag: "wx" });
    try {
      const objectKey = await this.publish({
        tempPath,
        relDir,
        name,
        fileId: params.fileId,
      });
      return { provider: "filesystem", objectKey, dbData: null };
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  async get(file: SkillSandboxFile): Promise<Buffer> {
    if (!file.objectKey) {
      throw new Error(
        `sandbox file ${file.id} has storage_provider 'filesystem' but no object key`,
      );
    }
    const abs = join(this.root, file.objectKey);
    try {
      return await readFile(abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SandboxFileMissingError(file.objectKey);
      }
      throw error;
    }
  }

  async delete(objectKey: string): Promise<void> {
    const abs = join(this.root, objectKey);
    try {
      await unlink(abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  /**
   * List the user's folder as the source of truth. Each disk file is matched to
   * a row by object_key (`<userId>/<filename>`) to borrow its id/mime; files
   * with no row are listed non-downloadable. Rows with no disk file are dropped.
   */
  async listUserFiles(params: {
    userId: string;
    rows: SandboxArtifactRow[];
  }): Promise<SandboxFileListItem[]> {
    const dir = join(this.root, params.userId);
    let entries: Awaited<ReturnType<typeof readDirEntries>>;
    try {
      entries = await readDirEntries(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const rowByKey = new Map(
      params.rows
        .filter((r) => r.objectKey)
        .map((r) => [r.objectKey as string, r]),
    );

    const items: SandboxFileListItem[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      const stats = await stat(join(dir, entry.name));
      const match = rowByKey.get(`${params.userId}/${entry.name}`);
      items.push(
        match
          ? {
              id: match.id,
              filename: entry.name,
              mimeType: match.mimeType,
              sizeBytes: stats.size,
              createdAt: match.createdAt,
              downloadable: true,
            }
          : {
              id: null,
              filename: entry.name,
              mimeType: mimeFromExtension(entry.name),
              sizeBytes: stats.size,
              createdAt: stats.mtime,
              downloadable: false,
            },
      );
    }
    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return items;
  }

  /**
   * Publish the temp file at the final name, counting up on collision:
   * `name.ext`, `name (1).ext`, `name (2).ext`, ... Each attempt is an atomic
   * `link(2)`; EEXIST means the name is taken (concurrent writer or an earlier
   * file), so try the next counter. The counter fills the lowest free slot — a
   * deleted `name (1).ext` is reused before a new `(3)` — matching OS
   * Downloads-folder behavior.
   */
  private async publish(params: {
    tempPath: string;
    relDir: string;
    name: string;
    fileId: string;
  }): Promise<string> {
    const ext = extname(params.name);
    const base = params.name.slice(0, params.name.length - ext.length);
    for (let counter = 0; counter < COUNTER_LIMIT; counter++) {
      const candidate =
        counter === 0 ? params.name : `${base} (${counter})${ext}`;
      const key = join(params.relDir, candidate);
      try {
        await link(params.tempPath, join(this.root, key));
        return key;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    // pathological folder (COUNTER_LIMIT same-name files): file-id fallback,
    // then a random suffix if even that name is taken.
    const fallback = join(
      params.relDir,
      `${base}-${params.fileId.slice(0, 8)}${ext}`,
    );
    try {
      await link(params.tempPath, join(this.root, fallback));
      return fallback;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const random = join(params.relDir, `${base}-${randomUUID()}${ext}`);
    await link(params.tempPath, join(this.root, random));
    return random;
  }
}

/**
 * Read a directory's entries as `Dirent`s. A standalone helper so the
 * `withFileTypes: true` overload is resolved here and callers infer the
 * string-`Dirent[]` return without pinning the wrong `readdir` overload.
 */
function readDirEntries(dir: string) {
  return readdir(dir, { withFileTypes: true });
}

/** Bytes for this row exist in metadata but not on disk (deleted/moved externally). */
export class SandboxFileMissingError extends Error {
  constructor(objectKey: string) {
    super(
      `sandbox file bytes are missing from storage: ${objectKey} ` +
        "(was the file deleted or renamed in the storage folder?)",
    );
    this.name = "SandboxFileMissingError";
  }
}
