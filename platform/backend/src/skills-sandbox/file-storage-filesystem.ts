import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { SkillSandboxFile } from "@/types";

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
   * Publish the temp file at the final name, counting up on collision:
   * `name.ext`, `name (1).ext`, `name (2).ext`, ... Each attempt is an atomic
   * `link(2)`; EEXIST means the name is taken (concurrent writer or an earlier
   * file), so try the next counter.
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
    // pathological folder (COUNTER_LIMIT same-name files): unique fallback.
    const key = join(
      params.relDir,
      `${base}-${params.fileId.slice(0, 8)}${ext}`,
    );
    await link(params.tempPath, join(this.root, key));
    return key;
  }
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
