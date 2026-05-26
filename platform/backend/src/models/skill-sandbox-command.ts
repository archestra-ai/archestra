import { asc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertSkillSandboxCommand, SkillSandboxCommand } from "@/types";

class SkillSandboxCommandModel {
  /** Append a single command-result row to the log. */
  static async append(
    command: InsertSkillSandboxCommand,
  ): Promise<SkillSandboxCommand> {
    const [row] = await db
      .insert(schema.skillSandboxCommandsTable)
      .values(command)
      .returning();

    if (!row) {
      throw new Error("failed to insert sandbox command");
    }
    return row;
  }

  /**
   * Full command log for a sandbox in execution order. Callers iterate this to
   * replay state into a freshly materialized Dagger container.
   */
  static async listBySandbox(
    sandboxId: string,
  ): Promise<SkillSandboxCommand[]> {
    return await db
      .select()
      .from(schema.skillSandboxCommandsTable)
      .where(eq(schema.skillSandboxCommandsTable.sandboxId, sandboxId))
      .orderBy(
        asc(schema.skillSandboxCommandsTable.createdAt),
        asc(schema.skillSandboxCommandsTable.id),
      );
  }
}

export default SkillSandboxCommandModel;
