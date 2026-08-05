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
      /** Commit these bytes were pulled from; only GitHub import/sync sets it. */
      sourceCommit?: string | null;
    },
  ): Promise<SkillVersion> {
    const [version] = await tx
      .insert(schema.skillVersionsTable)
      .values({
        skillId: params.skillId,
        version: params.version,
        content: params.content,
        contentHash: params.contentHash,
        sourceCommit: params.sourceCommit ?? null,
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
   * `skill_versions` carries no organization of its own, so the read joins
   * `skills` and filters on the caller's organization — a skill id alone
   * must never reach another tenant's history.
   */
  static async listForSkill(params: {
    skillId: string;
    organizationId: string;
    pagination: PaginationQuery;
  }): Promise<PaginatedResult<SkillVersionMetadata>> {
    const scope = and(
      eq(schema.skillVersionsTable.skillId, params.skillId),
      eq(schema.skillsTable.organizationId, params.organizationId),
    );
    const [rows, [totals]] = await Promise.all([
      db
        .select(skillVersionMetadataColumns)
        .from(schema.skillVersionsTable)
        .innerJoin(
          schema.skillsTable,
          eq(schema.skillVersionsTable.skillId, schema.skillsTable.id),
        )
        .where(scope)
        .orderBy(desc(schema.skillVersionsTable.version))
        .limit(params.pagination.limit)
        .offset(params.pagination.offset),
      db
        .select({ total: count() })
        .from(schema.skillVersionsTable)
        .innerJoin(
          schema.skillsTable,
          eq(schema.skillVersionsTable.skillId, schema.skillsTable.id),
        )
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

  /**
   * Whether any sandbox still mounts a version of this skill.
   *
   * `skill_sandbox_skill_mounts.skill_version_id` is `ON DELETE RESTRICT`, so
   * this is exactly the set of rows that would refuse a permanent delete of the
   * skill's versions. Matched through the version ids rather than the mount's
   * denormalized `skill_id` so the check tests the constraint that actually
   * fires, not a copy of the identity beside it.
   *
   * Advisory only: a mount can be created between this check and the delete, so
   * the caller must still map the resulting FK violation to the same 409.
   */
  static async hasSandboxMountsForSkill(skillId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: schema.skillSandboxSkillMountsTable.id })
      .from(schema.skillSandboxSkillMountsTable)
      .innerJoin(
        schema.skillVersionsTable,
        eq(
          schema.skillSandboxSkillMountsTable.skillVersionId,
          schema.skillVersionsTable.id,
        ),
      )
      .where(eq(schema.skillVersionsTable.skillId, skillId))
      .limit(1);
    return row !== undefined;
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
  sourceCommit: schema.skillVersionsTable.sourceCommit,
  createdAt: schema.skillVersionsTable.createdAt,
};
