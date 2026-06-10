import { and, asc, eq, isNotNull } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertSkillSandboxFile, SkillSandboxFile } from "@/types";

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
    artifact: Omit<InsertSkillSandboxFile, "kind">,
  ): Promise<SkillSandboxFile> {
    const [row] = await db
      .insert(schema.skillSandboxFilesTable)
      .values({ ...artifact, kind: "artifact" })
      .returning();
    if (!row) {
      throw new Error("failed to insert sandbox artifact");
    }
    return normalizeFileData(row);
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
    return row ? normalizeFileData(row) : null;
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
    return row ? normalizeFileData(row) : null;
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

// === internal helpers ===

/**
 * pg returns `bytea` as Buffer; PGlite returns Uint8Array. Callers rely on
 * Buffer semantics, so normalize at the read boundary.
 */
function normalizeFileData(row: SkillSandboxFile): SkillSandboxFile {
  if (Buffer.isBuffer(row.data)) return row;
  return { ...row, data: Buffer.from(row.data as unknown as Uint8Array) };
}
