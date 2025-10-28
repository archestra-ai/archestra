import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";

class McpServerUserModel {
  /**
   * Get all MCP server IDs that a user has personal access to
   */
  static async getUserPersonalMcpServerIds(userId: string): Promise<string[]> {
    const mcpServerUsers = await db
      .select({ mcpServerId: schema.mcpServerUserTable.mcpServerId })
      .from(schema.mcpServerUserTable)
      .where(eq(schema.mcpServerUserTable.userId, userId));

    return mcpServerUsers.map((su) => su.mcpServerId);
  }

  /**
   * Check if a user has personal access to a specific MCP server
   */
  static async userHasPersonalMcpServerAccess(
    userId: string,
    mcpServerId: string,
  ): Promise<boolean> {
    const mcpServerUser = await db
      .select()
      .from(schema.mcpServerUserTable)
      .where(
        and(
          eq(schema.mcpServerUserTable.mcpServerId, mcpServerId),
          eq(schema.mcpServerUserTable.userId, userId),
        ),
      )
      .limit(1);

    return mcpServerUser.length > 0;
  }

  /**
   * Get all user IDs assigned to a specific MCP server
   */
  static async getUsersForMcpServer(mcpServerId: string): Promise<string[]> {
    const mcpServerUsers = await db
      .select({ userId: schema.mcpServerUserTable.userId })
      .from(schema.mcpServerUserTable)
      .where(eq(schema.mcpServerUserTable.mcpServerId, mcpServerId));

    return mcpServerUsers.map((su) => su.userId);
  }

  /**
   * Get all user details with access to a specific MCP server
   */
  static async getUserDetailsForMcpServer(mcpServerId: string): Promise<
    Array<{
      userId: string;
      email: string;
      createdAt: Date;
    }>
  > {
    const result = await db
      .select({
        userId: schema.mcpServerUserTable.userId,
        email: schema.usersTable.email,
        createdAt: schema.mcpServerUserTable.createdAt,
      })
      .from(schema.mcpServerUserTable)
      .innerJoin(
        schema.usersTable,
        eq(schema.mcpServerUserTable.userId, schema.usersTable.id),
      )
      .where(eq(schema.mcpServerUserTable.mcpServerId, mcpServerId));

    return result;
  }

  /**
   * Assign a user to an MCP server (personal auth)
   */
  static async assignUserToMcpServer(
    mcpServerId: string,
    userId: string,
  ): Promise<void> {
    await db
      .insert(schema.mcpServerUserTable)
      .values({
        mcpServerId,
        userId,
      })
      .onConflictDoNothing();
  }

  /**
   * Remove a user assignment from an MCP server
   */
  static async removeUserFromMcpServer(
    mcpServerId: string,
    userId: string,
  ): Promise<boolean> {
    const result = await db
      .delete(schema.mcpServerUserTable)
      .where(
        and(
          eq(schema.mcpServerUserTable.mcpServerId, mcpServerId),
          eq(schema.mcpServerUserTable.userId, userId),
        ),
      );

    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default McpServerUserModel;
