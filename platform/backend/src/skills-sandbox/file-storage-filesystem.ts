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
import { extname, join, resolve, sep } from "node:path";
import type {
  SandboxArtifactRow,
  SandboxFileListItem,
  SandboxFolderListItem,
  SkillSandboxFile,
} from "@/types";
import { mimeFromExtension } from "./mime-from-extension";

/**
 * Counter cap for Downloads-style collision names. Past this, fall back to a
 * file-id suffix (unique by construction) so publish always terminates.
 */
const COUNTER_LIMIT = 1000;

/**
 * Sandbox file bytes as plain files under a configured root, one folder per
 * user: `<root>/<userId>/<filename>`, with one optional level of user-created
 * PFS folders: `<root>/<userId>/<folder>/<filename>`. The tree is the user's
 * artifacts outbox — everything in it is theirs to browse, copy, or delete.
 * Uploads never land here: the router keeps them in Postgres because replay
 * re-reads them on every container rebuild.
 *
 * Writes are crash-safe and never overwrite: bytes land in a temp file, then
 * `link(2)` publishes them at the final name — on EEXIST the name counts up
 * Downloads-style (`report.txt`, `report (1).txt`, `report (2).txt`, ...).
 *
 * Every path this class touches is resolved and asserted to stay inside the
 * user's directory (or, for row object keys, inside the root), so a hostile
 * filename or object key cannot escape the storage tree.
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
    folder?: string | null;
  }): Promise<{
    provider: "filesystem";
    objectKey: string | null;
    dbData: Buffer | null;
  }> {
    const name = params.filename || "file";
    const folder = params.folder ?? null;
    const relDir = folder ? join(params.userId, folder) : params.userId;
    const dirAbs = this.resolveUnderUserDir(params.userId, relDir);
    await mkdir(dirAbs, { recursive: true });

    const tempPath = join(dirAbs, `.${randomUUID()}.tmp`);
    await writeFile(tempPath, params.data, { flag: "wx" });
    try {
      const objectKey = await this.publish({
        tempPath,
        userId: params.userId,
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
    const abs = this.resolveUnderRoot(file.objectKey);
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
    const abs = this.resolveUnderRoot(objectKey);
    try {
      await unlink(abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  /**
   * Create the on-disk directory for a PFS folder. An existing directory of
   * the same name (made by hand in the storage folder) is adopted, not an
   * error — the row being created alongside gives it an id.
   */
  async ensureFolderDir(params: {
    userId: string;
    name: string;
  }): Promise<void> {
    const abs = this.resolveUnderUserDir(
      params.userId,
      join(params.userId, params.name),
    );
    await mkdir(abs, { recursive: true });
  }

  /**
   * Read a file's bytes by PFS location (root or one folder deep). This is the
   * path that reaches orphans — files with no `skill_sandbox_files` row.
   */
  async readUserFile(params: {
    userId: string;
    folder: string | null;
    filename: string;
  }): Promise<Buffer> {
    const rel = params.folder
      ? join(params.userId, params.folder, params.filename)
      : join(params.userId, params.filename);
    const abs = this.resolveUnderUserDir(params.userId, rel);
    try {
      return await readFile(abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SandboxFileMissingError(rel);
      }
      throw error;
    }
  }

  /**
   * List the user's directory tree (one level deep) as the source of truth.
   * Top-level subdirectories are PFS folders: matched to `folderRows` by name
   * to borrow the row id, listed with `id: null` when hand-made. Folder rows
   * whose directory is gone are still listed (the row is the durable half).
   * Each disk file is matched to a row by object_key to borrow its id/mime;
   * files with no row are listed non-downloadable. Rows with no disk file are
   * dropped.
   */
  async listUserFiles(params: {
    userId: string;
    rows: SandboxArtifactRow[];
    folderRows: { id: string; name: string; createdAt: Date }[];
  }): Promise<{
    folders: SandboxFolderListItem[];
    files: SandboxFileListItem[];
  }> {
    const dir = this.resolveUnderUserDir(params.userId, params.userId);
    let entries: Awaited<ReturnType<typeof readDirEntries>>;
    try {
      entries = await readDirEntries(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          folders: params.folderRows.map((f) => ({
            id: f.id,
            name: f.name,
            createdAt: f.createdAt,
          })),
          files: [],
        };
      }
      throw error;
    }

    const rowByKey = new Map(
      params.rows
        .filter((r) => r.objectKey)
        .map((r) => [r.objectKey as string, r]),
    );
    const folderRowByName = new Map(params.folderRows.map((f) => [f.name, f]));

    const folders: SandboxFolderListItem[] = [];
    const files: SandboxFileListItem[] = [];
    const seenFolderNames = new Set<string>();

    for (const entry of entries) {
      // `entry.isFile()`/`isDirectory()` reflect the directory entry's OWN
      // type, so symlinks report false for both and are skipped before any
      // stat — no link is ever followed off the tree.
      if (entry.name.startsWith(".")) continue;

      if (entry.isDirectory()) {
        const folderRow = folderRowByName.get(entry.name) ?? null;
        const stats = await statOrNull(join(dir, entry.name));
        if (!stats) continue;
        seenFolderNames.add(entry.name);
        folders.push({
          id: folderRow?.id ?? null,
          name: entry.name,
          createdAt: folderRow?.createdAt ?? stats.mtime,
        });
        files.push(
          ...(await this.listFolderFiles({
            userId: params.userId,
            folderName: entry.name,
            dirAbs: join(dir, entry.name),
            rowByKey,
          })),
        );
        continue;
      }

      if (!entry.isFile()) continue;
      const stats = await statOrNull(join(dir, entry.name));
      if (!stats) continue;
      files.push(
        this.toListItem({
          filename: entry.name,
          folder: null,
          stats,
          match: rowByKey.get(`${params.userId}/${entry.name}`),
        }),
      );
    }

    // folder rows whose directory was hand-deleted still represent a folder.
    for (const f of params.folderRows) {
      if (!seenFolderNames.has(f.name)) {
        folders.push({ id: f.id, name: f.name, createdAt: f.createdAt });
      }
    }

    folders.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { folders, files };
  }

  // === private ===

  /** Files directly inside one PFS folder directory (no deeper recursion). */
  private async listFolderFiles(params: {
    userId: string;
    folderName: string;
    dirAbs: string;
    rowByKey: Map<string, SandboxArtifactRow>;
  }): Promise<SandboxFileListItem[]> {
    let entries: Awaited<ReturnType<typeof readDirEntries>>;
    try {
      entries = await readDirEntries(params.dirAbs);
    } catch (error) {
      // the folder is user-writable: tolerate it vanishing mid-listing.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const items: SandboxFileListItem[] = [];
    for (const entry of entries) {
      // anything below one level (sub-subdirectories) is ignored by design.
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      const stats = await statOrNull(join(params.dirAbs, entry.name));
      if (!stats) continue;
      items.push(
        this.toListItem({
          filename: entry.name,
          folder: params.folderName,
          stats,
          match: params.rowByKey.get(
            `${params.userId}/${params.folderName}/${entry.name}`,
          ),
        }),
      );
    }
    return items;
  }

  private toListItem(params: {
    filename: string;
    folder: string | null;
    stats: { size: number; mtime: Date };
    match: SandboxArtifactRow | undefined;
  }): SandboxFileListItem {
    return params.match
      ? {
          id: params.match.id,
          filename: params.filename,
          mimeType: params.match.mimeType,
          sizeBytes: params.stats.size,
          createdAt: params.match.createdAt,
          downloadable: true,
          folder: params.folder,
        }
      : {
          id: null,
          filename: params.filename,
          mimeType: mimeFromExtension(params.filename),
          sizeBytes: params.stats.size,
          createdAt: params.stats.mtime,
          downloadable: false,
          folder: params.folder,
        };
  }

  /**
   * Publish the temp file at the final name, counting up on collision:
   * `name.ext`, `name (1).ext`, `name (2).ext`, ... Each attempt is an atomic
   * `link(2)`; EEXIST means the name is taken (concurrent writer or an earlier
   * file), so try the next counter. The counter fills the lowest free slot — a
   * deleted `name (1).ext` is reused before a new `(3)` — matching OS
   * Downloads-folder behavior. Counters are per directory, so a folder and the
   * root each have their own sequence.
   */
  private async publish(params: {
    tempPath: string;
    userId: string;
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
        await link(
          params.tempPath,
          this.resolveUnderUserDir(params.userId, key),
        );
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
      await link(
        params.tempPath,
        this.resolveUnderUserDir(params.userId, fallback),
      );
      return fallback;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const random = join(params.relDir, `${base}-${randomUUID()}${ext}`);
    await link(
      params.tempPath,
      this.resolveUnderUserDir(params.userId, random),
    );
    return random;
  }

  /**
   * Resolve a root-relative path and assert it stays strictly inside the
   * user's directory — the last line of defense should a hostile filename or
   * folder name get past upstream validation.
   */
  private resolveUnderUserDir(userId: string, relPath: string): string {
    const userDir = resolve(this.root, userId);
    const abs = resolve(this.root, relPath);
    if (abs !== userDir && !abs.startsWith(userDir + sep)) {
      throw new Error(
        `sandbox storage path escapes the user folder: ${relPath}`,
      );
    }
    return abs;
  }

  /**
   * Resolve a row's object key and assert it stays strictly inside the root.
   * Object keys come from the DB, whose rows we wrote — but never trust a
   * stored path enough to follow it out of the tree.
   */
  private resolveUnderRoot(objectKey: string): string {
    const rootAbs = resolve(this.root);
    const abs = resolve(this.root, objectKey);
    if (abs === rootAbs || !abs.startsWith(rootAbs + sep)) {
      throw new Error(
        `sandbox storage object key escapes the storage root: ${objectKey}`,
      );
    }
    return abs;
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

/**
 * Stat that treats a vanished path as absent: the tree is user-writable, so a
 * file can disappear between readdir and stat without failing the listing.
 */
async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
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
