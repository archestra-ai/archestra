import {
  and,
  asc,
  count,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type { SkillFile } from "@/types";
import type { SkillFileEncoding } from "@/types/skill";
import { chunkForBulkStatement } from "@/utils/db";

/** A resource file as the MCP gateway lists it: identity and digest, no bytes. */
interface SkillFilePublicationRow {
  skillId: string;
  path: string;
  digest: string | null;
}

class SkillFileModel {
  static async findBySkillId(skillId: string): Promise<SkillFile[]> {
    return await db
      .select()
      .from(schema.skillFilesTable)
      .where(eq(schema.skillFilesTable.skillId, skillId))
      .orderBy(asc(schema.skillFilesTable.path));
  }

  /**
   * One resource file by its skill-relative path, or null.
   *
   * Joins the skill row to honour its soft delete: this backs the gateway's
   * `resources/read`, and a skill deleted between resolution and this read
   * would otherwise still hand back its bytes.
   */
  static async findBySkillAndPath(
    skillId: string,
    path: string,
  ): Promise<SkillFile | null> {
    const [result] = await db
      .select(getTableColumns(schema.skillFilesTable))
      .from(schema.skillFilesTable)
      .innerJoin(
        schema.skillsTable,
        eq(schema.skillFilesTable.skillId, schema.skillsTable.id),
      )
      .where(
        and(
          eq(schema.skillFilesTable.skillId, skillId),
          eq(schema.skillFilesTable.path, path),
          notDeleted(schema.skillsTable),
        ),
      );

    return result ?? null;
  }

  /** Fetch all resource files for a set of skills, grouped by skill id. */
  static async findBySkillIds(
    skillIds: string[],
  ): Promise<Map<string, SkillFile[]>> {
    const map = new Map<string, SkillFile[]>();
    if (skillIds.length === 0) return map;

    for (const id of skillIds) map.set(id, []);

    const rows = await db
      .select()
      .from(schema.skillFilesTable)
      .where(inArray(schema.skillFilesTable.skillId, skillIds))
      .orderBy(asc(schema.skillFilesTable.path));

    for (const row of rows) {
      const list = map.get(row.skillId);
      if (list) list.push(row);
    }
    return map;
  }

  /**
   * Path and digest of every resource file of a set of skills, grouped by skill
   * id — no bytes.
   *
   * What the MCP gateway needs to list a page of skills: a `skills/list` over
   * 50 skills enumerates each one's files, so selecting `content` here would
   * ship every script and reference in the page on every call.
   */
  static async findPublicationRowsBySkillIds(
    skillIds: string[],
  ): Promise<Map<string, SkillFilePublicationRow[]>> {
    const map = new Map<string, SkillFilePublicationRow[]>();
    if (skillIds.length === 0) return map;

    for (const id of skillIds) map.set(id, []);

    const rows = await db
      .select({
        skillId: schema.skillFilesTable.skillId,
        path: schema.skillFilesTable.path,
        digest: schema.skillFilesTable.digest,
      })
      .from(schema.skillFilesTable)
      .where(inArray(schema.skillFilesTable.skillId, skillIds))
      .orderBy(asc(schema.skillFilesTable.path));

    for (const row of rows) {
      map.get(row.skillId)?.push(row);
    }
    return map;
  }

  /**
   * One keyset page of files whose digest is missing — rows written before
   * migration 0407, or reset by the invalidation trigger after a write outside
   * the model layer — as ids and stored sizes only.
   *
   * No `content` crosses the wire here so the periodic backfill
   * (services/skill-publication-backfill.ts) can decide how many rows it can
   * afford to hold before loading any of them: a single stored file runs to
   * `MAX_SKILL_FILE_CONTENT_CHARS` (~14M chars, a 10MB binary asset after
   * base64 expansion), so a fixed row count is not a memory bound.
   */
  static async findRowSizesMissingDigest(params: {
    /** Resume after this id; omit to start at the first page. */
    afterId?: string;
    limit: number;
  }): Promise<Array<{ id: string; chars: number }>> {
    return await db
      .select({
        id: schema.skillFilesTable.id,
        chars: sql<number>`char_length(${schema.skillFilesTable.content})`,
      })
      .from(schema.skillFilesTable)
      .where(
        and(
          isNull(schema.skillFilesTable.digest),
          params.afterId
            ? gt(schema.skillFilesTable.id, params.afterId)
            : undefined,
        ),
      )
      .orderBy(asc(schema.skillFilesTable.id))
      .limit(params.limit);
  }

  /**
   * The bytes of specific still-undigested files, the second half of the
   * backfill's read. The `digest IS NULL` filter is re-applied because a
   * model-layer write may have digested a row since its size was read — such a
   * row needs nothing and is simply absent from the result.
   */
  static async findDigestSourcesByIds(
    ids: string[],
  ): Promise<
    Array<{ id: string; content: string; encoding: SkillFileEncoding }>
  > {
    if (ids.length === 0) return [];

    return await db
      .select({
        id: schema.skillFilesTable.id,
        content: schema.skillFilesTable.content,
        encoding: schema.skillFilesTable.encoding,
      })
      .from(schema.skillFilesTable)
      .where(
        and(
          inArray(schema.skillFilesTable.id, ids),
          isNull(schema.skillFilesTable.digest),
        ),
      );
  }

  /**
   * How many files are still undigested. One such file withholds its whole
   * skill, so this is the file-side half of the withheld-catalog signal.
   */
  static async countRowsMissingDigest(): Promise<number> {
    const [row] = await db
      .select({ value: count() })
      .from(schema.skillFilesTable)
      .where(isNull(schema.skillFilesTable.digest));
    return row?.value ?? 0;
  }

  /**
   * Persist digests computed by the periodic backfill for files written before
   * the column existed (its twin reader is
   * {@link SkillFileModel.findRowSizesMissingDigest}). The `IS NULL` guard keeps a
   * concurrent edit's digest from being overwritten with one computed from
   * bytes that edit replaced.
   */
  static async fillDigests(
    rows: Array<{ id: string; digest: string }>,
  ): Promise<void> {
    for (const chunk of chunkForBulkStatement(rows)) {
      const values = sql.join(
        chunk.map((row) => sql`(${row.id}::uuid, ${row.digest}::text)`),
        sql`, `,
      );
      await db.execute(sql`
        UPDATE skill_files AS f
        SET digest = v.digest
        FROM (VALUES ${values}) AS v(id, digest)
        WHERE f.id = v.id AND f.digest IS NULL
      `);
    }
  }

  /** Count resource files per skill, keyed by skill id. */
  static async countBySkillIds(
    skillIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (skillIds.length === 0) return counts;

    const rows = await db
      .select({
        skillId: schema.skillFilesTable.skillId,
        count: count(),
      })
      .from(schema.skillFilesTable)
      .where(inArray(schema.skillFilesTable.skillId, skillIds))
      .groupBy(schema.skillFilesTable.skillId);

    for (const row of rows) {
      counts.set(row.skillId, row.count);
    }
    return counts;
  }
}

export default SkillFileModel;
