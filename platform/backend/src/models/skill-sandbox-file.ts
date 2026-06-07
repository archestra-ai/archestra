import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
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
      "kind" | "data" | "storageProvider" | "objectKey"
    > & {
      data: Buffer;
      /** Sandbox owner — names the per-user storage folder. Not a column. */
      userId: string;
    },
  ): Promise<SkillSandboxFile> {
    const { userId, ...fileFields } = artifact;
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
    });
    const [row] = await db
      .insert(schema.skillSandboxFilesTable)
      .values({
        ...fileFields,
        id: fileId,
        kind: "artifact",
        data: stored.dbData,
        storageProvider: stored.provider,
        objectKey: stored.objectKey,
      })
      .returning();
    if (!row) {
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
    const filters = [
      eq(schema.skillSandboxFilesTable.kind, "artifact"),
      eq(schema.skillSandboxesTable.userId, params.userId),
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
      })
      .from(schema.skillSandboxFilesTable)
      .innerJoin(
        schema.skillSandboxesTable,
        eq(
          schema.skillSandboxFilesTable.sandboxId,
          schema.skillSandboxesTable.id,
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
    }));
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
