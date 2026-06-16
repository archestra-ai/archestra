import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
} from "drizzle-orm";
import db, { schema } from "@/database";
import { getFileBytesStorage } from "@/skills-sandbox/file-storage";
import type {
  PersistedFile,
  SandboxArtifactRow,
  StorageNamespace,
} from "@/types";
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
 * `save_result` produce. Bytes go through the `FileBytesStorage` interface
 * (Postgres-only today; the per-row `storage_provider` is the seam for a
 * future backend).
 */
class FileModel {
  static async create(params: {
    organizationId: string;
    /** Author — whoever produced the file. */
    userId: string;
    /**
     * Whose storage the bytes belong to: the owning PROJECT for project
     * results, else the author. The Postgres backend ignores it (bytes live on
     * the row); it is the placement seam a future external backend would read.
     */
    namespace: StorageNamespace;
    conversationId: string | null;
    /** Producing sandbox — provenance only; omit when none (save_result). */
    sandboxId?: string | null;
    folderId?: string | null;
    /** Folder display name — placement hint for a future external backend. */
    folderName?: string | null;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    data: Buffer;
  }): Promise<PersistedFile> {
    // id is generated app-side so a future external storage backend can use it
    // as the collision fallback for an object key.
    const fileId = randomUUID();
    const stored = await getFileBytesStorage().put({
      fileId,
      filename: params.filename,
      data: params.data,
      namespace: params.namespace,
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
      await getFileBytesStorage()
        .delete(stored)
        .catch(() => {});
      throw error;
    }
    if (!row) {
      await getFileBytesStorage()
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
   * The user's PERSONAL My Files (newest first), metadata only: files they
   * authored that sit at the root or in one of their personal folders. Files
   * in PROJECT folders are excluded — those surface through the project
   * listing instead (so a member's own project file is never listed twice).
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
        folderName: schema.foldersTable.name,
      })
      .from(schema.filesTable)
      .leftJoin(
        schema.foldersTable,
        eq(schema.filesTable.folderId, schema.foldersTable.id),
      )
      .where(
        and(
          eq(schema.filesTable.organizationId, params.organizationId),
          eq(schema.filesTable.userId, params.userId),
          // root files, or files in a personal folder (project folders have a
          // null user_id) — never project-folder files.
          or(
            isNull(schema.filesTable.folderId),
            isNotNull(schema.foldersTable.userId),
          ),
        ),
      )
      .orderBy(desc(schema.filesTable.createdAt));
    return rows;
  }

  /**
   * Files sitting in the given folders (newest first), metadata only — the
   * project surfaces (My Files project section, project files API, chat panel
   * in a project chat). Any author; org-scoped.
   */
  static async listByFolders(params: {
    organizationId: string;
    folderIds: string[];
  }): Promise<SandboxArtifactRow[]> {
    if (params.folderIds.length === 0) return [];
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
        folderName: schema.foldersTable.name,
      })
      .from(schema.filesTable)
      .leftJoin(
        schema.foldersTable,
        eq(schema.filesTable.folderId, schema.foldersTable.id),
      )
      .where(
        and(
          eq(schema.filesTable.organizationId, params.organizationId),
          inArray(schema.filesTable.folderId, params.folderIds),
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
        folderName: schema.foldersTable.name,
      })
      .from(schema.filesTable)
      .leftJoin(
        schema.foldersTable,
        eq(schema.filesTable.folderId, schema.foldersTable.id),
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
