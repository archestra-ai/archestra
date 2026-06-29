import { and, eq, isNotNull } from "drizzle-orm";
import db, { schema } from "@/database";
import type { SkillSandboxFile } from "@/types";
import { normalizeByteaField } from "@/utils/normalize-bytea";

/**
 * Read access to `skill_sandbox_files`, which now serves the `upload` role
 * only — input bytes replayed into containers. Uploaded inputs are WRITTEN by
 * `SkillSandboxReplayEventModel` inside the replay-log transaction, so they are
 * not created here. Persistent output files ("My Files") moved to the `files`
 * table and its `FileModel`.
 */
class SkillSandboxFileModel {
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
