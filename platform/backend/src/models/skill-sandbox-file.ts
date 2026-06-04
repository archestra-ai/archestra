import { and, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertSkillSandboxFile, SkillSandboxFile } from "@/types";

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

  /** Artifact rows for a sandbox, most-recent first. */
  static async listArtifactsBySandbox(
    sandboxId: string,
  ): Promise<SkillSandboxFile[]> {
    const rows = await db
      .select()
      .from(schema.skillSandboxFilesTable)
      .where(
        and(
          eq(schema.skillSandboxFilesTable.sandboxId, sandboxId),
          eq(schema.skillSandboxFilesTable.kind, "artifact"),
        ),
      )
      .orderBy(desc(schema.skillSandboxFilesTable.createdAt));
    return rows.map(normalizeFileData);
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
