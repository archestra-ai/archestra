import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";

export type KbUploadedFile = typeof schema.kbUploadedFilesTable.$inferSelect;
type KbUploadedFileInsert = typeof schema.kbUploadedFilesTable.$inferInsert;

class KbUploadedFileModel {
  static async findByConnector(
    connectorId: string,
  ): Promise<Omit<KbUploadedFile, "fileData">[]> {
    return db
      .select({
        id: schema.kbUploadedFilesTable.id,
        connectorId: schema.kbUploadedFilesTable.connectorId,
        organizationId: schema.kbUploadedFilesTable.organizationId,
        originalName: schema.kbUploadedFilesTable.originalName,
        mimeType: schema.kbUploadedFilesTable.mimeType,
        fileSize: schema.kbUploadedFilesTable.fileSize,
        contentHash: schema.kbUploadedFilesTable.contentHash,
        createdAt: schema.kbUploadedFilesTable.createdAt,
      })
      .from(schema.kbUploadedFilesTable)
      .where(eq(schema.kbUploadedFilesTable.connectorId, connectorId));
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
      .select({
        id: schema.kbUploadedFilesTable.id,
        connectorId: schema.kbUploadedFilesTable.connectorId,
        organizationId: schema.kbUploadedFilesTable.organizationId,
        originalName: schema.kbUploadedFilesTable.originalName,
        mimeType: schema.kbUploadedFilesTable.mimeType,
        fileSize: schema.kbUploadedFilesTable.fileSize,
        contentHash: schema.kbUploadedFilesTable.contentHash,
        createdAt: schema.kbUploadedFilesTable.createdAt,
      })
      .from(schema.kbUploadedFilesTable)
      .where(eq(schema.kbUploadedFilesTable.id, id));
    return result ?? null;
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
