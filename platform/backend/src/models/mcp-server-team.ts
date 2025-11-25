import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";

class McpServerTeamModel {
  /**
   * Get all MCP server IDs that a user has access to (through team membership)
   * Optimized to use a single query with joins instead of consecutive queries
   */
  static async getUserAccessibleMcpServerIds(
    userId: string,
    isMcpServerAdmin: boolean,
  ): Promise<string[]> {
    // MCP server admins have access to all MCP servers
    if (isMcpServerAdmin) {
      const allServers = await db
        .select({ id: schema.mcpServersTable.id })
        .from(schema.mcpServersTable);
      return allServers.map((server) => server.id);
    }

    // Get all MCP servers assigned to teams the user is a member of in a single query
    const mcpServerTeams = await db
      .select({ mcpServerId: schema.mcpServerTeamsTable.mcpServerId })
      .from(schema.mcpServerTeamsTable)
      .innerJoin(
        schema.teamMembersTable,
        eq(schema.mcpServerTeamsTable.teamId, schema.teamMembersTable.teamId),
      )
      .where(eq(schema.teamMembersTable.userId, userId));

    // Use Set to remove duplicates (user might be in multiple teams with same MCP server)
    return Array.from(new Set(mcpServerTeams.map((st) => st.mcpServerId)));
  }

  /**
   * Check if a user has access to a specific MCP server (through team membership)
   * Optimized to use a single query with joins instead of consecutive queries
   */
  static async userHasMcpServerAccess(
    userId: string,
    mcpServerId: string,
    isMcpServerAdmin: boolean,
  ): Promise<boolean> {
    // MCP server admins always have access
    if (isMcpServerAdmin) {
      return true;
    }

    // Check if the MCP server is assigned to any team the user is a member of in a single query
    const mcpServerTeam = await db
      .select()
      .from(schema.mcpServerTeamsTable)
      .innerJoin(
        schema.teamMembersTable,
        eq(schema.mcpServerTeamsTable.teamId, schema.teamMembersTable.teamId),
      )
      .where(
        and(
          eq(schema.mcpServerTeamsTable.mcpServerId, mcpServerId),
          eq(schema.teamMembersTable.userId, userId),
        ),
      )
      .limit(1);

    return mcpServerTeam.length > 0;
  }

  /**
   * Get all team IDs assigned to a specific MCP server
   */
  static async getTeamsForMcpServer(mcpServerId: string): Promise<string[]> {
    const mcpServerTeams = await db
      .select({ teamId: schema.mcpServerTeamsTable.teamId })
      .from(schema.mcpServerTeamsTable)
      .where(eq(schema.mcpServerTeamsTable.mcpServerId, mcpServerId));

    return mcpServerTeams.map((st) => st.teamId);
  }

  /**
   * Get all team details with access to a specific MCP server
   */
  static async getTeamDetailsForMcpServer(mcpServerId: string): Promise<
    Array<{
      teamId: string;
      name: string;
      createdAt: Date;
    }>
  > {
    const result = await db
      .select({
        teamId: schema.mcpServerTeamsTable.teamId,
        name: schema.teamsTable.name,
        createdAt: schema.mcpServerTeamsTable.createdAt,
      })
      .from(schema.mcpServerTeamsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.mcpServerTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(eq(schema.mcpServerTeamsTable.mcpServerId, mcpServerId));

    return result;
  }

  /**
   * Sync team assignments for an MCP server (replaces all existing assignments)
   */
  static async syncMcpServerTeams(
    mcpServerId: string,
    teamIds: string[],
  ): Promise<number> {
    await db.transaction(async (tx) => {
      // Delete all existing team assignments
      await tx
        .delete(schema.mcpServerTeamsTable)
        .where(eq(schema.mcpServerTeamsTable.mcpServerId, mcpServerId));

      // Insert new team assignments (if any teams provided)
      if (teamIds.length > 0) {
        await tx.insert(schema.mcpServerTeamsTable).values(
          teamIds.map((teamId) => ({
            mcpServerId,
            teamId,
          })),
        );
      }
    });

    return teamIds.length;
  }

  /**
   * Assign teams to an MCP server (idempotent)
   */
  static async assignTeamsToMcpServer(
    mcpServerId: string,
    teamIds: string[],
  ): Promise<void> {
    if (teamIds.length === 0) return;

    await db
      .insert(schema.mcpServerTeamsTable)
      .values(
        teamIds.map((teamId) => ({
          mcpServerId,
          teamId,
        })),
      )
      .onConflictDoNothing();
  }

  /**
   * Get team details for multiple MCP servers in one query to avoid N+1
   */
  static async getTeamDetailsForMcpServers(mcpServerIds: string[]): Promise<
    Map<
      string,
      Array<{
        teamId: string;
        name: string;
        createdAt: Date;
      }>
    >
  > {
    if (mcpServerIds.length === 0) {
      return new Map();
    }

    const result = await db
      .select({
        mcpServerId: schema.mcpServerTeamsTable.mcpServerId,
        teamId: schema.mcpServerTeamsTable.teamId,
        name: schema.teamsTable.name,
        createdAt: schema.mcpServerTeamsTable.createdAt,
      })
      .from(schema.mcpServerTeamsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.mcpServerTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(inArray(schema.mcpServerTeamsTable.mcpServerId, mcpServerIds));

    const detailsMap = new Map<
      string,
      Array<{
        teamId: string;
        name: string;
        createdAt: Date;
      }>
    >();

    // Initialize all MCP server IDs with empty arrays
    for (const mcpServerId of mcpServerIds) {
      detailsMap.set(mcpServerId, []);
    }

    // Populate the map with team details
    for (const row of result) {
      const details = detailsMap.get(row.mcpServerId) || [];
      details.push({
        teamId: row.teamId,
        name: row.name,
        createdAt: row.createdAt,
      });
      detailsMap.set(row.mcpServerId, details);
    }

    return detailsMap;
  }

  /**
   * Remove a team assignment from an MCP server
   */
  static async removeTeamFromMcpServer(
    mcpServerId: string,
    teamId: string,
  ): Promise<boolean> {
    const result = await db
      .delete(schema.mcpServerTeamsTable)
      .where(
        and(
          eq(schema.mcpServerTeamsTable.mcpServerId, mcpServerId),
          eq(schema.mcpServerTeamsTable.teamId, teamId),
        ),
      );

    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default McpServerTeamModel;
