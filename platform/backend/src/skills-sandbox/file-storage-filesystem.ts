import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import UserModel from "@/models/user";
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

/** Top-level directory holding every project result folder. */
const PROJECTS_DIR = "projects";

/**
 * Sandbox file bytes as plain files under a configured root, laid out for
 * humans browsing the storage folder:
 *
 *   - personal files: `<root>/<email>/<filename>` — one folder per user,
 *     named by email (falling back to the user id when no user row exists).
 *   - project result folders: `<root>/projects/<email>/<folder>/<filename>` —
 *     lifted out of the personal folder, grouped under `projects/` by owner.
 *
 * The tree is the user's artifacts outbox — everything in it is theirs to
 * browse, copy, or delete. Uploads never land here: the router keeps them in
 * Postgres because replay re-reads them on every container rebuild.
 *
 * Writes are crash-safe and never overwrite: bytes land in a temp file, then
 * `link(2)` publishes them at the final name — on EEXIST the name counts up
 * Downloads-style (`report.txt`, `report (1).txt`, `report (2).txt`, ...).
 *
 * Every path this class touches is resolved and asserted to stay inside the
 * owner's subtree (or, for row object keys, inside the root), so a hostile
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
    const ns = await this.namespaceFor(params.userId);
    const baseRel = folder ? join(PROJECTS_DIR, ns) : ns;
    const relDir = folder ? join(baseRel, folder) : baseRel;
    const dirAbs = this.resolveUnder(baseRel, relDir);
    await mkdir(dirAbs, { recursive: true });
    await this.assertRealDirUnder(baseRel, dirAbs);

    const tempPath = join(dirAbs, `.${randomUUID()}.tmp`);
    await writeFile(tempPath, params.data, { flag: "wx" });
    try {
      const objectKey = await this.publish({
        tempPath,
        baseRel,
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
      await this.assertNotSymlink(abs);
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
    const baseRel = join(PROJECTS_DIR, await this.namespaceFor(params.userId));
    const abs = this.resolveUnder(baseRel, join(baseRel, params.name));
    await mkdir(abs, { recursive: true });
    await this.assertRealDirUnder(baseRel, abs);
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
    const ns = await this.namespaceFor(params.userId);
    const baseRel = params.folder ? join(PROJECTS_DIR, ns) : ns;
    const rel = params.folder
      ? join(baseRel, params.folder, params.filename)
      : join(baseRel, params.filename);
    const abs = this.resolveUnder(baseRel, rel);
    try {
      await this.assertNotSymlink(abs);
      return await readFile(abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SandboxFileMissingError(rel);
      }
      throw error;
    }
  }

  /**
   * List the user's PFS with the directory tree as the source of truth.
   * Personal files come from `<root>/<ns>` (subdirectories there are legacy
   * folders, still listed); project folders come from `folderRows`, each
   * scanned at `<root>/projects/<ns>/<name>` — rows whose directory is gone
   * are still listed (the row is the durable half). Each disk file is matched
   * to a row by object_key to borrow its id/mime; files with no row are
   * listed non-downloadable. Rows with no disk file are dropped.
   */
  async listUserFiles(params: {
    userId: string;
    rows: SandboxArtifactRow[];
    folderRows: { id: string; name: string; createdAt: Date }[];
  }): Promise<{
    folders: SandboxFolderListItem[];
    files: SandboxFileListItem[];
  }> {
    const ns = await this.namespaceFor(params.userId);
    const rowByKey = new Map(
      params.rows
        .filter((r) => r.objectKey)
        .map((r) => [r.objectKey as string, r]),
    );
    const folderRowByName = new Map(params.folderRows.map((f) => [f.name, f]));

    const folders: SandboxFolderListItem[] = [];
    const files: SandboxFileListItem[] = [];
    const seenFolderNames = new Set<string>();

    const dir = this.resolveUnder(ns, ns);
    let entries: Awaited<ReturnType<typeof readDirEntries>> = [];
    try {
      entries = await readDirEntries(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

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
            keyPrefix: ns,
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
          match: rowByKey.get(`${ns}/${entry.name}`),
        }),
      );
    }

    // project folders live under projects/<ns>/<name>; the row is what makes
    // a directory there a folder, and it lists even when the dir is gone.
    const projectsBase = join(PROJECTS_DIR, ns);
    for (const f of params.folderRows) {
      if (!seenFolderNames.has(f.name)) {
        folders.push({ id: f.id, name: f.name, createdAt: f.createdAt });
      }
      files.push(
        ...(await this.listFolderFiles({
          keyPrefix: projectsBase,
          folderName: f.name,
          dirAbs: this.resolveUnder(projectsBase, join(projectsBase, f.name)),
          rowByKey,
        })),
      );
    }

    folders.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { folders, files };
  }

  // === private ===

  /** Files directly inside one PFS folder directory (no deeper recursion). */
  private async listFolderFiles(params: {
    /** Root-relative dir the folder sits in — the object-key prefix. */
    keyPrefix: string;
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
            `${params.keyPrefix}/${params.folderName}/${entry.name}`,
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
    baseRel: string;
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
        await link(params.tempPath, this.resolveUnder(params.baseRel, key));
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
      await link(params.tempPath, this.resolveUnder(params.baseRel, fallback));
      return fallback;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const random = join(params.relDir, `${base}-${randomUUID()}${ext}`);
    await link(params.tempPath, this.resolveUnder(params.baseRel, random));
    return random;
  }

  /**
   * Directory name for a user's files: their email when the user row exists
   * (humans browse this tree), the raw id otherwise. Emails cannot contain
   * path separators, and `projects` is not a valid email, so namespaces can
   * collide neither with each other nor with the projects tree.
   */
  private async namespaceFor(userId: string): Promise<string> {
    return (await UserModel.getEmailById(userId)) || userId;
  }

  /**
   * The lexical checks below don't see symlinks: a link planted inside the
   * tree resolves under the base dir lexically while its target sits outside.
   * Before writing into a directory, resolve it with realpath(3) and require
   * the REAL location to still be inside the owner's real subtree. (The root
   * itself may legitimately be a symlink — e.g. /var -> /private/var — so the
   * comparison base is the resolved root.)
   */
  private async assertRealDirUnder(
    baseRel: string,
    dirAbs: string,
  ): Promise<void> {
    const realBase = join(await realpath(resolve(this.root)), baseRel);
    const realDir = await realpath(dirAbs);
    if (realDir !== realBase && !realDir.startsWith(realBase + sep)) {
      throw new Error(
        `sandbox storage directory resolves outside the owner folder: ${dirAbs}`,
      );
    }
  }

  /**
   * Byte reads address regular files only — a symlink in the tree (which only
   * someone with host access to the storage folder can plant) is refused
   * rather than followed.
   */
  private async assertNotSymlink(abs: string): Promise<void> {
    const stats = await lstat(abs);
    if (stats.isSymbolicLink()) {
      throw new Error(
        "sandbox storage entry is a symlink; refusing to follow it",
      );
    }
  }

  /**
   * Resolve a root-relative path and assert it stays strictly inside the
   * owner's base directory (`<ns>` or `projects/<ns>`) — the last line of
   * defense should a hostile filename or folder name get past upstream
   * validation.
   */
  private resolveUnder(baseRel: string, relPath: string): string {
    const baseDir = resolve(this.root, baseRel);
    const abs = resolve(this.root, relPath);
    if (abs !== baseDir && !abs.startsWith(baseDir + sep)) {
      throw new Error(
        `sandbox storage path escapes the owner folder: ${relPath}`,
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
