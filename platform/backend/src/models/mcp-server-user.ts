import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";

class McpServerUserModel {
  /**
   * Get all MCP server IDs that a user has personal access to
   */
  static async getUserPersonalMcpServerIds(userId: string): Promise<string[]> {
    const mcpServerUsers = await db
      .select({ mcpServerId: schema.mcpServerUsersTable.mcpServerId })
      .from(schema.mcpServerUsersTable)
      .where(eq(schema.mcpServerUsersTable.userId, userId));

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
      .from(schema.mcpServerUsersTable)
      .where(
        and(
          eq(schema.mcpServerUsersTable.mcpServerId, mcpServerId),
          eq(schema.mcpServerUsersTable.userId, userId),
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
   * Get user details for multiple MCP servers in one query to avoid N+1
   */
  static async getUserDetailsForMcpServers(mcpServerIds: string[]): Promise<
    Map<
      string,
      Array<{
        userId: string;
        email: string;
        createdAt: Date;
      }>
    >
  > {
    if (mcpServerIds.length === 0) {
      return new Map();
    }

    const result = await db
      .select({
        mcpServerId: schema.mcpServerUsersTable.mcpServerId,
        userId: schema.mcpServerUsersTable.userId,
        email: schema.usersTable.email,
        createdAt: schema.mcpServerUsersTable.createdAt,
      })
      .from(schema.mcpServerUsersTable)
      .innerJoin(
        schema.usersTable,
        eq(schema.mcpServerUsersTable.userId, schema.usersTable.id),
      )
      .where(inArray(schema.mcpServerUsersTable.mcpServerId, mcpServerIds));

    const detailsMap = new Map<
      string,
      Array<{
        userId: string;
        email: string;
        createdAt: Date;
      }>
    >();

    // Initialize all MCP server IDs with empty arrays
    for (const mcpServerId of mcpServerIds) {
      detailsMap.set(mcpServerId, []);
    }

    // Populate the map with user details
    for (const row of result) {
      const details = detailsMap.get(row.mcpServerId) || [];
      details.push({
        userId: row.userId,
        email: row.email,
        createdAt: row.createdAt,
      });
      detailsMap.set(row.mcpServerId, details);
    }

    return detailsMap;
  }

  /**
   * Assign a user to an MCP server (personal auth)
   */
  static async assignUserToMcpServer(
    mcpServerId: string,
    userId: string,
  ): Promise<void> {
    await db
      .insert(schema.mcpServerUsersTable)
      .values({
        mcpServerId,
        userId,
      })
      .onConflictDoNothing();
  }
}

export default McpServerUserModel;
