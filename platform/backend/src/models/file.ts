import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  PersistedFile,
  SandboxArtifactRow,
  SkillSandboxFileStorageProvider,
} from "@/types";
import { normalizeByteaField } from "@/utils/normalize-bytea";

type PersistedFileMeta = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
};

const artifactColumns = {
  id: schema.filesTable.id,
  filename: schema.filesTable.filename,
  mimeType: schema.filesTable.mimeType,
  sizeBytes: schema.filesTable.sizeBytes,
  createdAt: schema.filesTable.createdAt,
  storageProvider: schema.filesTable.storageProvider,
  objectKey: schema.filesTable.objectKey,
  projectId: schema.filesTable.projectId,
} as const;

/**
 * Row CRUD for persistent user files (`files` table). Bytes live behind the
 * object-store seam; the orchestration that writes bytes then inserts the
 * row (with rollback) lives in `FileStore`, so this model is pure data access.
 */
class FileModel {
  /**
   * Insert one row whose bytes have already been persisted by `FileStore`. A
   * duplicate filename in the owner scope (the partial unique indexes) surfaces
   * as {@link FileNameExistsError}.
   */
  static async insertRow(params: {
    organizationId: string;
    /** Author — whoever produced the file. */
    userId: string;
    /** Owning project; null = the author's own file. */
    projectId: string | null;
    conversationId: string | null;
    /** Producing sandbox — provenance only. */
    sandboxId?: string | null;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    storageProvider: SkillSandboxFileStorageProvider;
    /** Bytes when storageProvider = 'db'; null when objectKey is set. */
    data: Buffer | null;
    objectKey: string | null;
  }): Promise<PersistedFile> {
    let row: PersistedFile | undefined;
    try {
      [row] = await db
        .insert(schema.filesTable)
        .values({
          organizationId: params.organizationId,
          userId: params.userId,
          projectId: params.projectId,
          conversationId: params.conversationId,
          sandboxId: params.sandboxId ?? null,
          filename: params.filename,
          mimeType: params.mimeType,
          sizeBytes: params.sizeBytes,
          data: params.data,
          storageProvider: params.storageProvider,
          objectKey: params.objectKey,
        })
        .returning();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new FileNameExistsError(params.filename);
      }
      throw error;
    }
    if (!row) throw new Error("failed to insert file");
    return normalizeByteaField(row, "data");
  }

  /**
   * Replace a file's bytes in place (edit_file), keeping the same id and
   * filename. The caller passes the existing row (already authorized). Stores
   * the new bytes first, then swaps the row; on failure the just-stored bytes
   * are cleaned up, and on success any previous blob at a different location is
   * dropped (no-op under the db provider). The update is org-scoped as
   * defense-in-depth. Returns null if the row no longer exists.
   */
  static async updateContent(params: {
    file: PersistedFile;
    mimeType: string;
    sizeBytes: number;
    data: Buffer;
  }): Promise<PersistedFile | null> {
    const { file } = params;
    const stored = await getFileBytesStorage().put({
      fileId: file.id,
      filename: file.filename,
      data: params.data,
    });
    let row: PersistedFile | undefined;
    try {
      [row] = await db
        .update(schema.filesTable)
        .set({
          data: stored.dbData,
          storageProvider: stored.provider,
          objectKey: stored.objectKey,
          mimeType: params.mimeType,
          sizeBytes: params.sizeBytes,
        })
        .where(
          and(
            eq(schema.filesTable.id, file.id),
            eq(schema.filesTable.organizationId, file.organizationId),
          ),
        )
        .returning();
    } catch (error) {
      await getFileBytesStorage()
        .delete(stored)
        .catch(() => {});
      throw error;
    }
    if (!row) {
      await getFileBytesStorage()
        .delete(stored)
        .catch(() => {});
      return null;
    }
    // Drop the old blob only if it lived elsewhere (e.g. a future external
    // backend with non-deterministic keys); same-key/db updates overwrite.
    if (
      file.objectKey !== stored.objectKey ||
      file.storageProvider !== stored.provider
    ) {
      await getFileBytesStorage()
        .delete({ provider: file.storageProvider, objectKey: file.objectKey })
        .catch(() => {});
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

  /** The user's own files (newest first), metadata only: project files excluded. */
  static async listForUser(params: {
    organizationId: string;
    userId: string;
  }): Promise<SandboxArtifactRow[]> {
    return db
      .select(artifactColumns)
      .from(schema.filesTable)
      .where(
        and(
          eq(schema.filesTable.organizationId, params.organizationId),
          eq(schema.filesTable.userId, params.userId),
          isNull(schema.filesTable.projectId),
        ),
      )
      .orderBy(desc(schema.filesTable.createdAt));
  }

  /** Files belonging to one project (newest first), any author; org-scoped. */
  static async listByProject(params: {
    organizationId: string;
    projectId: string;
  }): Promise<SandboxArtifactRow[]> {
    return db
      .select(artifactColumns)
      .from(schema.filesTable)
      .where(
        and(
          eq(schema.filesTable.organizationId, params.organizationId),
          eq(schema.filesTable.projectId, params.projectId),
        ),
      )
      .orderBy(desc(schema.filesTable.createdAt));
  }

  /** Files belonging to any of the given projects (newest first); org-scoped. */
  static async listByProjects(params: {
    organizationId: string;
    projectIds: string[];
  }): Promise<SandboxArtifactRow[]> {
    if (params.projectIds.length === 0) return [];
    return db
      .select(artifactColumns)
      .from(schema.filesTable)
      .where(
        and(
          eq(schema.filesTable.organizationId, params.organizationId),
          inArray(schema.filesTable.projectId, params.projectIds),
        ),
      )
      .orderBy(desc(schema.filesTable.createdAt));
  }

  /** Files the user authored in one conversation, newest first. */
  static async listByConversation(params: {
    organizationId: string;
    userId: string;
    conversationId: string;
  }): Promise<SandboxArtifactRow[]> {
    return db
      .select(artifactColumns)
      .from(schema.filesTable)
      .where(
        and(
          eq(schema.filesTable.organizationId, params.organizationId),
          eq(schema.filesTable.conversationId, params.conversationId),
          eq(schema.filesTable.userId, params.userId),
        ),
      )
      .orderBy(desc(schema.filesTable.createdAt));
  }

  /** File metadata (no bytes) produced in a conversation, any author, oldest first. */
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

  static async deleteById(id: string): Promise<void> {
    await db.delete(schema.filesTable).where(eq(schema.filesTable.id, id));
  }
}

export default FileModel;

/** A file with this name already exists in the owner scope (user or project). */
export class FileNameExistsError extends Error {
  constructor(filename: string) {
    super(`a file named "${filename}" already exists`);
    this.name = "FileNameExistsError";
  }
}

// === internal ===

/** Postgres unique_violation, as surfaced by the pg and PGlite drivers. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: string }).code;
  const cause = (error as { cause?: { code?: string } }).cause;
  return code === "23505" || cause?.code === "23505";
}
