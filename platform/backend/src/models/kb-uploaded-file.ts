import { createHash } from "node:crypto";
import type { ResourceVisibilityScope } from "@shared";
import { and, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type { UploadedFileProcessingStatus } from "@/types";
import { escapeLikePattern } from "@/utils/sql-search";

type KbUploadedFile = typeof schema.kbUploadedFilesTable.$inferSelect;
type KbUploadedFileInsert = typeof schema.kbUploadedFilesTable.$inferInsert;

const listColumns = {
  id: schema.kbUploadedFilesTable.id,
  connectorId: schema.kbUploadedFilesTable.connectorId,
  organizationId: schema.kbUploadedFilesTable.organizationId,
  ownerId: schema.kbUploadedFilesTable.ownerId,
  visibility: schema.kbUploadedFilesTable.visibility,
  teamIds: schema.kbUploadedFilesTable.teamIds,
  originalName: schema.kbUploadedFilesTable.originalName,
  mimeType: schema.kbUploadedFilesTable.mimeType,
  fileSize: schema.kbUploadedFilesTable.fileSize,
  contentHash: schema.kbUploadedFilesTable.contentHash,
  blobStorageProvider: schema.kbUploadedFilesTable.blobStorageProvider,
  blobStorageKey: schema.kbUploadedFilesTable.blobStorageKey,
  processingStatus: schema.kbUploadedFilesTable.processingStatus,
  processingError: schema.kbUploadedFilesTable.processingError,
  createdAt: schema.kbUploadedFilesTable.createdAt,
} as const;

class KbUploadedFileModel {
  static async findByConnector(
    connectorId: string,
  ): Promise<Omit<KbUploadedFile, "fileData">[]> {
    return db
      .select(listColumns)
      .from(schema.kbUploadedFilesTable)
      .where(eq(schema.kbUploadedFilesTable.connectorId, connectorId));
  }

  static async findByConnectorPaginated(params: {
    connectorId: string;
    limit: number;
    offset: number;
    search?: string;
  }): Promise<Omit<KbUploadedFile, "fileData">[]> {
    const conditions = [
      eq(schema.kbUploadedFilesTable.connectorId, params.connectorId),
    ];

    if (params.search) {
      conditions.push(
        ilike(
          schema.kbUploadedFilesTable.originalName,
          `%${escapeLikePattern(params.search)}%`,
        ),
      );
    }

    return db
      .select(listColumns)
      .from(schema.kbUploadedFilesTable)
      .where(and(...conditions))
      .orderBy(desc(schema.kbUploadedFilesTable.createdAt))
      .limit(params.limit)
      .offset(params.offset);
  }

  static async findByOrganizationPaginated(params: {
    organizationId: string;
    userId: string;
    userTeamIds: string[];
    canReadAll: boolean;
    limit: number;
    offset: number;
    search?: string;
  }): Promise<Omit<KbUploadedFile, "fileData">[]> {
    const conditions = [
      eq(schema.kbUploadedFilesTable.organizationId, params.organizationId),
      buildVisibilityFilter({
        userId: params.userId,
        userTeamIds: params.userTeamIds,
        canReadAll: params.canReadAll,
      }),
    ];

    if (params.search) {
      conditions.push(
        ilike(
          schema.kbUploadedFilesTable.originalName,
          `%${escapeLikePattern(params.search)}%`,
        ),
      );
    }

    return db
      .select(listColumns)
      .from(schema.kbUploadedFilesTable)
      .where(and(...conditions))
      .orderBy(desc(schema.kbUploadedFilesTable.createdAt))
      .limit(params.limit)
      .offset(params.offset);
  }

  static async countByOrganization(params: {
    organizationId: string;
    userId: string;
    userTeamIds: string[];
    canReadAll: boolean;
    search?: string;
  }): Promise<number> {
    const conditions = [
      eq(schema.kbUploadedFilesTable.organizationId, params.organizationId),
      buildVisibilityFilter({
        userId: params.userId,
        userTeamIds: params.userTeamIds,
        canReadAll: params.canReadAll,
      }),
    ];

    if (params.search) {
      conditions.push(
        ilike(
          schema.kbUploadedFilesTable.originalName,
          `%${escapeLikePattern(params.search)}%`,
        ),
      );
    }

    const [result] = await db
      .select({ value: count() })
      .from(schema.kbUploadedFilesTable)
      .where(and(...conditions));
    return result?.value ?? 0;
  }

  static async countByConnector(params: {
    connectorId: string;
    search?: string;
  }): Promise<number> {
    const conditions = [
      eq(schema.kbUploadedFilesTable.connectorId, params.connectorId),
    ];

    if (params.search) {
      conditions.push(
        ilike(
          schema.kbUploadedFilesTable.originalName,
          `%${escapeLikePattern(params.search)}%`,
        ),
      );
    }

    const [result] = await db
      .select({ value: count() })
      .from(schema.kbUploadedFilesTable)
      .where(and(...conditions));
    return result?.value ?? 0;
  }

  static async findByContentHash(
    connectorId: string,
    contentHash: string,
  ): Promise<Omit<KbUploadedFile, "fileData"> | null> {
    const [result] = await db
      .select(listColumns)
      .from(schema.kbUploadedFilesTable)
      .where(
        and(
          eq(schema.kbUploadedFilesTable.connectorId, connectorId),
          eq(schema.kbUploadedFilesTable.contentHash, contentHash),
        ),
      );
    return result ?? null;
  }

  static async findByOrganizationContentHash(params: {
    organizationId: string;
    contentHash: string;
  }): Promise<Omit<KbUploadedFile, "fileData"> | null> {
    const [result] = await db
      .select(listColumns)
      .from(schema.kbUploadedFilesTable)
      .where(
        and(
          eq(schema.kbUploadedFilesTable.organizationId, params.organizationId),
          eq(schema.kbUploadedFilesTable.contentHash, params.contentHash),
        ),
      );
    return result ?? null;
  }

  static async findById(
    id: string,
  ): Promise<Omit<KbUploadedFile, "fileData"> | null> {
    const [result] = await db
      .select(listColumns)
      .from(schema.kbUploadedFilesTable)
      .where(eq(schema.kbUploadedFilesTable.id, id));
    return result ?? null;
  }

  static async findByIdWithData(id: string): Promise<KbUploadedFile | null> {
    const [result] = await db
      .select()
      .from(schema.kbUploadedFilesTable)
      .where(eq(schema.kbUploadedFilesTable.id, id));
    return result ?? null;
  }

  static async findByIdsWithData(ids: string[]): Promise<KbUploadedFile[]> {
    if (ids.length === 0) return [];
    return db
      .select()
      .from(schema.kbUploadedFilesTable)
      .where(inArray(schema.kbUploadedFilesTable.id, ids));
  }

  static async create(
    params: Omit<KbUploadedFileInsert, "createdAt">,
  ): Promise<KbUploadedFile> {
    const [result] = await db
      .insert(schema.kbUploadedFilesTable)
      .values(params)
      .returning();
    return result;
  }

  static async updateProcessingStatus(
    id: string,
    status: UploadedFileProcessingStatus,
    error?: string | null,
  ): Promise<void> {
    await db
      .update(schema.kbUploadedFilesTable)
      .set({
        processingStatus: status,
        processingError: error ?? null,
      })
      .where(eq(schema.kbUploadedFilesTable.id, id));
  }

  static async updateVisibility(params: {
    id: string;
    visibility: ResourceVisibilityScope;
    teamIds: string[];
  }): Promise<Omit<KbUploadedFile, "fileData"> | null> {
    const [result] = await db
      .update(schema.kbUploadedFilesTable)
      .set({
        visibility: params.visibility,
        teamIds: params.teamIds,
      })
      .where(eq(schema.kbUploadedFilesTable.id, params.id))
      .returning(listColumns);
    return result ?? null;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.kbUploadedFilesTable)
      .where(eq(schema.kbUploadedFilesTable.id, id))
      .returning({ id: schema.kbUploadedFilesTable.id });
    return result.length > 0;
  }

  static async deleteKnowledgeFileGraph(params: {
    fileId: string;
    connectorId: string;
  }): Promise<void> {
    await withDbTransaction(async (tx) => {
      await tx
        .delete(schema.kbDocumentsTable)
        .where(
          and(
            eq(schema.kbDocumentsTable.connectorId, params.connectorId),
            eq(schema.kbDocumentsTable.sourceId, params.fileId),
          ),
        );
      await tx
        .delete(schema.kbUploadedFilesTable)
        .where(eq(schema.kbUploadedFilesTable.id, params.fileId));
      // Deleting the connector cascades agent connector assignments through
      // the connector FK.
      await tx
        .delete(schema.knowledgeBaseConnectorsTable)
        .where(eq(schema.knowledgeBaseConnectorsTable.id, params.connectorId));
    });
  }

  static computeContentHash(content: Buffer | string): string {
    return createHash("sha256").update(content).digest("hex");
  }
}

export default KbUploadedFileModel;

function buildVisibilityFilter(params: {
  userId: string;
  userTeamIds: string[];
  canReadAll: boolean;
}) {
  if (params.canReadAll) {
    return undefined;
  }

  const personalFilter = and(
    eq(schema.kbUploadedFilesTable.visibility, "personal"),
    eq(schema.kbUploadedFilesTable.ownerId, params.userId),
  );
  const orgFilter = eq(schema.kbUploadedFilesTable.visibility, "org");

  if (params.userTeamIds.length === 0) {
    return or(personalFilter, orgFilter);
  }

  const teamIds = sql.join(
    params.userTeamIds.map((teamId) => sql`${teamId}`),
    sql`, `,
  );

  return or(
    personalFilter,
    orgFilter,
    sql`(
      ${schema.kbUploadedFilesTable.visibility} = 'team'
      AND ${schema.kbUploadedFilesTable.teamIds} ?| ARRAY[${teamIds}]
    )`,
  );
}
