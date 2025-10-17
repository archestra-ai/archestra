import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";

class AgentAccessControlModel {
  /**
   * Gets all agent IDs that a user has access to
   */
  static async getUserAccessibleAgentIds(userId: string): Promise<string[]> {
    const accessRecords = await db
      .select({ agentId: schema.agentAccessControlTable.agentId })
      .from(schema.agentAccessControlTable)
      .where(eq(schema.agentAccessControlTable.userId, userId));

    return accessRecords.map((record) => record.agentId);
  }

  /**
   * Checks if a user has access to a specific agent
   * Admins always have access (checked by caller)
   */
  static async userHasAgentAccess(
    userId: string,
    agentId: string,
    isAdmin: boolean,
  ): Promise<boolean> {
    if (isAdmin) {
      return true;
    }

    const accessRecord = await db
      .select()
      .from(schema.agentAccessControlTable)
      .where(
        and(
          eq(schema.agentAccessControlTable.agentId, agentId),
          eq(schema.agentAccessControlTable.userId, userId),
        ),
      )
      .limit(1);

    return accessRecord.length > 0;
  }

  /**
   * Gets all user IDs that have access to a specific agent
   */
  static async getUsersWithAccessToAgent(agentId: string): Promise<string[]> {
    const accessRecords = await db
      .select({ userId: schema.agentAccessControlTable.userId })
      .from(schema.agentAccessControlTable)
      .where(eq(schema.agentAccessControlTable.agentId, agentId));

    return accessRecords.map((record) => record.userId);
  }

  /**
   * Syncs user access for an agent (replaces all existing access with new list)
   */
  static async syncAgentAccess(
    agentId: string,
    userIds: string[],
  ): Promise<number> {
    await db.transaction(async (tx) => {
      // Delete all existing access
      await tx
        .delete(schema.agentAccessControlTable)
        .where(eq(schema.agentAccessControlTable.agentId, agentId));

      // Insert new access records (if any users provided)
      if (userIds.length > 0) {
        await tx.insert(schema.agentAccessControlTable).values(
          userIds.map((userId) => ({
            agentId,
            userId,
          })),
        );
      }
    });

    return userIds.length;
  }

  /**
   * Grants access to an agent for specific users (idempotent)
   */
  static async grantAgentAccess(
    agentId: string,
    userIds: string[],
  ): Promise<void> {
    if (userIds.length === 0) return;

    await db
      .insert(schema.agentAccessControlTable)
      .values(
        userIds.map((userId) => ({
          agentId,
          userId,
        })),
      )
      .onConflictDoNothing();
  }
}

export default AgentAccessControlModel;
