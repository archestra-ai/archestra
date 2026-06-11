import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNotNull, or } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  getSandboxFileStorage,
  storageFilename,
} from "@/skills-sandbox/file-storage";
import type {
  InsertSkillSandboxFile,
  SandboxArtifactRow,
  SkillSandboxFile,
} from "@/types";
import { normalizeByteaField } from "@/utils/normalize-bytea";

/** Artifact row without its bytes — what the Files panel needs to list outputs. */
type SkillSandboxArtifactMeta = {
  id: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
};

/**
 * Read/write access to `skill_sandbox_files` for the `artifact` role — output
 * bytes exported via `download_file`. Uploaded inputs (`kind = 'upload'`) are
 * written by `SkillSandboxReplayEventModel` inside the replay-log transaction,
 * so they are not created here.
 */
class SkillSandboxFileModel {
  static async createArtifact(
    artifact: Omit<
      InsertSkillSandboxFile,
      "kind" | "data" | "storageProvider" | "objectKey" | "folderId"
    > & {
      data: Buffer;
      /** Sandbox owner — names the per-user storage folder. Not a column. */
      userId: string;
      /** PFS folder to export into; both halves resolved by the caller. */
      folderId?: string | null;
      folderName?: string | null;
    },
  ): Promise<SkillSandboxFile> {
    const { userId, folderId, folderName, ...fileFields } = artifact;
    // id is generated app-side (not by the column default) because the
    // storage adapter needs it before the insert: the filesystem provider
    // uses it as the collision fallback for the object key.
    const fileId = randomUUID();
    const stored = await getSandboxFileStorage().put({
      userId,
      fileId,
      kind: "artifact",
      filename: storageFilename({ originalName: null, path: fileFields.path }),
      data: fileFields.data,
      folder: folderName ?? null,
    });
    let row: SkillSandboxFile | undefined;
    try {
      [row] = await db
        .insert(schema.skillSandboxFilesTable)
        .values({
          ...fileFields,
          id: fileId,
          kind: "artifact",
          data: stored.dbData,
          storageProvider: stored.provider,
          objectKey: stored.objectKey,
          folderId: folderId ?? null,
        })
        .returning();
    } catch (error) {
      // the bytes may already sit in the user's outbox (filesystem provider);
      // remove them so a failed insert leaves no orphan file behind.
      await getSandboxFileStorage()
        .delete(stored)
        .catch(() => {});
      throw error;
    }
    if (!row) {
      await getSandboxFileStorage()
        .delete(stored)
        .catch(() => {});
      throw new Error("failed to insert sandbox artifact");
    }
    return normalizeByteaField(row, "data");
  }

  static async findArtifactById(id: string): Promise<SkillSandboxFile | null> {
    const [row] = await db
      .select()
      .from(schema.skillSandboxFilesTable)
      .where(
        and(
          eq(schema.skillSandboxFilesTable.id, id),
          eq(schema.skillSandboxFilesTable.kind, "artifact"),
        ),
      );
    return row ? normalizeByteaField(row, "data") : null;
  }

  /**
   * Artifact-file metadata (no bytes) for every sandbox attached to a
   * conversation within an org, oldest first. Joins through `skill_sandboxes`
   * because files carry only a `sandboxId`, and filters on the join's
   * `organizationId` so a conversation reused across orgs cannot leak.
   */
  static async listArtifactMetadataByConversationId(params: {
    conversationId: string;
    organizationId: string;
  }): Promise<SkillSandboxArtifactMeta[]> {
    return db
      .select({
        id: schema.skillSandboxFilesTable.id,
        path: schema.skillSandboxFilesTable.path,
        mimeType: schema.skillSandboxFilesTable.mimeType,
        sizeBytes: schema.skillSandboxFilesTable.sizeBytes,
        createdAt: schema.skillSandboxFilesTable.createdAt,
      })
      .from(schema.skillSandboxFilesTable)
      .innerJoin(
        schema.skillSandboxesTable,
        eq(
          schema.skillSandboxFilesTable.sandboxId,
          schema.skillSandboxesTable.id,
        ),
      )
      .where(
        and(
          eq(schema.skillSandboxFilesTable.kind, "artifact"),
          eq(schema.skillSandboxesTable.conversationId, params.conversationId),
          eq(schema.skillSandboxesTable.organizationId, params.organizationId),
        ),
      )
      .orderBy(
        asc(schema.skillSandboxFilesTable.createdAt),
        asc(schema.skillSandboxFilesTable.id),
      );
  }

  /**
   * Look up an already-staged upload by its dedup id (stored as
   * `source_attachment_id`). Used by `uploadFile` to return a stable ref when
   * the idempotency index fires and `appendUpload` returns null.
   */
  static async findUploadByDedupeId(
    sandboxId: string,
    dedupeId: string,
  ): Promise<SkillSandboxFile | null> {
    const [row] = await db
      .select()
      .from(schema.skillSandboxFilesTable)
      .where(
        and(
          eq(schema.skillSandboxFilesTable.sandboxId, sandboxId),
          eq(schema.skillSandboxFilesTable.sourceAttachmentId, dedupeId),
          eq(schema.skillSandboxFilesTable.kind, "upload"),
        ),
      );
    return row ? normalizeByteaField(row, "data") : null;
  }

  /**
   * All of a user's artifact files (newest first). Scoped to the user + org via
   * the owning sandbox; pass `conversationId` to narrow to one conversation.
   * Returns metadata only — never the `data` bytea.
   *
   * `created_at` is millisecond-resolution with no monotonic tiebreak, so the
   * relative order of artifacts written in the same millisecond is not stable.
   */
  static async listUserArtifacts(params: {
    organizationId: string;
    userId: string;
    conversationId?: string;
  }): Promise<SandboxArtifactRow[]> {
    // Ownership has two faces: files a user's sandboxes PRODUCED, and files
    // sitting in a folder the user OWNS (project folders collect results from
    // every project member's chats). The user-wide listing includes both; the
    // conversation-scoped listing keeps the producer view.
    const ownershipFilter = params.conversationId
      ? eq(schema.skillSandboxesTable.userId, params.userId)
      : or(
          eq(schema.skillSandboxesTable.userId, params.userId),
          eq(schema.skillSandboxFoldersTable.userId, params.userId),
        );
    const filters = [
      eq(schema.skillSandboxFilesTable.kind, "artifact"),
      ownershipFilter,
      eq(schema.skillSandboxesTable.organizationId, params.organizationId),
    ];
    if (params.conversationId) {
      filters.push(
        eq(schema.skillSandboxesTable.conversationId, params.conversationId),
      );
    }
    const rows = await db
      .select({
        id: schema.skillSandboxFilesTable.id,
        originalName: schema.skillSandboxFilesTable.originalName,
        path: schema.skillSandboxFilesTable.path,
        mimeType: schema.skillSandboxFilesTable.mimeType,
        sizeBytes: schema.skillSandboxFilesTable.sizeBytes,
        createdAt: schema.skillSandboxFilesTable.createdAt,
        storageProvider: schema.skillSandboxFilesTable.storageProvider,
        objectKey: schema.skillSandboxFilesTable.objectKey,
        folderId: schema.skillSandboxFilesTable.folderId,
        folderName: schema.skillSandboxFoldersTable.name,
      })
      .from(schema.skillSandboxFilesTable)
      .innerJoin(
        schema.skillSandboxesTable,
        eq(
          schema.skillSandboxFilesTable.sandboxId,
          schema.skillSandboxesTable.id,
        ),
      )
      .leftJoin(
        schema.skillSandboxFoldersTable,
        eq(
          schema.skillSandboxFilesTable.folderId,
          schema.skillSandboxFoldersTable.id,
        ),
      )
      .where(and(...filters))
      .orderBy(desc(schema.skillSandboxFilesTable.createdAt));

    return rows.map((row) => ({
      id: row.id,
      filename: storageFilename({
        originalName: row.originalName,
        path: row.path,
      }),
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt,
      storageProvider: row.storageProvider,
      objectKey: row.objectKey,
      folderId: row.folderId,
      folderName: row.folderName,
    }));
  }

  /** Remove an artifact row. External bytes are the storage router's job. */
  static async deleteArtifactById(id: string): Promise<void> {
    await db
      .delete(schema.skillSandboxFilesTable)
      .where(
        and(
          eq(schema.skillSandboxFilesTable.id, id),
          eq(schema.skillSandboxFilesTable.kind, "artifact"),
        ),
      );
  }

  /** Fetch an uploaded input (kind 'upload') by id, bytes normalized. */
  static async findUploadById(id: string): Promise<SkillSandboxFile | null> {
    const [row] = await db
      .select()
      .from(schema.skillSandboxFilesTable)
      .where(
        and(
          eq(schema.skillSandboxFilesTable.id, id),
          eq(schema.skillSandboxFilesTable.kind, "upload"),
        ),
      );
    return row ? normalizeByteaField(row, "data") : null;
  }

  /**
   * Uploads a conversation's sandboxes pulled in from the user's PFS
   * (`origin = 'x_file'`), metadata only, oldest first — what the Files panel
   * shows as "From X-Files". Org-scoped through the owning sandbox.
   */
  static async listXFileUploadsByConversationId(params: {
    conversationId: string;
    organizationId: string;
  }): Promise<
    {
      id: string;
      path: string;
      originalName: string | null;
      mimeType: string;
      sizeBytes: number;
      createdAt: Date;
    }[]
  > {
    return db
      .select({
        id: schema.skillSandboxFilesTable.id,
        path: schema.skillSandboxFilesTable.path,
        originalName: schema.skillSandboxFilesTable.originalName,
        mimeType: schema.skillSandboxFilesTable.mimeType,
        sizeBytes: schema.skillSandboxFilesTable.sizeBytes,
        createdAt: schema.skillSandboxFilesTable.createdAt,
      })
      .from(schema.skillSandboxFilesTable)
      .innerJoin(
        schema.skillSandboxesTable,
        eq(
          schema.skillSandboxFilesTable.sandboxId,
          schema.skillSandboxesTable.id,
        ),
      )
      .where(
        and(
          eq(schema.skillSandboxFilesTable.kind, "upload"),
          eq(schema.skillSandboxFilesTable.origin, "x_file"),
          eq(schema.skillSandboxesTable.conversationId, params.conversationId),
          eq(schema.skillSandboxesTable.organizationId, params.organizationId),
        ),
      )
      .orderBy(
        asc(schema.skillSandboxFilesTable.createdAt),
        asc(schema.skillSandboxFilesTable.id),
      );
  }

  /**
   * Chat-attachment ids already staged into a sandbox, so auto-staging only
   * appends the not-yet-present delta.
   */
  static async listStagedAttachmentIds(
    sandboxId: string,
  ): Promise<Set<string>> {
    const rows = await db
      .select({ id: schema.skillSandboxFilesTable.sourceAttachmentId })
      .from(schema.skillSandboxFilesTable)
      .where(
        and(
          eq(schema.skillSandboxFilesTable.sandboxId, sandboxId),
          isNotNull(schema.skillSandboxFilesTable.sourceAttachmentId),
        ),
      );
    return new Set(
      rows.map((r) => r.id).filter((id): id is string => id != null),
    );
  }
}

export default SkillSandboxFileModel;
