import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";

export interface Team {
  id: string;
  name: string;
  description: string | null;
  organizationId: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  members?: TeamMember[];
}

export interface TeamMember {
  id: string;
  teamId: string;
  userId: string;
  role: string;
  createdAt: Date;
}

export interface CreateTeamInput {
  name: string;
  description?: string;
  organizationId: string;
  createdBy: string;
}

export interface UpdateTeamInput {
  name?: string;
  description?: string;
}

class TeamModel {
  /**
   * Create a new team
   */
  static async create(input: CreateTeamInput): Promise<Team> {
    const teamId = crypto.randomUUID();
    const now = new Date();

    const [team] = await db
      .insert(schema.team)
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
      .from(schema.team)
      .where(eq(schema.team.organizationId, organizationId));

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
      .from(schema.team)
      .where(eq(schema.team.id, id))
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
  static async update(
    id: string,
    input: UpdateTeamInput,
  ): Promise<Team | null> {
    const [updatedTeam] = await db
      .update(schema.team)
      .set({
        ...input,
        updatedAt: new Date(),
      })
      .where(eq(schema.team.id, id))
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
    const result = await db.delete(schema.team).where(eq(schema.team.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Get all members of a team
   */
  static async getTeamMembers(teamId: string): Promise<TeamMember[]> {
    const members = await db
      .select()
      .from(schema.teamMember)
      .where(eq(schema.teamMember.teamId, teamId));

    return members;
  }

  /**
   * Add a member to a team
   */
  static async addMember(
    teamId: string,
    userId: string,
    role: string = "member",
  ): Promise<TeamMember> {
    const memberId = crypto.randomUUID();
    const now = new Date();

    const [member] = await db
      .insert(schema.teamMember)
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
      .delete(schema.teamMember)
      .where(
        and(
          eq(schema.teamMember.teamId, teamId),
          eq(schema.teamMember.userId, userId),
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
      .from(schema.teamMember)
      .where(eq(schema.teamMember.userId, userId));

    const teams = await Promise.all(
      teamMemberships.map(async (membership) => {
        return TeamModel.findById(membership.teamId);
      }),
    );

    return teams.filter((team): team is Team => team !== null);
  }

  /**
   * Check if a user is a member of a team
   */
  static async isUserInTeam(teamId: string, userId: string): Promise<boolean> {
    const [membership] = await db
      .select()
      .from(schema.teamMember)
      .where(
        and(
          eq(schema.teamMember.teamId, teamId),
          eq(schema.teamMember.userId, userId),
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
      .select({ teamId: schema.teamMember.teamId })
      .from(schema.teamMember)
      .where(eq(schema.teamMember.userId, userId));

    return teamMemberships.map((membership) => membership.teamId);
  }
}

export default TeamModel;
