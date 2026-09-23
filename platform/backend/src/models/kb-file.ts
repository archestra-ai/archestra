import type { ResourcePermissionGrant } from "@archestra/shared";
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
import CreatedByModel from "./created-by";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import { knowledgeScope } from "./resource-permission-target";

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
    /** File ids matching a `?labels=` filter; omit when not filtering. */
    labelFilteredIds?: string[];
    limit: number;
    offset: number;
  }) {
    const where = and(
      eq(schema.kbFilesTable.organizationId, params.organizationId),
      KbFileModel.visibleTo(params.viewer),
      ...(params.labelFilteredIds !== undefined
        ? [inArray(schema.kbFilesTable.id, params.labelFilteredIds)]
        : []),
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
    /** Explicit starting audience; omitted derives one from the visibility. */
    initialPermissionGrants?: ResourcePermissionGrant[];
  }) {
    return db.transaction(async (tx) => {
      const [file] = await tx
        .insert(schema.kbFilesTable)
        .values(
          await CreatedByModel.forInsert({
            data: {
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
            },
            userIdField: "uploadedBy",
            transaction: tx,
          }),
        )
        .returning();
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      await ResourcePermissionPolicyModel.createInitial({
        tx,
        organizationId: file.organizationId,
        resource: "knowledgeFile",
        scope: file.id,
        grants: params.initialPermissionGrants,
        authorId: file.uploadedBy,
        visibility: knowledgeScope(file.visibility),
        teams: params.teamIds.map((id) => ({ id })),
      });
      // SPDX-SnippetEnd

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

  /** Client-chosen UUID makes external uploads retryable without filename matching. */
  static async upsertContent(params: {
    id: string;
    organizationId: string;
    uploadedBy: string;
    filename: string;
    mimeType: string;
    data: Buffer;
    contentHash: string;
  }) {
    const content = {
      filename: params.filename,
      mimeType: params.mimeType,
      data: params.data,
      sizeBytes: params.data.byteLength,
      contentHash: params.contentHash,
      storageProvider: "db" as const,
      objectKey: null,
    };
    return db.transaction(async (tx) => {
      const [file] = await tx
        .insert(schema.kbFilesTable)
        .values(
          await CreatedByModel.forInsert({
            data: {
              ...content,
              id: params.id,
              organizationId: params.organizationId,
              uploadedBy: params.uploadedBy,
            },
            userIdField: "uploadedBy",
            transaction: tx,
          }),
        )
        .onConflictDoUpdate({
          target: schema.kbFilesTable.id,
          set: content,
          setWhere: and(
            eq(schema.kbFilesTable.organizationId, params.organizationId),
            eq(schema.kbFilesTable.uploadedBy, params.uploadedBy),
            eq(schema.kbFilesTable.storageProvider, "db"),
          ),
        })
        .returning();
      if (!file) return null;
      const policies = schema.resourcePermissionPoliciesTable;
      const [existing] = await tx
        .select({ scope: policies.scope })
        .from(policies)
        .where(
          and(
            eq(policies.organizationId, params.organizationId),
            eq(policies.resource, "knowledgeFile"),
            eq(policies.scope, file.id),
          ),
        )
        .limit(1);
      if (!existing)
        await ResourcePermissionPolicyModel.createInitial({
          tx,
          organizationId: params.organizationId,
          resource: "knowledgeFile",
          scope: file.id,
          authorId: params.uploadedBy,
          grants: [],
        });
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
  static async findKnowledgeBasesForFiles(
    kbFileIds: string[],
    viewer?: KbFileViewer,
  ) {
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
      .where(
        and(
          inArray(schema.kbFileDocumentsTable.kbFileId, kbFileIds),
          isNull(schema.knowledgeBasesTable.deletedAt),
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          viewer
            ? ResourcePermissionPolicyModel.grantCondition({
                organizationId: schema.knowledgeBasesTable.organizationId,
                resource: "knowledgeBase",
                scopeColumn: schema.knowledgeBasesTable.id,
                userId: viewer.userId,
                action: "read",
              })
            : undefined,
          // SPDX-SnippetEnd
        ),
      );

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
        createdByServiceAccountId:
          schema.kbFilesTable.createdByServiceAccountId,
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
   * Row-level visibility filter: a read grant on the file, or at `*`. Written
   * as a WHERE fragment rather than a post-filter so pagination counts stay
   * truthful.
   */
  private static visibleTo(viewer: KbFileViewer) {
    const table = schema.kbFilesTable;
    return ResourcePermissionPolicyModel.grantCondition({
      organizationId: table.organizationId,
      resource: "knowledgeFile",
      scopeColumn: table.id,
      userId: viewer.userId,
      action: "read",
    });
  }
}

export default KbFileModel;
