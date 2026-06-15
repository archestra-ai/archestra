import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, or } from "drizzle-orm";
import db, { schema } from "@/database";
import { getSandboxFileStorage } from "@/skills-sandbox/file-storage";
import type { PersistedFile, SandboxArtifactRow } from "@/types";
import { normalizeByteaField } from "@/utils/normalize-bytea";

/** File row without its bytes — what the chat Files panel needs. */
type PersistedFileMeta = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
};

/**
 * Persistent user files (`files` table) — everything `download_file` and
 * `save_result` produce. Bytes go through the sandbox storage router exactly
 * like the old artifact rows did (`kind: "artifact"` keeps the router's
 * provider dispatch unchanged).
 */
class FileModel {
  static async create(params: {
    organizationId: string;
    /** Author — whoever produced the file. */
    userId: string;
    /**
     * Storage namespace for filesystem-mode bytes: the FOLDER OWNER for
     * project results (the folder is a real directory in their tree), else
     * the author. Not a column — same role the old `createArtifact.userId`
     * param played.
     */
    namespaceUserId: string;
    conversationId: string | null;
    /** Producing sandbox — provenance only; omit when none (save_result). */
    sandboxId?: string | null;
    folderId?: string | null;
    /** Folder display name — used only to place filesystem-mode bytes. */
    folderName?: string | null;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    data: Buffer;
  }): Promise<PersistedFile> {
    // id is generated app-side because the filesystem storage provider uses
    // it as the collision fallback for the object key.
    const fileId = randomUUID();
    const stored = await getSandboxFileStorage().put({
      userId: params.namespaceUserId,
      fileId,
      kind: "artifact",
      filename: params.filename,
      data: params.data,
      folder: params.folderName ?? null,
    });
    let row: PersistedFile | undefined;
    try {
      [row] = await db
        .insert(schema.filesTable)
        .values({
          id: fileId,
          organizationId: params.organizationId,
          userId: params.userId,
          conversationId: params.conversationId,
          sandboxId: params.sandboxId ?? null,
          folderId: params.folderId ?? null,
          filename: params.filename,
          mimeType: params.mimeType,
          sizeBytes: params.sizeBytes,
          data: stored.dbData,
          storageProvider: stored.provider,
          objectKey: stored.objectKey,
        })
        .returning();
    } catch (error) {
      // bytes may already sit in the user's storage folder (filesystem
      // provider); remove them so a failed insert leaves no orphan behind.
      await getSandboxFileStorage()
        .delete(stored)
        .catch(() => {});
      throw error;
    }
    if (!row) {
      await getSandboxFileStorage()
        .delete(stored)
        .catch(() => {});
      throw new Error("failed to insert file");
    }
    return normalizeByteaField(row, "data");
  }

  static async findById(id: string): Promise<PersistedFile | null> {
    const [row] = await db
      .select()
      .from(schema.filesTable)
      .where(eq(schema.filesTable.id, id));
    return row ? normalizeByteaField(row, "data") : null;
  }

  /**
   * All files a user can see in My Files (newest first), metadata only.
   * Ownership has two faces, exactly as before the extraction: files the
   * user AUTHORED (`files.user_id`) and files sitting in a folder the user
   * OWNS (project folders collect results from every member's chats).
   */
  static async listForUser(params: {
    organizationId: string;
    userId: string;
  }): Promise<SandboxArtifactRow[]> {
    const rows = await db
      .select({
        id: schema.filesTable.id,
        filename: schema.filesTable.filename,
        mimeType: schema.filesTable.mimeType,
        sizeBytes: schema.filesTable.sizeBytes,
        createdAt: schema.filesTable.createdAt,
        storageProvider: schema.filesTable.storageProvider,
        objectKey: schema.filesTable.objectKey,
        folderId: schema.filesTable.folderId,
        folderName: schema.skillSandboxFoldersTable.name,
      })
      .from(schema.filesTable)
      .leftJoin(
        schema.skillSandboxFoldersTable,
        eq(schema.filesTable.folderId, schema.skillSandboxFoldersTable.id),
      )
      .where(
        and(
          eq(schema.filesTable.organizationId, params.organizationId),
          or(
            eq(schema.filesTable.userId, params.userId),
            eq(schema.skillSandboxFoldersTable.userId, params.userId),
          ),
        ),
      )
      .orderBy(desc(schema.filesTable.createdAt));
    return rows;
  }

  /** Files the user authored in one conversation, newest first. */
  static async listByConversation(params: {
    organizationId: string;
    userId: string;
    conversationId: string;
  }): Promise<SandboxArtifactRow[]> {
    const rows = await db
      .select({
        id: schema.filesTable.id,
        filename: schema.filesTable.filename,
        mimeType: schema.filesTable.mimeType,
        sizeBytes: schema.filesTable.sizeBytes,
        createdAt: schema.filesTable.createdAt,
        storageProvider: schema.filesTable.storageProvider,
        objectKey: schema.filesTable.objectKey,
        folderId: schema.filesTable.folderId,
        folderName: schema.skillSandboxFoldersTable.name,
      })
      .from(schema.filesTable)
      .leftJoin(
        schema.skillSandboxFoldersTable,
        eq(schema.filesTable.folderId, schema.skillSandboxFoldersTable.id),
      )
      .where(
        and(
          eq(schema.filesTable.organizationId, params.organizationId),
          eq(schema.filesTable.conversationId, params.conversationId),
          eq(schema.filesTable.userId, params.userId),
        ),
      )
      .orderBy(desc(schema.filesTable.createdAt));
    return rows;
  }

  /**
   * File metadata (no bytes) produced in a conversation, any author, oldest
   * first — the chat Files panel's "generated" section. Org filter prevents a
   * conversation id reused across orgs from leaking.
   */
  static async listMetadataByConversationId(params: {
    conversationId: string;
    organizationId: string;
  }): Promise<PersistedFileMeta[]> {
    return db
      .select({
        id: schema.filesTable.id,
        filename: schema.filesTable.filename,
        mimeType: schema.filesTable.mimeType,
        sizeBytes: schema.filesTable.sizeBytes,
        createdAt: schema.filesTable.createdAt,
      })
      .from(schema.filesTable)
      .where(
        and(
          eq(schema.filesTable.conversationId, params.conversationId),
          eq(schema.filesTable.organizationId, params.organizationId),
        ),
      )
      .orderBy(asc(schema.filesTable.createdAt), asc(schema.filesTable.id));
  }

  /** Remove a file row. External bytes are the storage router's job. */
  static async deleteById(id: string): Promise<void> {
    await db.delete(schema.filesTable).where(eq(schema.filesTable.id, id));
  }
}

export default FileModel;
