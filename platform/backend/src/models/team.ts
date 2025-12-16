import { MEMBER_ROLE_NAME } from "@shared";
import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type {
  InsertTeam,
  Team,
  TeamExternalGroup,
  TeamMember,
  UpdateTeam,
} from "@/types";
import { ApiError } from "@/types";
import TeamTokenModel from "./team-token";

class TeamModel {
  /**
   * Create a new team
   */
  static async create(
    input: Omit<InsertTeam, "id" | "createdAt" | "updatedAt">,
  ): Promise<Team> {
    logger.debug(
      { name: input.name, organizationId: input.organizationId },
      "TeamModel.create: creating team",
    );
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

    // Auto-create a team token
    await TeamTokenModel.createTeamToken(teamId, input.name);
    logger.debug({ teamId }, "TeamModel.create: created team token");

    logger.debug({ teamId }, "TeamModel.create: completed");
    return {
      ...team,
      members: [],
    };
  }

  /**
   * Find all teams in an organization
   */
  static async findByOrganization(organizationId: string): Promise<Team[]> {
    logger.debug(
      { organizationId },
      "TeamModel.findByOrganization: fetching teams",
    );
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

    logger.debug(
      { organizationId, count: teamsWithMembers.length },
      "TeamModel.findByOrganization: completed",
    );
    return teamsWithMembers;
  }

  /**
   * Find a team by ID
   */
  static async findById(id: string): Promise<Team | null> {
    logger.debug({ id }, "TeamModel.findById: fetching team");
    const [team] = await db
      .select()
      .from(schema.teamsTable)
      .where(eq(schema.teamsTable.id, id))
      .limit(1);

    if (!team) {
      logger.debug({ id }, "TeamModel.findById: team not found");
      return null;
    }

    const members = await TeamModel.getTeamMembers(id);

    logger.debug(
      { id, membersCount: members.length },
      "TeamModel.findById: completed",
    );
    return { ...team, members };
  }

  /**
   * Find multiple teams by their IDs
   * Returns teams without members for performance
   */
  static async findByIds(teamIds: string[]): Promise<Team[]> {
    logger.debug({ teamIds }, "TeamModel.findByIds: fetching teams");
    if (teamIds.length === 0) {
      logger.debug("TeamModel.findByIds: no team IDs provided");
      return [];
    }

    const teams = await db
      .select()
      .from(schema.teamsTable)
      .where(inArray(schema.teamsTable.id, teamIds));

    logger.debug({ count: teams.length }, "TeamModel.findByIds: completed");
    return teams.map((team) => ({
      ...team,
      members: [], // Members not fetched for performance
    }));
  }

  /**
   * Update a team
   */
  static async update(id: string, input: UpdateTeam): Promise<Team | null> {
    logger.debug({ id, input }, "TeamModel.update: updating team");
    const [updatedTeam] = await db
      .update(schema.teamsTable)
      .set({
        ...input,
        updatedAt: new Date(),
      })
      .where(eq(schema.teamsTable.id, id))
      .returning();

    if (!updatedTeam) {
      logger.debug({ id }, "TeamModel.update: team not found");
      return null;
    }

    const members = await TeamModel.getTeamMembers(id);

    logger.debug({ id }, "TeamModel.update: completed");
    return { ...updatedTeam, members };
  }

  /**
   * Delete a team
   */
  static async delete(id: string): Promise<boolean> {
    logger.debug({ id }, "TeamModel.delete: deleting team");
    const result = await db
      .delete(schema.teamsTable)
      .where(eq(schema.teamsTable.id, id));
    const deleted = result.rowCount !== null && result.rowCount > 0;
    logger.debug({ id, deleted }, "TeamModel.delete: completed");
    return deleted;
  }

  /**
   * Get all members of a team
   */
  static async getTeamMembers(teamId: string): Promise<TeamMember[]> {
    logger.debug({ teamId }, "TeamModel.getTeamMembers: fetching members");
    const members = await db
      .select()
      .from(schema.teamMembersTable)
      .where(eq(schema.teamMembersTable.teamId, teamId));

    logger.debug(
      { teamId, count: members.length },
      "TeamModel.getTeamMembers: completed",
    );
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
    logger.debug(
      { teamId, userId, role, syncedFromSso },
      "TeamModel.addMember: adding member",
    );
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

    logger.debug(
      { teamId, userId, memberId },
      "TeamModel.addMember: completed",
    );
    return member;
  }

  /**
   * Remove a member from a team
   */
  static async removeMember(teamId: string, userId: string): Promise<boolean> {
    logger.debug({ teamId, userId }, "TeamModel.removeMember: removing member");
    const result = await db
      .delete(schema.teamMembersTable)
      .where(
        and(
          eq(schema.teamMembersTable.teamId, teamId),
          eq(schema.teamMembersTable.userId, userId),
        ),
      );

    const removed = result.rowCount !== null && result.rowCount > 0;
    logger.debug(
      { teamId, userId, removed },
      "TeamModel.removeMember: completed",
    );
    return removed;
  }

  /**
   * Get all teams a user is a member of
   */
  static async getUserTeams(userId: string): Promise<Team[]> {
    logger.debug({ userId }, "TeamModel.getUserTeams: fetching user teams");
    const teamMemberships = await db
      .select()
      .from(schema.teamMembersTable)
      .where(eq(schema.teamMembersTable.userId, userId));

    const teams = await Promise.all(
      teamMemberships.map(async (membership) => {
        return TeamModel.findById(membership.teamId);
      }),
    );

    const filteredTeams = teams.filter((team) => team !== null);
    logger.debug(
      { userId, count: filteredTeams.length },
      "TeamModel.getUserTeams: completed",
    );
    return filteredTeams;
  }

  /**
   * Check if a user is a member of a team
   */
  static async isUserInTeam(teamId: string, userId: string): Promise<boolean> {
    logger.debug(
      { teamId, userId },
      "TeamModel.isUserInTeam: checking membership",
    );
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

    const isMember = !!membership;
    logger.debug(
      { teamId, userId, isMember },
      "TeamModel.isUserInTeam: completed",
    );
    return isMember;
  }

  /**
   * Get all team IDs a user is a member of (used for authorization)
   */
  static async getUserTeamIds(userId: string): Promise<string[]> {
    logger.debug({ userId }, "TeamModel.getUserTeamIds: fetching team IDs");
    const teamMemberships = await db
      .select({ teamId: schema.teamMembersTable.teamId })
      .from(schema.teamMembersTable)
      .where(eq(schema.teamMembersTable.userId, userId));

    const teamIds = teamMemberships.map((membership) => membership.teamId);
    logger.debug(
      { userId, count: teamIds.length },
      "TeamModel.getUserTeamIds: completed",
    );
    return teamIds;
  }

  /**
   * Get all user IDs that share at least one team with the given user
   */
  static async getTeammateUserIds(userId: string): Promise<string[]> {
    logger.debug(
      { userId },
      "TeamModel.getTeammateUserIds: fetching teammate IDs",
    );
    // First get the user's team IDs
    const userTeamIds = await TeamModel.getUserTeamIds(userId);

    if (userTeamIds.length === 0) {
      logger.debug(
        { userId },
        "TeamModel.getTeammateUserIds: user has no teams",
      );
      return [];
    }

    // Then get all users in those teams
    const teammates = await db
      .select({ userId: schema.teamMembersTable.userId })
      .from(schema.teamMembersTable)
      .where(inArray(schema.teamMembersTable.teamId, userTeamIds));

    // Return unique user IDs (excluding the user themselves)
    const teammateIds = [...new Set(teammates.map((t) => t.userId))];
    const filteredIds = teammateIds.filter((id) => id !== userId);
    logger.debug(
      { userId, count: filteredIds.length },
      "TeamModel.getTeammateUserIds: completed",
    );
    return filteredIds;
  }

  /**
   * Get all teams for an agent with their compression settings
   */
  static async getTeamsForAgent(agentId: string): Promise<Team[]> {
    logger.debug(
      { agentId },
      "TeamModel.getTeamsForAgent: fetching agent teams",
    );
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

    logger.debug(
      { agentId, count: agentTeams.length },
      "TeamModel.getTeamsForAgent: completed",
    );
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
    logger.debug(
      { teamId },
      "TeamModel.getExternalGroups: fetching external groups",
    );
    const groups = await db
      .select()
      .from(schema.teamExternalGroupsTable)
      .where(eq(schema.teamExternalGroupsTable.teamId, teamId));
    logger.debug(
      { teamId, count: groups.length },
      "TeamModel.getExternalGroups: completed",
    );
    return groups;
  }

  /**
   * Add an external group mapping to a team
   */
  static async addExternalGroup(
    teamId: string,
    groupIdentifier: string,
  ): Promise<TeamExternalGroup> {
    logger.debug(
      { teamId, groupIdentifier },
      "TeamModel.addExternalGroup: adding external group",
    );
    const id = crypto.randomUUID();

    const [group] = await db
      .insert(schema.teamExternalGroupsTable)
      .values({
        id,
        teamId,
        groupIdentifier,
      })
      .returning();

    logger.debug(
      { teamId, groupId: id },
      "TeamModel.addExternalGroup: completed",
    );
    return group;
  }

  /**
   * Remove an external group mapping from a team
   */
  static async removeExternalGroup(
    teamId: string,
    groupIdentifier: string,
  ): Promise<boolean> {
    logger.debug(
      { teamId, groupIdentifier },
      "TeamModel.removeExternalGroup: removing external group",
    );
    const result = await db
      .delete(schema.teamExternalGroupsTable)
      .where(
        and(
          eq(schema.teamExternalGroupsTable.teamId, teamId),
          eq(schema.teamExternalGroupsTable.groupIdentifier, groupIdentifier),
        ),
      );

    const removed = result.rowCount !== null && result.rowCount > 0;
    logger.debug(
      { teamId, groupIdentifier, removed },
      "TeamModel.removeExternalGroup: completed",
    );
    return removed;
  }

  /**
   * Remove an external group mapping by ID.
   * Requires both the groupId and teamId to prevent IDOR attacks.
   */
  static async removeExternalGroupById(
    teamId: string,
    groupId: string,
  ): Promise<boolean> {
    logger.debug(
      { teamId, groupId },
      "TeamModel.removeExternalGroupById: removing external group",
    );
    const result = await db
      .delete(schema.teamExternalGroupsTable)
      .where(
        and(
          eq(schema.teamExternalGroupsTable.id, groupId),
          eq(schema.teamExternalGroupsTable.teamId, teamId),
        ),
      );

    const removed = result.rowCount !== null && result.rowCount > 0;
    logger.debug(
      { teamId, groupId, removed },
      "TeamModel.removeExternalGroupById: completed",
    );
    return removed;
  }

  /**
   * Find all teams in an organization that have a specific external group mapped.
   * Used during SSO login to find which teams a user should be added to.
   */
  static async findTeamsByExternalGroup(
    organizationId: string,
    groupIdentifier: string,
  ): Promise<Team[]> {
    logger.debug(
      { organizationId, groupIdentifier },
      "TeamModel.findTeamsByExternalGroup: fetching teams",
    );
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

    logger.debug(
      { organizationId, groupIdentifier, count: results.length },
      "TeamModel.findTeamsByExternalGroup: completed",
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
    logger.debug(
      { organizationId, groupCount: groupIdentifiers.length },
      "TeamModel.findTeamsByExternalGroups: fetching teams",
    );
    if (groupIdentifiers.length === 0) {
      logger.debug(
        { organizationId },
        "TeamModel.findTeamsByExternalGroups: no group identifiers provided",
      );
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

    logger.debug(
      { organizationId, teamsFound: teamMap.size },
      "TeamModel.findTeamsByExternalGroups: completed",
    );
    return groupToTeams;
  }

  /**
   * Get a user's current SSO-synced team memberships in an organization
   */
  static async getSsoSyncedMemberships(
    userId: string,
    organizationId: string,
  ): Promise<Array<{ teamMember: TeamMember; team: Team }>> {
    logger.debug(
      { userId, organizationId },
      "TeamModel.getSsoSyncedMemberships: fetching memberships",
    );
    const memberships = await db
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

    logger.debug(
      { userId, organizationId, count: memberships.length },
      "TeamModel.getSsoSyncedMemberships: completed",
    );
    return memberships.map((m) => ({
      teamMember: m.teamMember,
      team: { ...m.team, members: [] },
    }));
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
    logger.debug(
      { userId, organizationId, groupCount: ssoGroups.length },
      "TeamModel.syncUserTeams: starting sync",
    );
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
    const currentSyncedMemberships = await TeamModel.getSsoSyncedMemberships(
      userId,
      organizationId,
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

    logger.debug(
      { userId, organizationId, added: added.length, removed: removed.length },
      "TeamModel.syncUserTeams: completed",
    );
    return { added, removed };
  }

  /**
   * Check if a user has access to a team.
   * - Team admins have full access to all teams
   * - Non-admins must be a member of the team
   */
  static async checkTeamAccess({
    userId,
    teamId,
    isTeamAdmin,
  }: {
    userId: string;
    teamId: string;
    isTeamAdmin: boolean;
  }): Promise<void> {
    // Admin has full access to all teams
    if (isTeamAdmin) {
      return;
    }
    // Non-admins must be a member of the team
    const isMember = await TeamModel.isUserInTeam(teamId, userId);
    if (!isMember) {
      throw new ApiError(403, "Not authorized to access this team");
    }
  }
}

export default TeamModel;
