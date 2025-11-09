import { MEMBER_ROLE_NAME } from "@shared";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertTeam, Team, TeamMember, UpdateTeam } from "@/types";

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
}

export default TeamModel;
