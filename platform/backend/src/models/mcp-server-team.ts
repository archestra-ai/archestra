import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";

class McpServerTeamModel {
  /**
   * Get all MCP server IDs that a user has access to (through team membership)
   */
  static async getUserAccessibleMcpServerIds(
    userId: string,
    isAdmin: boolean,
  ): Promise<string[]> {
    // Admins have access to all MCP servers
    if (isAdmin) {
      const allServers = await db
        .select({ id: schema.mcpServersTable.id })
        .from(schema.mcpServersTable);
      return allServers.map((server) => server.id);
    }

    // Get all team IDs the user is a member of
    const userTeams = await db
      .select({ teamId: schema.teamMember.teamId })
      .from(schema.teamMember)
      .where(eq(schema.teamMember.userId, userId));

    const teamIds = userTeams.map((t) => t.teamId);

    if (teamIds.length === 0) {
      return [];
    }

    // Get all MCP servers assigned to these teams
    const mcpServerTeams = await db
      .select({ mcpServerId: schema.mcpServerTeamTable.mcpServerId })
      .from(schema.mcpServerTeamTable)
      .where(inArray(schema.mcpServerTeamTable.teamId, teamIds));

    return mcpServerTeams.map((st) => st.mcpServerId);
  }

  /**
   * Check if a user has access to a specific MCP server (through team membership)
   */
  static async userHasMcpServerAccess(
    userId: string,
    mcpServerId: string,
    isAdmin: boolean,
  ): Promise<boolean> {
    // Admins always have access
    if (isAdmin) {
      return true;
    }

    // Get all team IDs the user is a member of
    const userTeams = await db
      .select({ teamId: schema.teamMember.teamId })
      .from(schema.teamMember)
      .where(eq(schema.teamMember.userId, userId));

    const teamIds = userTeams.map((t) => t.teamId);

    if (teamIds.length === 0) {
      return false;
    }

    // Check if the MCP server is assigned to any of the user's teams
    const mcpServerTeam = await db
      .select()
      .from(schema.mcpServerTeamTable)
      .where(
        and(
          eq(schema.mcpServerTeamTable.mcpServerId, mcpServerId),
          inArray(schema.mcpServerTeamTable.teamId, teamIds),
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
      .select({ teamId: schema.mcpServerTeamTable.teamId })
      .from(schema.mcpServerTeamTable)
      .where(eq(schema.mcpServerTeamTable.mcpServerId, mcpServerId));

    return mcpServerTeams.map((st) => st.teamId);
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
        .delete(schema.mcpServerTeamTable)
        .where(eq(schema.mcpServerTeamTable.mcpServerId, mcpServerId));

      // Insert new team assignments (if any teams provided)
      if (teamIds.length > 0) {
        await tx.insert(schema.mcpServerTeamTable).values(
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
      .insert(schema.mcpServerTeamTable)
      .values(
        teamIds.map((teamId) => ({
          mcpServerId,
          teamId,
        })),
      )
      .onConflictDoNothing();
  }

  /**
   * Remove a team assignment from an MCP server
   */
  static async removeTeamFromMcpServer(
    mcpServerId: string,
    teamId: string,
  ): Promise<boolean> {
    const result = await db
      .delete(schema.mcpServerTeamTable)
      .where(
        and(
          eq(schema.mcpServerTeamTable.mcpServerId, mcpServerId),
          eq(schema.mcpServerTeamTable.teamId, teamId),
        ),
      );

    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default McpServerTeamModel;
