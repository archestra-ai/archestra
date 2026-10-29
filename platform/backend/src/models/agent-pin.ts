import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";

/** Per-user pins for the paginated Agents surface. */
class AgentPinModel {
  /** Pin an agent; idempotent, with a re-pin moving it to the newest position. */
  static async pin(params: { userId: string; agentId: string }): Promise<void> {
    await db
      .insert(schema.agentPinsTable)
      .values(params)
      .onConflictDoUpdate({
        target: [schema.agentPinsTable.userId, schema.agentPinsTable.agentId],
        set: { pinnedAt: new Date() },
      });
  }

  /** Remove a user's pin; idempotent so stale pins can always be cleared. */
  static async unpin(params: {
    userId: string;
    agentId: string;
  }): Promise<void> {
    await db
      .delete(schema.agentPinsTable)
      .where(
        and(
          eq(schema.agentPinsTable.userId, params.userId),
          eq(schema.agentPinsTable.agentId, params.agentId),
        ),
      );
  }
}

export default AgentPinModel;
