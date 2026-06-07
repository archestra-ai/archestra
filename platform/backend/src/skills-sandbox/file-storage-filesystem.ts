import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { SkillSandboxFile } from "@/types";

/**
 * Sandbox file bytes as plain files under a configured root:
 * `<root>/<sandboxId>/{uploads|artifacts}/<filename>`. Built for operators who
 * mount the root (e.g. a PVC) and browse it with a normal file manager —
 * artifacts are free to take; uploads are replay inputs (deleting or editing
 * one breaks that sandbox's reproducibility).
 *
 * Writes are crash-safe and never overwrite: bytes land in a temp file, then
 * `link(2)` publishes them at the final name — EEXIST (concurrent writer or
 * earlier file with the same name) retries once with a file-id suffix.
 *
 * POC: filenames are used as-is (no sanitization) and object keys are trusted
 * from the DB (no root-escape check). Add both before any multi-tenant or
 * production use.
 */
export class FilesystemSandboxFileStorage {
  readonly name = "filesystem" as const;

  constructor(private readonly root: string) {}

  async put(params: {
    sandboxId: string;
    fileId: string;
    kind: "upload" | "artifact";
    filename: string;
    data: Buffer;
  }): Promise<{
    provider: "filesystem";
    objectKey: string | null;
    dbData: Buffer | null;
  }> {
    const dir = params.kind === "upload" ? "uploads" : "artifacts";
    const name = params.filename || "file";
    const relDir = join(params.sandboxId, dir);
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

  /** Publish the temp file at the final name; suffix with the file id on collision. */
  private async publish(params: {
    tempPath: string;
    relDir: string;
    name: string;
    fileId: string;
  }): Promise<string> {
    const primaryKey = join(params.relDir, params.name);
    try {
      await link(params.tempPath, join(this.root, primaryKey));
      return primaryKey;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const ext = extname(params.name);
    const base = params.name.slice(0, params.name.length - ext.length);
    const suffixed = `${base}-${params.fileId.slice(0, 8)}${ext}`;
    const suffixedKey = join(params.relDir, suffixed);
    await link(params.tempPath, join(this.root, suffixedKey));
    return suffixedKey;
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
