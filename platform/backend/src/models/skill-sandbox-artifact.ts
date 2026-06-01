import { desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertSkillSandboxArtifact, SkillSandboxArtifact } from "@/types";

class SkillSandboxArtifactModel {
  static async create(
    artifact: InsertSkillSandboxArtifact,
  ): Promise<SkillSandboxArtifact> {
    const [row] = await db
      .insert(schema.skillSandboxArtifactsTable)
      .values(artifact)
      .returning();

    if (!row) {
      throw new Error("failed to insert sandbox artifact");
    }
    return row;
  }

  static async findById(id: string): Promise<SkillSandboxArtifact | null> {
    const [row] = await db
      .select()
      .from(schema.skillSandboxArtifactsTable)
      .where(eq(schema.skillSandboxArtifactsTable.id, id));

    return row ?? null;
  }

  /** Artifact rows for a sandbox, most-recent first. */
  static async listBySandbox(
    sandboxId: string,
  ): Promise<SkillSandboxArtifact[]> {
    return await db
      .select()
      .from(schema.skillSandboxArtifactsTable)
      .where(eq(schema.skillSandboxArtifactsTable.sandboxId, sandboxId))
      .orderBy(desc(schema.skillSandboxArtifactsTable.createdAt));
  }
}

export default SkillSandboxArtifactModel;
