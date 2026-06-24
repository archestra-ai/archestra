import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type { Project, ProjectShare, ProjectShareVisibility } from "@/types";

/** A project's share row with its team targets resolved. */
type ProjectShareWithTeams = ProjectShare & { teamIds: string[] };

/**
 * Sharing for projects — one share row per project, mirroring the
 * `conversation_shares` model: `organization` visibility covers the whole org,
 * `team` visibility covers members of the assigned teams. No share row means
 * the project is owner-only.
 */
class ProjectShareModel {
  /** Replace the project's share (visibility + team set) atomically. */
  static async upsert(params: {
    projectId: string;
    organizationId: string;
    createdByUserId: string;
    visibility: ProjectShareVisibility;
    teamIds: string[];
  }): Promise<void> {
    await db.transaction(async (tx) => {
      const [share] = await tx
        .insert(schema.projectSharesTable)
        .values({
          projectId: params.projectId,
          organizationId: params.organizationId,
          createdByUserId: params.createdByUserId,
          visibility: params.visibility,
        })
        .onConflictDoUpdate({
          target: schema.projectSharesTable.projectId,
          set: { visibility: params.visibility },
        })
        .returning();
      if (!share) throw new Error("failed to upsert project share");
      await tx
        .delete(schema.projectShareTeamsTable)
        .where(eq(schema.projectShareTeamsTable.shareId, share.id));
      if (params.visibility === "team" && params.teamIds.length > 0) {
        await tx.insert(schema.projectShareTeamsTable).values(
          params.teamIds.map((teamId) => ({
            shareId: share.id,
            teamId,
          })),
        );
      }
    });
  }

  static async remove(projectId: string): Promise<void> {
    await db
      .delete(schema.projectSharesTable)
      .where(eq(schema.projectSharesTable.projectId, projectId));
  }

  static async findByProjectId(
    projectId: string,
  ): Promise<ProjectShareWithTeams | null> {
    const [share] = await db
      .select()
      .from(schema.projectSharesTable)
      .where(eq(schema.projectSharesTable.projectId, projectId));
    if (!share) return null;
    const teams = await db
      .select({ teamId: schema.projectShareTeamsTable.teamId })
      .from(schema.projectShareTeamsTable)
      .where(eq(schema.projectShareTeamsTable.shareId, share.id));
    return { ...share, teamIds: teams.map((t) => t.teamId) };
  }

  /**
   * Can this user read the project (and so: list its chats, start chats in
   * it, read its folder through chats)? Owner always; otherwise the share row
   * decides. Cross-org callers never pass (both the project and the share are
   * org-scoped).
   */
  static async userCanAccessProject(params: {
    project: Project;
    userId: string;
    organizationId: string;
  }): Promise<boolean> {
    const { project } = params;
    if (project.organizationId !== params.organizationId) return false;
    if (project.userId === params.userId) return true;

    const share = await ProjectShareModel.findByProjectId(project.id);
    if (!share || share.organizationId !== params.organizationId) return false;
    if (share.visibility === "organization") return true;
    if (share.teamIds.length === 0) return false;

    const memberships = await db
      .select({ teamId: schema.teamMembersTable.teamId })
      .from(schema.teamMembersTable)
      .where(eq(schema.teamMembersTable.userId, params.userId));
    const userTeamIds = new Set(memberships.map((m) => m.teamId));
    return share.teamIds.some((teamId) => userTeamIds.has(teamId));
  }

  /**
   * Every project the user can see: their own, org-shared ones, and ones
   * shared with a team they belong to — deduped, own-first then newest.
   */
  static async listAccessibleProjects(params: {
    userId: string;
    organizationId: string;
  }): Promise<(Project & { visibility: ProjectShareVisibility | null })[]> {
    const own = await db
      .select()
      .from(schema.projectsTable)
      .where(
        and(
          eq(schema.projectsTable.userId, params.userId),
          eq(schema.projectsTable.organizationId, params.organizationId),
        ),
      );

    const orgShared = await db
      .select({ project: schema.projectsTable })
      .from(schema.projectsTable)
      .innerJoin(
        schema.projectSharesTable,
        eq(schema.projectsTable.id, schema.projectSharesTable.projectId),
      )
      .where(
        and(
          eq(schema.projectsTable.organizationId, params.organizationId),
          eq(schema.projectSharesTable.visibility, "organization"),
        ),
      );

    const memberships = await db
      .select({ teamId: schema.teamMembersTable.teamId })
      .from(schema.teamMembersTable)
      .where(eq(schema.teamMembersTable.userId, params.userId));
    const teamIds = memberships.map((m) => m.teamId);
    const teamShared =
      teamIds.length === 0
        ? []
        : await db
            .select({ project: schema.projectsTable })
            .from(schema.projectsTable)
            .innerJoin(
              schema.projectSharesTable,
              eq(schema.projectsTable.id, schema.projectSharesTable.projectId),
            )
            .innerJoin(
              schema.projectShareTeamsTable,
              eq(
                schema.projectSharesTable.id,
                schema.projectShareTeamsTable.shareId,
              ),
            )
            .where(
              and(
                eq(schema.projectsTable.organizationId, params.organizationId),
                inArray(schema.projectShareTeamsTable.teamId, teamIds),
              ),
            );

    const byId = new Map<string, Project>();
    for (const p of own) byId.set(p.id, p);
    for (const { project } of [...orgShared, ...teamShared]) {
      if (!byId.has(project.id)) byId.set(project.id, project);
    }
    const projects = [...byId.values()];

    return (await ProjectShareModel.attachVisibility(projects)).sort((a, b) => {
      const aOwn = a.userId === params.userId ? 0 : 1;
      const bOwn = b.userId === params.userId ? 0 : 1;
      if (aOwn !== bOwn) return aOwn - bOwn;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
  }

  /**
   * Every project in the org, with share visibility attached — newest first.
   * Backs the admin filter base set (a `project:admin` can see/oversee any
   * project); the service derives each project's viewerRole from the caller's
   * real access path.
   */
  static async listAllOrgProjects(params: {
    organizationId: string;
  }): Promise<(Project & { visibility: ProjectShareVisibility | null })[]> {
    const projects = await db
      .select()
      .from(schema.projectsTable)
      .where(eq(schema.projectsTable.organizationId, params.organizationId));
    return (await ProjectShareModel.attachVisibility(projects)).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  /**
   * Teams (id + name) each project is shared with, keyed by project id
   * (team-shared projects only). One query; backs both the `scope=team` +
   * `teamIds` filter and the owner's team-name visibility badge.
   */
  static async getShareTeamsForProjects(
    projectIds: string[],
  ): Promise<Map<string, { id: string; name: string }[]>> {
    if (projectIds.length === 0) return new Map();
    const rows = await db
      .select({
        projectId: schema.projectSharesTable.projectId,
        teamId: schema.teamsTable.id,
        teamName: schema.teamsTable.name,
      })
      .from(schema.projectSharesTable)
      .innerJoin(
        schema.projectShareTeamsTable,
        eq(schema.projectSharesTable.id, schema.projectShareTeamsTable.shareId),
      )
      .innerJoin(
        schema.teamsTable,
        eq(schema.projectShareTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(inArray(schema.projectSharesTable.projectId, projectIds));
    const byProject = new Map<string, { id: string; name: string }[]>();
    for (const { projectId, teamId, teamName } of rows) {
      const list = byProject.get(projectId) ?? [];
      list.push({ id: teamId, name: teamName });
      byProject.set(projectId, list);
    }
    return byProject;
  }

  /** Attach each project's share visibility (null = unshared) in one query. */
  private static async attachVisibility(
    projects: Project[],
  ): Promise<(Project & { visibility: ProjectShareVisibility | null })[]> {
    const shares =
      projects.length === 0
        ? []
        : await db
            .select({
              projectId: schema.projectSharesTable.projectId,
              visibility: schema.projectSharesTable.visibility,
            })
            .from(schema.projectSharesTable)
            .where(
              inArray(
                schema.projectSharesTable.projectId,
                projects.map((p) => p.id),
              ),
            );
    const visibilityByProject = new Map(
      shares.map((s) => [s.projectId, s.visibility]),
    );
    return projects.map((p) => ({
      ...p,
      visibility: visibilityByProject.get(p.id) ?? null,
    }));
  }
}

export default ProjectShareModel;
