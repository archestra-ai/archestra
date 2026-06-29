import { and, asc, desc, eq, isNull } from "drizzle-orm";
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
   * Swap a file's storage pointer + content metadata in place (edit_file),
   * keeping the same id and filename. Byte I/O is the caller's job
   * ({@link FileStore.update} writes the new bytes and purges the old); this is
   * the row write only. Org-scoped as defense-in-depth. Returns null if the row
   * no longer exists.
   */
  static async updateContent(params: {
    id: string;
    organizationId: string;
    storageProvider: PersistedFile["storageProvider"];
    objectKey: string | null;
    data: Buffer | null;
    mimeType: string;
    sizeBytes: number;
  }): Promise<PersistedFile | null> {
    const [row] = await db
      .update(schema.filesTable)
      .set({
        data: params.data,
        storageProvider: params.storageProvider,
        objectKey: params.objectKey,
        mimeType: params.mimeType,
        sizeBytes: params.sizeBytes,
      })
      .where(
        and(
          eq(schema.filesTable.id, params.id),
          eq(schema.filesTable.organizationId, params.organizationId),
        ),
      )
      .returning();
    return row ? normalizeByteaField(row, "data") : null;
  }

  static async findById(id: string): Promise<PersistedFile | null> {
    const [row] = await db
      .select()
      .from(schema.filesTable)
      .where(eq(schema.filesTable.id, id));
    return row ? normalizeByteaField(row, "data") : null;
  }

  /**
   * A user's headless (no-project, no-conversation) file by name. The orphan
   * unique index makes the match at most one. Used so a headless `save_file`
   * with `overwrite` can replace the file it created on a previous run instead
   * of dead-ending on the orphan name collision.
   */
  static async findOrphanByName(params: {
    organizationId: string;
    userId: string;
    filename: string;
  }): Promise<PersistedFile | null> {
    const [row] = await db
      .select()
      .from(schema.filesTable)
      .where(
        and(
          eq(schema.filesTable.organizationId, params.organizationId),
          eq(schema.filesTable.userId, params.userId),
          eq(schema.filesTable.filename, params.filename),
          isNull(schema.filesTable.projectId),
          isNull(schema.filesTable.conversationId),
        ),
      );
    return row ? normalizeByteaField(row, "data") : null;
  }

  /**
   * One project file by exact name. The partial unique index on
   * `(project_id, filename)` makes the match at most one. Used to resolve a
   * project's reserved files (e.g. `instructions.md`) by name without going
   * through the listing path.
   */
  static async findByProjectAndName(params: {
    organizationId: string;
    projectId: string;
    filename: string;
  }): Promise<PersistedFile | null> {
    const [row] = await db
      .select()
      .from(schema.filesTable)
      .where(
        and(
          eq(schema.filesTable.organizationId, params.organizationId),
          eq(schema.filesTable.projectId, params.projectId),
          eq(schema.filesTable.filename, params.filename),
        ),
      );
    return row ? normalizeByteaField(row, "data") : null;
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

  /**
   * The user's no-project files in one conversation (newest first), metadata
   * only. This is the personal "My Files" scope after no-project files became
   * conversation-scoped: a chat sees only its own files, never another
   * conversation's. Project files are excluded (they use {@link listByProject}).
   */
  static async listNoProjectByConversation(params: {
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
          isNull(schema.filesTable.projectId),
        ),
      )
      .orderBy(desc(schema.filesTable.createdAt));
  }

  /**
   * Every no-project file produced in one conversation (any author), with the
   * storage pointer needed to purge external bytes. Used to clean up a
   * conversation's files when it is deleted — project files (which outlive the
   * conversation) are excluded.
   */
  static async listNoProjectFilesForConversation(params: {
    organizationId: string;
    conversationId: string;
  }): Promise<SandboxArtifactRow[]> {
    return db
      .select(artifactColumns)
      .from(schema.filesTable)
      .where(
        and(
          eq(schema.filesTable.organizationId, params.organizationId),
          eq(schema.filesTable.conversationId, params.conversationId),
          isNull(schema.filesTable.projectId),
        ),
      );
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
