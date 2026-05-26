import { and, desc, eq, isNotNull } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertSkillSandbox, SkillSandbox } from "@/types";

class SkillSandboxModel {
  /**
   * Create a sandbox row together with its junction entries for the skills
   * mounted into it. Runs in a single transaction so a failed junction insert
   * cannot leave an orphan sandbox.
   */
  static async create(params: {
    sandbox: InsertSkillSandbox;
    skillIds: string[];
  }): Promise<SkillSandbox> {
    return await db.transaction(async (tx) => {
      const [sandbox] = await tx
        .insert(schema.skillSandboxesTable)
        .values(params.sandbox)
        .returning();

      if (!sandbox) {
        throw new Error("failed to insert skill sandbox");
      }

      if (params.skillIds.length > 0) {
        await tx.insert(schema.skillSandboxSkillsTable).values(
          params.skillIds.map((skillId) => ({
            sandboxId: sandbox.id,
            skillId,
          })),
        );
      }

      return sandbox;
    });
  }

  static async findById(id: string): Promise<SkillSandbox | null> {
    const [result] = await db
      .select()
      .from(schema.skillSandboxesTable)
      .where(eq(schema.skillSandboxesTable.id, id));

    return result ?? null;
  }

  /**
   * Most recent sandbox attached to a conversation. Used by the MCP tool layer
   * to infer the active sandbox when the caller omits an explicit id.
   */
  static async findMostRecentForConversation(
    conversationId: string,
  ): Promise<SkillSandbox | null> {
    const [result] = await db
      .select()
      .from(schema.skillSandboxesTable)
      .where(
        and(
          eq(schema.skillSandboxesTable.conversationId, conversationId),
          isNotNull(schema.skillSandboxesTable.conversationId),
        ),
      )
      .orderBy(desc(schema.skillSandboxesTable.createdAt))
      .limit(1);

    return result ?? null;
  }

  /** Skill ids that were mounted into the sandbox at creation. */
  static async listSkillIds(sandboxId: string): Promise<string[]> {
    const rows = await db
      .select({ skillId: schema.skillSandboxSkillsTable.skillId })
      .from(schema.skillSandboxSkillsTable)
      .where(eq(schema.skillSandboxSkillsTable.sandboxId, sandboxId));
    return rows.map((r) => r.skillId);
  }
}

export default SkillSandboxModel;
