import { and, count, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  KbDirectory,
  KbDirectoryWithTeams,
  KnowledgeFileVisibility,
} from "@/types/knowledge-file";
import CreatedByModel, { lookupCreator } from "./created-by";

class KbDirectoryModel {
  static async findAll(
    organizationId: string,
  ): Promise<KbDirectoryWithTeams[]> {
    const directories = await db
      .select()
      .from(schema.kbDirectoriesTable)
      .where(eq(schema.kbDirectoriesTable.organizationId, organizationId))
      .orderBy(schema.kbDirectoriesTable.name);

    if (directories.length === 0) return [];
    const ids = directories.map((directory) => directory.id);

    // Batched rather than per-directory: the listing renders every directory,
    // so a query per row is an N+1 on the page's primary request.
    const [teamRows, fileCounts] = await Promise.all([
      db
        .select()
        .from(schema.kbDirectoryTeamsTable)
        .where(inArray(schema.kbDirectoryTeamsTable.directoryId, ids)),
      db
        .select({
          directoryId: schema.kbFilesTable.directoryId,
          total: count(),
        })
        .from(schema.kbFilesTable)
        .where(inArray(schema.kbFilesTable.directoryId, ids))
        .groupBy(schema.kbFilesTable.directoryId),
    ]);

    const teamsByDirectory = new Map<string, string[]>();
    for (const row of teamRows) {
      const existing = teamsByDirectory.get(row.directoryId) ?? [];
      existing.push(row.teamId);
      teamsByDirectory.set(row.directoryId, existing);
    }
    const countByDirectory = new Map(
      fileCounts.map((row) => [row.directoryId, row.total]),
    );

    const creators = await CreatedByModel.resolve(
      directories.map((directory) => directory.createdBy),
    );

    return directories.map((directory) => ({
      ...directory,
      createdBy: lookupCreator(creators, directory.createdBy),
      teamIds: teamsByDirectory.get(directory.id) ?? [],
      fileCount: countByDirectory.get(directory.id) ?? 0,
    }));
  }

  /** Files currently in a directory — for single-directory responses. */
  static async countFiles(directoryId: string): Promise<number> {
    const [row] = await db
      .select({ total: count() })
      .from(schema.kbFilesTable)
      .where(eq(schema.kbFilesTable.directoryId, directoryId));
    return row?.total ?? 0;
  }

  static async findById(params: {
    id: string;
    organizationId: string;
  }): Promise<KbDirectory | null> {
    const [row] = await db
      .select()
      .from(schema.kbDirectoriesTable)
      .where(
        and(
          eq(schema.kbDirectoriesTable.id, params.id),
          eq(schema.kbDirectoriesTable.organizationId, params.organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  static async findTeamIds(directoryId: string): Promise<string[]> {
    const rows = await db
      .select({ teamId: schema.kbDirectoryTeamsTable.teamId })
      .from(schema.kbDirectoryTeamsTable)
      .where(eq(schema.kbDirectoryTeamsTable.directoryId, directoryId));
    return rows.map((row) => row.teamId);
  }

  static async create(params: {
    organizationId: string;
    name: string;
    visibility: KnowledgeFileVisibility;
    teamIds: string[];
    createdBy: string;
  }): Promise<KbDirectory> {
    return db.transaction(async (tx) => {
      const [directory] = await tx
        .insert(schema.kbDirectoriesTable)
        .values({
          organizationId: params.organizationId,
          name: params.name,
          visibility: params.visibility,
          createdBy: params.createdBy,
        })
        .returning();

      if (params.visibility === "team-scoped" && params.teamIds.length > 0) {
        await tx.insert(schema.kbDirectoryTeamsTable).values(
          params.teamIds.map((teamId) => ({
            directoryId: directory.id,
            teamId,
          })),
        );
      }
      return directory;
    });
  }

  static async update(params: {
    id: string;
    organizationId: string;
    name?: string;
    visibility?: KnowledgeFileVisibility;
    teamIds?: string[];
  }): Promise<KbDirectory | null> {
    return db.transaction(async (tx) => {
      const [directory] = await tx
        .update(schema.kbDirectoriesTable)
        .set({
          ...(params.name === undefined ? {} : { name: params.name }),
          ...(params.visibility === undefined
            ? {}
            : { visibility: params.visibility }),
        })
        .where(
          and(
            eq(schema.kbDirectoriesTable.id, params.id),
            eq(schema.kbDirectoriesTable.organizationId, params.organizationId),
          ),
        )
        .returning();
      if (!directory) return null;

      if (params.teamIds !== undefined) {
        await tx
          .delete(schema.kbDirectoryTeamsTable)
          .where(eq(schema.kbDirectoryTeamsTable.directoryId, directory.id));
        if (directory.visibility === "team-scoped" && params.teamIds.length) {
          await tx.insert(schema.kbDirectoryTeamsTable).values(
            params.teamIds.map((teamId) => ({
              directoryId: directory.id,
              teamId,
            })),
          );
        }
      }
      return directory;
    });
  }

  /** Files fall back to the repository root; their bytes are never destroyed. */
  static async delete(params: {
    id: string;
    organizationId: string;
  }): Promise<boolean> {
    const deleted = await db
      .delete(schema.kbDirectoriesTable)
      .where(
        and(
          eq(schema.kbDirectoriesTable.id, params.id),
          eq(schema.kbDirectoriesTable.organizationId, params.organizationId),
        ),
      )
      .returning({ id: schema.kbDirectoriesTable.id });
    return deleted.length > 0;
  }

  /**
   * Ids, names and visibility for a bulk route's audit record, on both sides of
   * the write. Team membership is the substance of a `team-scoped` change, so
   * it is carried here too or the diff would show nothing happened.
   */
  static async findVisibilityForBulkAudit(params: {
    ids: string[];
    organizationId: string;
  }): Promise<
    Array<{ id: string; name: string; visibility: string; teamIds: string[] }>
  > {
    const { ids, organizationId } = params;
    if (ids.length === 0) return [];

    const rows = await db
      .select({
        id: schema.kbDirectoriesTable.id,
        name: schema.kbDirectoriesTable.name,
        visibility: schema.kbDirectoriesTable.visibility,
      })
      .from(schema.kbDirectoriesTable)
      .where(
        and(
          inArray(schema.kbDirectoriesTable.id, ids),
          eq(schema.kbDirectoriesTable.organizationId, organizationId),
        ),
      )
      // Sorted so an unchanged batch snapshots identically on both sides.
      .orderBy(schema.kbDirectoriesTable.id);

    const teamRows = rows.length
      ? await db
          .select()
          .from(schema.kbDirectoryTeamsTable)
          .where(
            inArray(
              schema.kbDirectoryTeamsTable.directoryId,
              rows.map((row) => row.id),
            ),
          )
      : [];

    return rows.map((row) => ({
      ...row,
      teamIds: teamRows
        .filter((team) => team.directoryId === row.id)
        .map((team) => team.teamId)
        .sort(),
    }));
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const directory = await KbDirectoryModel.findById({
      id,
      organizationId,
    });
    if (!directory) return null;
    // Team membership is the substance of a `team-scoped` change, so the
    // snapshot has to carry it or the audit diff shows nothing happened.
    return {
      ...directory,
      teamIds: await KbDirectoryModel.findTeamIds(id),
    };
  }
}

export default KbDirectoryModel;
