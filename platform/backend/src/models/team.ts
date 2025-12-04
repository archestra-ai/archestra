import { MEMBER_ROLE_NAME } from "@shared";
import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertTeam,
  Team,
  TeamExternalGroup,
  TeamMember,
  UpdateTeam,
} from "@/types";

class TeamModel {
  /**
   * Create a new team
   */
  static async create(
    input: Omit<InsertTeam, "id" | "createdAt" | "updatedAt">,
  ): Promise<Team> {
    const teamId = crypto.randomUUID();
    const now = new Date();

    const [team] = await db
      .insert(schema.teamsTable)
      .values({
        id: teamId,
        name: input.name,
        description: input.description || null,
        organizationId: input.organizationId,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return {
      ...team,
      members: [],
    };
  }

  /**
   * Find all teams in an organization
   */
  static async findByOrganization(organizationId: string): Promise<Team[]> {
    const teams = await db
      .select()
      .from(schema.teamsTable)
      .where(eq(schema.teamsTable.organizationId, organizationId));

    // Fetch members for each team
    const teamsWithMembers = await Promise.all(
      teams.map(async (team) => {
        const members = await TeamModel.getTeamMembers(team.id);
        return { ...team, members };
      }),
    );

    return teamsWithMembers;
  }

  /**
   * Find a team by ID
   */
  static async findById(id: string): Promise<Team | null> {
    const [team] = await db
      .select()
      .from(schema.teamsTable)
      .where(eq(schema.teamsTable.id, id))
      .limit(1);

    if (!team) {
      return null;
    }

    const members = await TeamModel.getTeamMembers(id);

    return { ...team, members };
  }

  /**
   * Update a team
   */
  static async update(id: string, input: UpdateTeam): Promise<Team | null> {
    const [updatedTeam] = await db
      .update(schema.teamsTable)
      .set({
        ...input,
        updatedAt: new Date(),
      })
      .where(eq(schema.teamsTable.id, id))
      .returning();

    if (!updatedTeam) {
      return null;
    }

    const members = await TeamModel.getTeamMembers(id);

    return { ...updatedTeam, members };
  }

  /**
   * Delete a team
   */
  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.teamsTable)
      .where(eq(schema.teamsTable.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Get all members of a team
   */
  static async getTeamMembers(teamId: string): Promise<TeamMember[]> {
    const members = await db
      .select()
      .from(schema.teamMembersTable)
      .where(eq(schema.teamMembersTable.teamId, teamId));

    return members;
  }

  /**
   * Add a member to a team
   */
  static async addMember(
    teamId: string,
    userId: string,
    role: string = MEMBER_ROLE_NAME,
    syncedFromSso = false,
  ): Promise<TeamMember> {
    const memberId = crypto.randomUUID();
    const now = new Date();

    const [member] = await db
      .insert(schema.teamMembersTable)
      .values({
        id: memberId,
        teamId,
        userId,
        role,
        syncedFromSso,
        createdAt: now,
      })
      .returning();

    return member;
  }

  /**
   * Remove a member from a team
   */
  static async removeMember(teamId: string, userId: string): Promise<boolean> {
    const result = await db
      .delete(schema.teamMembersTable)
      .where(
        and(
          eq(schema.teamMembersTable.teamId, teamId),
          eq(schema.teamMembersTable.userId, userId),
        ),
      );

    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Get all teams a user is a member of
   */
  static async getUserTeams(userId: string): Promise<Team[]> {
    const teamMemberships = await db
      .select()
      .from(schema.teamMembersTable)
      .where(eq(schema.teamMembersTable.userId, userId));

    const teams = await Promise.all(
      teamMemberships.map(async (membership) => {
        return TeamModel.findById(membership.teamId);
      }),
    );

    return teams.filter((team) => team !== null);
  }

  /**
   * Check if a user is a member of a team
   */
  static async isUserInTeam(teamId: string, userId: string): Promise<boolean> {
    const [membership] = await db
      .select()
      .from(schema.teamMembersTable)
      .where(
        and(
          eq(schema.teamMembersTable.teamId, teamId),
          eq(schema.teamMembersTable.userId, userId),
        ),
      )
      .limit(1);

    return !!membership;
  }

  /**
   * Get all team IDs a user is a member of (used for authorization)
   */
  static async getUserTeamIds(userId: string): Promise<string[]> {
    const teamMemberships = await db
      .select({ teamId: schema.teamMembersTable.teamId })
      .from(schema.teamMembersTable)
      .where(eq(schema.teamMembersTable.userId, userId));

    return teamMemberships.map((membership) => membership.teamId);
  }

  /**
   * Get all user IDs that share at least one team with the given user
   */
  static async getTeammateUserIds(userId: string): Promise<string[]> {
    // First get the user's team IDs
    const userTeamIds = await TeamModel.getUserTeamIds(userId);

    if (userTeamIds.length === 0) {
      return [];
    }

    // Then get all users in those teams
    const teammates = await db
      .select({ userId: schema.teamMembersTable.userId })
      .from(schema.teamMembersTable)
      .where(inArray(schema.teamMembersTable.teamId, userTeamIds));

    // Return unique user IDs (excluding the user themselves)
    const teammateIds = [...new Set(teammates.map((t) => t.userId))];
    return teammateIds.filter((id) => id !== userId);
  }

  /**
   * Get all teams for an agent with their compression settings
   */
  static async getTeamsForAgent(agentId: string): Promise<Team[]> {
    const agentTeams = await db
      .select({
        team: schema.teamsTable,
      })
      .from(schema.agentTeamsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.agentTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(eq(schema.agentTeamsTable.agentId, agentId));

    return agentTeams.map((result) => ({
      ...result.team,
      members: [], // Members not needed for compression logic
    }));
  }

  // ==========================================
  // External Group Sync Methods
  // ==========================================

  /**
   * Get all external groups mapped to a team
   */
  static async getExternalGroups(teamId: string): Promise<TeamExternalGroup[]> {
    return db
      .select()
      .from(schema.teamExternalGroupsTable)
      .where(eq(schema.teamExternalGroupsTable.teamId, teamId));
  }

  /**
   * Add an external group mapping to a team
   */
  static async addExternalGroup(
    teamId: string,
    groupIdentifier: string,
  ): Promise<TeamExternalGroup> {
    const id = crypto.randomUUID();

    const [group] = await db
      .insert(schema.teamExternalGroupsTable)
      .values({
        id,
        teamId,
        groupIdentifier,
      })
      .returning();

    return group;
  }

  /**
   * Remove an external group mapping from a team
   */
  static async removeExternalGroup(
    teamId: string,
    groupIdentifier: string,
  ): Promise<boolean> {
    const result = await db
      .delete(schema.teamExternalGroupsTable)
      .where(
        and(
          eq(schema.teamExternalGroupsTable.teamId, teamId),
          eq(schema.teamExternalGroupsTable.groupIdentifier, groupIdentifier),
        ),
      );

    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Remove an external group mapping by ID.
   * Requires both the groupId and teamId to prevent IDOR attacks.
   */
  static async removeExternalGroupById(
    teamId: string,
    groupId: string,
  ): Promise<boolean> {
    const result = await db
      .delete(schema.teamExternalGroupsTable)
      .where(
        and(
          eq(schema.teamExternalGroupsTable.id, groupId),
          eq(schema.teamExternalGroupsTable.teamId, teamId),
        ),
      );

    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Find all teams in an organization that have a specific external group mapped.
   * Used during SSO login to find which teams a user should be added to.
   */
  static async findTeamsByExternalGroup(
    organizationId: string,
    groupIdentifier: string,
  ): Promise<Team[]> {
    const results = await db
      .select({
        team: schema.teamsTable,
      })
      .from(schema.teamExternalGroupsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.teamExternalGroupsTable.teamId, schema.teamsTable.id),
      )
      .where(
        and(
          eq(
            schema.teamExternalGroupsTable.groupIdentifier,
            groupIdentifier.toLowerCase(),
          ),
          eq(schema.teamsTable.organizationId, organizationId),
        ),
      );

    return results.map((r) => ({
      ...r.team,
      members: [],
    }));
  }

  /**
   * Find all teams in an organization that have any of the given external groups mapped.
   * Used during SSO login to find which teams a user should be added to based on their groups.
   */
  static async findTeamsByExternalGroups(
    organizationId: string,
    groupIdentifiers: string[],
  ): Promise<Map<string, Team[]>> {
    if (groupIdentifiers.length === 0) {
      return new Map();
    }

    // Normalize group identifiers to lowercase for case-insensitive matching
    const normalizedGroups = groupIdentifiers.map((g) => g.toLowerCase());

    const results = await db
      .select({
        team: schema.teamsTable,
        groupIdentifier: schema.teamExternalGroupsTable.groupIdentifier,
      })
      .from(schema.teamExternalGroupsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.teamExternalGroupsTable.teamId, schema.teamsTable.id),
      )
      .where(
        and(
          inArray(
            schema.teamExternalGroupsTable.groupIdentifier,
            normalizedGroups,
          ),
          eq(schema.teamsTable.organizationId, organizationId),
        ),
      );

    // Group results by team ID to avoid duplicates
    const teamMap = new Map<string, Team>();
    for (const result of results) {
      if (!teamMap.has(result.team.id)) {
        teamMap.set(result.team.id, {
          ...result.team,
          members: [],
        });
      }
    }

    // Return map of group -> teams for debugging/logging
    const groupToTeams = new Map<string, Team[]>();
    for (const result of results) {
      const team = teamMap.get(result.team.id);
      if (team) {
        const existing = groupToTeams.get(result.groupIdentifier) || [];
        existing.push(team);
        groupToTeams.set(result.groupIdentifier, existing);
      }
    }

    return groupToTeams;
  }

  /**
   * Synchronize a user's team memberships based on their SSO groups.
   * - Adds user to teams mapped to their groups (if not already a member)
   * - Removes user from teams they were previously synced to but no longer have groups for
   * - Does NOT remove manually added memberships (syncedFromSso = false)
   *
   * @returns Object containing added and removed team IDs
   */
  static async syncUserTeams(
    userId: string,
    organizationId: string,
    ssoGroups: string[],
  ): Promise<{ added: string[]; removed: string[] }> {
    const added: string[] = [];
    const removed: string[] = [];

    // Get all teams in this organization the user should be in based on SSO groups
    const groupToTeams = await TeamModel.findTeamsByExternalGroups(
      organizationId,
      ssoGroups,
    );

    // Flatten to unique team IDs
    const shouldBeInTeamIds = new Set<string>();
    for (const teams of groupToTeams.values()) {
      for (const team of teams) {
        shouldBeInTeamIds.add(team.id);
      }
    }

    // Get user's current SSO-synced team memberships in this organization
    const currentSyncedMemberships = await db
      .select({
        teamMember: schema.teamMembersTable,
        team: schema.teamsTable,
      })
      .from(schema.teamMembersTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.teamMembersTable.teamId, schema.teamsTable.id),
      )
      .where(
        and(
          eq(schema.teamMembersTable.userId, userId),
          eq(schema.teamMembersTable.syncedFromSso, true),
          eq(schema.teamsTable.organizationId, organizationId),
        ),
      );

    // Add user to teams they should be in but aren't
    for (const teamId of shouldBeInTeamIds) {
      // Check if user is already a member (synced or manual)
      const isAlreadyMember = await TeamModel.isUserInTeam(teamId, userId);
      if (!isAlreadyMember) {
        await TeamModel.addMember(teamId, userId, MEMBER_ROLE_NAME, true);
        added.push(teamId);
      }
    }

    // Remove user from teams they were synced to but should no longer be in
    for (const membership of currentSyncedMemberships) {
      if (!shouldBeInTeamIds.has(membership.teamMember.teamId)) {
        await TeamModel.removeMember(membership.teamMember.teamId, userId);
        removed.push(membership.teamMember.teamId);
      }
    }

    return { added, removed };
  }
}

export default TeamModel;
