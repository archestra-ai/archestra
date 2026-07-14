import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { ToolExecution } from "@/types/tool-execution";

/**
 * At-most-once ledger for approval-gated tool executions, keyed on the AI SDK
 * tool call id. See `database/schemas/tool-execution.ts` for why this exists.
 */
class ToolExecutionModel {
  /**
   * Atomically claim `toolCallId` for execution. Returns the newly inserted row
   * when this caller wins the claim (and is therefore the only one that should
   * dispatch to the MCP server), or `null` when the call is already claimed by
   * a concurrent request.
   */
  static async claim(toolCallId: string): Promise<ToolExecution | null> {
    const [row] = await db
      .insert(schema.toolExecutionsTable)
      .values({ toolCallId, state: "executing" })
      .onConflictDoNothing({
        target: schema.toolExecutionsTable.toolCallId,
      })
      .returning();

    return row ?? null;
  }

  static async getByToolCallId(
    toolCallId: string,
  ): Promise<ToolExecution | null> {
    const [row] = await db
      .select()
      .from(schema.toolExecutionsTable)
      .where(eq(schema.toolExecutionsTable.toolCallId, toolCallId))
      .limit(1);

    return row ?? null;
  }

  /** Record a successful execution result and mark the claim `completed`. */
  static async complete(toolCallId: string, result: unknown): Promise<void> {
    await db
      .update(schema.toolExecutionsTable)
      .set({ state: "completed", result })
      .where(eq(schema.toolExecutionsTable.toolCallId, toolCallId));
  }

  /** Record a failed execution and mark the claim `failed`. */
  static async fail(toolCallId: string, result: unknown): Promise<void> {
    await db
      .update(schema.toolExecutionsTable)
      .set({ state: "failed", result })
      .where(eq(schema.toolExecutionsTable.toolCallId, toolCallId));
  }
}

export default ToolExecutionModel;
