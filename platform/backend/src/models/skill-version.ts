import { createHash } from "node:crypto";
import type { PaginationQuery } from "@archestra/shared";
import { and, asc, count, desc, eq } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type { SkillVersion, SkillVersionFile } from "@/types";
import type {
  SkillFileEncoding,
  SkillFileKind,
  SkillVersionMetadata,
} from "@/types/skill";

/** Minimal file shape needed to fork and hash a version. */
export interface VersionFileInput {
  path: string;
  content: string;
  encoding: SkillFileEncoding;
  kind: SkillFileKind;
}

/**
 * Owns immutable skill version snapshots (`skill_versions` +
 * `skill_version_files`). A version is forked by `SkillModel` whenever an edit
 * changes the canonical payload; this model handles the writes and the lookups
 * that resolve which bytes a mount should replay.
 */
class SkillVersionModel {
  /**
   * sha256 over the canonical payload: the SKILL.md body plus every resource
   * file (path, encoding, kind, content), files sorted by path so the hash is
   * order-independent. Two edits that produce identical bytes hash equal, which
   * is how `SkillModel` suppresses no-op version forks.
   */
  static computeContentHash(params: {
    content: string;
    files: VersionFileInput[];
  }): string {
    const hash = createHash("sha256");
    hash.update("content\0");
    hash.update(params.content);
    const sorted = [...params.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    for (const file of sorted) {
      hash.update(`\0file\0${file.path}\0${file.encoding}\0${file.kind}\0`);
      hash.update(file.content);
    }
    return hash.digest("hex");
  }

  /** Insert a version row and its file snapshots in the caller's transaction. */
  static async insertVersion(
    tx: Transaction,
    params: {
      skillId: string;
      version: number;
      content: string;
      contentHash: string;
      files: VersionFileInput[];
    },
  ): Promise<SkillVersion> {
    const [version] = await tx
      .insert(schema.skillVersionsTable)
      .values({
        skillId: params.skillId,
        version: params.version,
        content: params.content,
        contentHash: params.contentHash,
      })
      .returning();
    if (!version) {
      throw new Error("failed to insert skill version");
    }

    if (params.files.length > 0) {
      await tx.insert(schema.skillVersionFilesTable).values(
        params.files.map((file) => ({
          versionId: version.id,
          path: file.path,
          content: file.content,
          encoding: file.encoding,
          kind: file.kind,
        })),
      );
    }

    return version;
  }

  static async findById(id: string): Promise<SkillVersion | null> {
    const [row] = await db
      .select()
      .from(schema.skillVersionsTable)
      .where(eq(schema.skillVersionsTable.id, id));
    return row ?? null;
  }

  /** Resolve a specific `(skill, version)` pair, e.g. the skill's head version. */
  static async findBySkillAndVersion(
    skillId: string,
    version: number,
    tx?: Transaction,
  ): Promise<SkillVersion | null> {
    const conn = tx ?? db;
    const [row] = await conn
      .select()
      .from(schema.skillVersionsTable)
      .where(
        and(
          eq(schema.skillVersionsTable.skillId, skillId),
          eq(schema.skillVersionsTable.version, version),
        ),
      );
    return row ?? null;
  }

  /**
   * A skill's versions, newest first, as metadata only — no SKILL.md body, no
   * files — so a long history stays cheap to list. Paginated: synced skills
   * fork a version per upstream change, so history is unbounded.
   *
   * `skill_versions` carries no organization of its own; callers must have
   * resolved the live, org-scoped skill (soft-deletes excluded) before
   * listing its history.
   */
  static async listForSkill(params: {
    skillId: string;
    pagination: PaginationQuery;
  }): Promise<PaginatedResult<SkillVersionMetadata>> {
    const scope = eq(schema.skillVersionsTable.skillId, params.skillId);
    const [rows, [totals]] = await Promise.all([
      db
        .select(skillVersionMetadataColumns)
        .from(schema.skillVersionsTable)
        .where(scope)
        .orderBy(desc(schema.skillVersionsTable.version))
        .limit(params.pagination.limit)
        .offset(params.pagination.offset),
      db
        .select({ total: count() })
        .from(schema.skillVersionsTable)
        .where(scope),
    ]);
    return createPaginatedResult(rows, totals?.total ?? 0, params.pagination);
  }

  /** A single resource file from a version by its skill-relative path. */
  static async findFileByPath(
    versionId: string,
    path: string,
  ): Promise<SkillVersionFile | null> {
    const [row] = await db
      .select()
      .from(schema.skillVersionFilesTable)
      .where(
        and(
          eq(schema.skillVersionFilesTable.versionId, versionId),
          eq(schema.skillVersionFilesTable.path, path),
        ),
      );
    return row ?? null;
  }

  /** Immutable resource files for a version, ordered by path. */
  static async findFiles(versionId: string): Promise<SkillVersionFile[]> {
    return await db
      .select()
      .from(schema.skillVersionFilesTable)
      .where(eq(schema.skillVersionFilesTable.versionId, versionId))
      .orderBy(asc(schema.skillVersionFilesTable.path));
  }
}

export default SkillVersionModel;

// === Internal helpers ===

/** List projection: everything but the SKILL.md body. */
const skillVersionMetadataColumns = {
  id: schema.skillVersionsTable.id,
  skillId: schema.skillVersionsTable.skillId,
  version: schema.skillVersionsTable.version,
  contentHash: schema.skillVersionsTable.contentHash,
  createdAt: schema.skillVersionsTable.createdAt,
};
