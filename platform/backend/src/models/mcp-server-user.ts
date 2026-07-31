import { and, eq } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";

class McpServerUserModel {
  /**
   * Get all MCP server IDs that a user has personal access to
   */
  static async getUserPersonalMcpServerIds(userId: string): Promise<string[]> {
    // Join the server so a soft-deleted install stops granting personal access
    // (the junction row is retained on soft-delete).
    const mcpServerUsers = await db
      .select({ mcpServerId: schema.mcpServerUsersTable.mcpServerId })
      .from(schema.mcpServerUsersTable)
      .innerJoin(
        schema.mcpServersTable,
        eq(schema.mcpServerUsersTable.mcpServerId, schema.mcpServersTable.id),
      )
      .where(
        and(
          eq(schema.mcpServerUsersTable.userId, userId),
          notDeleted(schema.mcpServersTable),
        ),
      );

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
      .select({ mcpServerId: schema.mcpServerUsersTable.mcpServerId })
      .from(schema.mcpServerUsersTable)
      .innerJoin(
        schema.mcpServersTable,
        eq(schema.mcpServerUsersTable.mcpServerId, schema.mcpServersTable.id),
      )
      .where(
        and(
          eq(schema.mcpServerUsersTable.mcpServerId, mcpServerId),
          eq(schema.mcpServerUsersTable.userId, userId),
          notDeleted(schema.mcpServersTable),
        ),
      )
      .limit(1);

    return mcpServerUser.length > 0;
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
        userId: schema.mcpServerUsersTable.userId,
        email: schema.usersTable.email,
        createdAt: schema.mcpServerUsersTable.createdAt,
      })
      .from(schema.mcpServerUsersTable)
      .innerJoin(
        schema.usersTable,
        eq(schema.mcpServerUsersTable.userId, schema.usersTable.id),
      )
      .where(eq(schema.mcpServerUsersTable.mcpServerId, mcpServerId));

    return result;
  }

  /**
   * Assign a user to an MCP server (personal auth)
   */
  static async assignUserToMcpServer(
    mcpServerId: string,
    userId: string,
    tx?: Transaction,
  ): Promise<void> {
    await (tx ?? db)
      .insert(schema.mcpServerUsersTable)
      .values({
        mcpServerId,
        userId,
      })
      .onConflictDoNothing();
  }
}

export default McpServerUserModel;
