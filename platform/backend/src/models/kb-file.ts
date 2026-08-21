import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
import type { KnowledgeFileVisibility } from "@/types/knowledge-file";

/**
 * Who a caller is, for repository-listing purposes.
 *
 * Retrieval ACLs are enforced at chunk-query time, which does nothing for a
 * direct read of the repository — so listing and download authorize on these
 * fields per row instead.
 */
export interface KbFileViewer {
  userId: string;
  teamIds: string[];
  /** Knowledge admins see the whole repository, including private files. */
  canManageAll: boolean;
}

class KbFileModel {
  static async findPaginated(params: {
    organizationId: string;
    viewer: KbFileViewer;
    directoryId?: string | null;
    search?: string;
    limit: number;
    offset: number;
  }) {
    const where = and(
      eq(schema.kbFilesTable.organizationId, params.organizationId),
      KbFileModel.visibleTo(params.viewer),
      ...(params.directoryId === undefined
        ? []
        : [
            params.directoryId === null
              ? isNull(schema.kbFilesTable.directoryId)
              : eq(schema.kbFilesTable.directoryId, params.directoryId),
          ]),
      ...(params.search
        ? [ilike(schema.kbFilesTable.filename, `%${params.search}%`)]
        : []),
    );

    const [rows, [totals]] = await Promise.all([
      db
        .select()
        .from(schema.kbFilesTable)
        .where(where)
        .orderBy(desc(schema.kbFilesTable.createdAt))
        .limit(params.limit)
        .offset(params.offset),
      db.select({ total: count() }).from(schema.kbFilesTable).where(where),
    ]);

    return { items: rows, total: totals?.total ?? 0 };
  }

  static async findById(params: {
    id: string;
    organizationId: string;
    viewer: KbFileViewer;
  }) {
    const [row] = await db
      .select()
      .from(schema.kbFilesTable)
      .where(
        and(
          eq(schema.kbFilesTable.id, params.id),
          eq(schema.kbFilesTable.organizationId, params.organizationId),
          KbFileModel.visibleTo(params.viewer),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  static async findManyByIds(params: {
    ids: string[];
    organizationId: string;
    viewer: KbFileViewer;
  }) {
    if (params.ids.length === 0) return [];
    return db
      .select()
      .from(schema.kbFilesTable)
      .where(
        and(
          inArray(schema.kbFilesTable.id, params.ids),
          eq(schema.kbFilesTable.organizationId, params.organizationId),
          KbFileModel.visibleTo(params.viewer),
        ),
      );
  }

  static async create(params: {
    organizationId: string;
    directoryId: string | null;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    contentHash: string;
    data: Buffer;
    visibility: KnowledgeFileVisibility;
    teamIds: string[];
    uploadedBy: string;
  }) {
    return db.transaction(async (tx) => {
      const [file] = await tx
        .insert(schema.kbFilesTable)
        .values({
          organizationId: params.organizationId,
          directoryId: params.directoryId,
          filename: params.filename,
          mimeType: params.mimeType,
          sizeBytes: params.sizeBytes,
          contentHash: params.contentHash,
          storageProvider: "db",
          data: params.data,
          visibility: params.visibility,
          uploadedBy: params.uploadedBy,
        })
        .returning();

      if (params.visibility === "team-scoped" && params.teamIds.length > 0) {
        await tx
          .insert(schema.kbFileTeamsTable)
          .values(
            params.teamIds.map((teamId) => ({ kbFileId: file.id, teamId })),
          );
      }
      return file;
    });
  }

  static async update(params: {
    id: string;
    organizationId: string;
    filename?: string;
    directoryId?: string | null;
    visibility?: KnowledgeFileVisibility;
    teamIds?: string[];
  }) {
    return db.transaction(async (tx) => {
      const [file] = await tx
        .update(schema.kbFilesTable)
        .set({
          ...(params.filename === undefined
            ? {}
            : { filename: params.filename }),
          ...(params.directoryId === undefined
            ? {}
            : { directoryId: params.directoryId }),
          ...(params.visibility === undefined
            ? {}
            : { visibility: params.visibility }),
        })
        .where(
          and(
            eq(schema.kbFilesTable.id, params.id),
            eq(schema.kbFilesTable.organizationId, params.organizationId),
          ),
        )
        .returning();
      if (!file) return null;

      if (params.teamIds !== undefined) {
        await tx
          .delete(schema.kbFileTeamsTable)
          .where(eq(schema.kbFileTeamsTable.kbFileId, file.id));
        if (file.visibility === "team-scoped" && params.teamIds.length > 0) {
          await tx
            .insert(schema.kbFileTeamsTable)
            .values(
              params.teamIds.map((teamId) => ({ kbFileId: file.id, teamId })),
            );
        }
      }
      return file;
    });
  }

  static async findTeamIds(kbFileId: string): Promise<string[]> {
    const rows = await db
      .select({ teamId: schema.kbFileTeamsTable.teamId })
      .from(schema.kbFileTeamsTable)
      .where(eq(schema.kbFileTeamsTable.kbFileId, kbFileId));
    return rows.map((row) => row.teamId);
  }

  /** Team ids per file, batched so a listing does not query per row. */
  static async findTeamIdsForFiles(
    kbFileIds: string[],
  ): Promise<Map<string, string[]>> {
    if (kbFileIds.length === 0) return new Map();
    const rows = await db
      .select()
      .from(schema.kbFileTeamsTable)
      .where(inArray(schema.kbFileTeamsTable.kbFileId, kbFileIds));

    const byFile = new Map<string, string[]>();
    for (const row of rows) {
      const existing = byFile.get(row.kbFileId) ?? [];
      existing.push(row.teamId);
      byFile.set(row.kbFileId, existing);
    }
    return byFile;
  }

  /** Knowledge bases a file is currently indexed into, batched for a listing. */
  static async findKnowledgeBasesForFiles(kbFileIds: string[]) {
    if (kbFileIds.length === 0)
      return new Map<string, { id: string; name: string }[]>();

    const rows = await db
      .select({
        kbFileId: schema.kbFileDocumentsTable.kbFileId,
        knowledgeBaseId: schema.knowledgeBasesTable.id,
        knowledgeBaseName: schema.knowledgeBasesTable.name,
      })
      .from(schema.kbFileDocumentsTable)
      .innerJoin(
        schema.kbDocumentsTable,
        eq(
          schema.kbDocumentsTable.id,
          schema.kbFileDocumentsTable.kbDocumentId,
        ),
      )
      .innerJoin(
        schema.kbUploadConnectorsTable,
        eq(
          schema.kbUploadConnectorsTable.connectorId,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .innerJoin(
        schema.knowledgeBasesTable,
        eq(
          schema.knowledgeBasesTable.id,
          schema.kbUploadConnectorsTable.knowledgeBaseId,
        ),
      )
      .where(inArray(schema.kbFileDocumentsTable.kbFileId, kbFileIds));

    const byFile = new Map<string, { id: string; name: string }[]>();
    for (const row of rows) {
      const existing = byFile.get(row.kbFileId) ?? [];
      existing.push({ id: row.knowledgeBaseId, name: row.knowledgeBaseName });
      byFile.set(row.kbFileId, existing);
    }
    return byFile;
  }

  /**
   * Uploader emails for a set of files, batched. A `private` file resolves to a
   * `user_email:` token, so indexing needs the address; an offboarded uploader
   * yields null and the ACL fails closed rather than widening.
   */
  static async findUploaderEmails(
    kbFileIds: string[],
  ): Promise<Map<string, string | null>> {
    if (kbFileIds.length === 0) return new Map();
    const rows = await db
      .select({
        kbFileId: schema.kbFilesTable.id,
        email: schema.usersTable.email,
      })
      .from(schema.kbFilesTable)
      .leftJoin(
        schema.usersTable,
        eq(schema.usersTable.id, schema.kbFilesTable.uploadedBy),
      )
      .where(inArray(schema.kbFilesTable.id, kbFileIds));
    return new Map(rows.map((row) => [row.kbFileId, row.email ?? null]));
  }

  static async linkDocument(params: {
    kbFileId: string;
    kbDocumentId: string;
  }): Promise<void> {
    await db
      .insert(schema.kbFileDocumentsTable)
      .values(params)
      .onConflictDoNothing();
  }

  static async delete(params: {
    id: string;
    organizationId: string;
  }): Promise<boolean> {
    const deleted = await db
      .delete(schema.kbFilesTable)
      .where(
        and(
          eq(schema.kbFilesTable.id, params.id),
          eq(schema.kbFilesTable.organizationId, params.organizationId),
        ),
      )
      .returning({ id: schema.kbFilesTable.id });
    return deleted.length > 0;
  }

  /**
   * Ids, names and visibility for a bulk route's audit record, on both sides
   * of the write.
   *
   * Deliberately NOT viewer-filtered, unlike {@link findManyByIds}. Narrowing a
   * document's audience can put it out of the caller's own view, and a snapshot
   * that dropped it there would make a visibility change read as a deletion.
   * Organization ownership is the fence; the route has already decided what the
   * caller may touch.
   */
  static async findVisibilityForBulkAudit(params: {
    ids: string[];
    organizationId: string;
  }): Promise<
    Array<{
      id: string;
      filename: string;
      visibility: string;
      teamIds: string[];
    }>
  > {
    const { ids, organizationId } = params;
    if (ids.length === 0) return [];

    const rows = await db
      .select({
        id: schema.kbFilesTable.id,
        filename: schema.kbFilesTable.filename,
        visibility: schema.kbFilesTable.visibility,
      })
      .from(schema.kbFilesTable)
      .where(
        and(
          inArray(schema.kbFilesTable.id, ids),
          eq(schema.kbFilesTable.organizationId, organizationId),
        ),
      )
      // Sorted so an unchanged batch snapshots identically on both sides and
      // the audit diff stays empty; row order is unspecified.
      .orderBy(schema.kbFilesTable.id);

    const teamsByFile = await KbFileModel.findTeamIdsForFiles(
      rows.map((row) => row.id),
    );
    return rows.map((row) => ({
      ...row,
      teamIds: [...(teamsByFile.get(row.id) ?? [])].sort(),
    }));
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select({
        id: schema.kbFilesTable.id,
        organizationId: schema.kbFilesTable.organizationId,
        directoryId: schema.kbFilesTable.directoryId,
        filename: schema.kbFilesTable.filename,
        mimeType: schema.kbFilesTable.mimeType,
        sizeBytes: schema.kbFilesTable.sizeBytes,
        contentHash: schema.kbFilesTable.contentHash,
        visibility: schema.kbFilesTable.visibility,
        uploadedBy: schema.kbFilesTable.uploadedBy,
        createdAt: schema.kbFilesTable.createdAt,
      })
      .from(schema.kbFilesTable)
      .where(
        and(
          eq(schema.kbFilesTable.id, id),
          eq(schema.kbFilesTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!row) return null;
    return { ...row, teamIds: await KbFileModel.findTeamIds(id) };
  }

  // ===== Internal =====

  /**
   * Row-level visibility filter. `private` means the uploader only; a
   * `team-scoped` file needs the caller to share one of its teams. Written as
   * a WHERE fragment rather than a post-filter so pagination counts stay
   * truthful.
   */
  private static visibleTo(viewer: KbFileViewer) {
    if (viewer.canManageAll) return undefined;

    const teamClause = viewer.teamIds.length
      ? and(
          eq(schema.kbFilesTable.visibility, "team-scoped"),
          sql`EXISTS (
            SELECT 1 FROM ${schema.kbFileTeamsTable}
            WHERE ${schema.kbFileTeamsTable.kbFileId} = ${schema.kbFilesTable.id}
              AND ${schema.kbFileTeamsTable.teamId} IN ${viewer.teamIds}
          )`,
        )
      : undefined;

    return or(
      eq(schema.kbFilesTable.visibility, "org-wide"),
      and(
        eq(schema.kbFilesTable.visibility, "private"),
        eq(schema.kbFilesTable.uploadedBy, viewer.userId),
      ),
      ...(teamClause ? [teamClause] : []),
    );
  }
}

export default KbFileModel;
