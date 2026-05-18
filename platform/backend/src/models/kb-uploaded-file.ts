import { createHash } from "node:crypto";
import { and, count, desc, eq, ilike, inArray } from "drizzle-orm";
import db, { schema } from "@/database";

type KbUploadedFile = typeof schema.kbUploadedFilesTable.$inferSelect;
type KbUploadedFileInsert = typeof schema.kbUploadedFilesTable.$inferInsert;

const listColumns = {
  id: schema.kbUploadedFilesTable.id,
  connectorId: schema.kbUploadedFilesTable.connectorId,
  organizationId: schema.kbUploadedFilesTable.organizationId,
  originalName: schema.kbUploadedFilesTable.originalName,
  mimeType: schema.kbUploadedFilesTable.mimeType,
  fileSize: schema.kbUploadedFilesTable.fileSize,
  contentHash: schema.kbUploadedFilesTable.contentHash,
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
        ilike(schema.kbUploadedFilesTable.originalName, `%${params.search}%`),
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

  static async countByConnector(params: {
    connectorId: string;
    search?: string;
  }): Promise<number> {
    const conditions = [
      eq(schema.kbUploadedFilesTable.connectorId, params.connectorId),
    ];

    if (params.search) {
      conditions.push(
        ilike(schema.kbUploadedFilesTable.originalName, `%${params.search}%`),
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
  ): Promise<KbUploadedFile | null> {
    const [result] = await db
      .select()
      .from(schema.kbUploadedFilesTable)
      .where(
        and(
          eq(schema.kbUploadedFilesTable.connectorId, connectorId),
          eq(schema.kbUploadedFilesTable.contentHash, contentHash),
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
    params: Omit<KbUploadedFileInsert, "id" | "createdAt">,
  ): Promise<KbUploadedFile> {
    const [result] = await db
      .insert(schema.kbUploadedFilesTable)
      .values(params)
      .returning();
    return result;
  }

  static async updateProcessingStatus(
    id: string,
    status: string,
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

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.kbUploadedFilesTable)
      .where(eq(schema.kbUploadedFilesTable.id, id))
      .returning({ id: schema.kbUploadedFilesTable.id });
    return result.length > 0;
  }

  static computeContentHash(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
  }
}

export default KbUploadedFileModel;
