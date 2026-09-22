import type { ResourcePermissionGrant } from "@archestra/shared";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type { Project, ProjectLifecycle, ProjectVisibility } from "@/types";
import ResourcePermissionAccessModel from "./resource-permission-access";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

/** Who a project reaches besides its owner, read from its permission policy. */
type ProjectAudience = {
  visibility: ProjectVisibility | null;
  teams: { id: string; name: string }[];
  users: { id: string; name: string }[];
};

type ProjectWithVisibility = Project & {
  visibility: ProjectVisibility | null;
};

/**
 * Who can reach a project. A project is shared through its permission policy
 * alone; `visibility` and the recipient lists are read back from the grants
 * on that policy for badges, filters and the default-agent audience check.
 */
class ProjectAccessModel {
  /**
   * Can this user read the project (and so: list its chats, start chats in
   * it, read its folder through chats)? Cross-org callers never pass.
   */
  static async userCanAccessProject(params: {
    project: Project;
    userId: string;
    organizationId: string;
    sessionAccess?: boolean;
  }): Promise<boolean> {
    const { project } = params;
    if (project.organizationId !== params.organizationId) return false;
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    const policyAccess = await ResourcePermissionAccessModel.canRead({
      ...params,
      resource: "project",
      scope: project.id,
      // Project-wide oversight does not reveal private session contents.
      includeWildcard: !params.sessionAccess,
    });
    if (policyAccess !== null) return policyAccess;
    // SPDX-SnippetEnd
    // Every project is created with a policy and the upgrade gave one to every
    // older project, so this is only reached for a row neither wrote. Such a
    // project is its owner's.
    return project.userId === params.userId;
  }

  /** Every active project the user's grants reach, own-first then newest. */
  static async listAccessibleProjects(params: {
    userId: string;
    organizationId: string;
  }): Promise<ProjectWithVisibility[]> {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    const projects = await db
      .select()
      .from(schema.projectsTable)
      .where(
        and(
          eq(schema.projectsTable.organizationId, params.organizationId),
          notDeleted(schema.projectsTable),
          ResourcePermissionPolicyModel.grantCondition({
            ...params,
            resource: "project",
            scopeColumn: schema.projectsTable.id,
            action: "read",
          }),
        ),
      );
    // SPDX-SnippetEnd
    return (await ProjectAccessModel.attachVisibility(projects)).sort(
      (a, b) => {
        const aOwn = a.userId === params.userId ? 0 : 1;
        const bOwn = b.userId === params.userId ? 0 : 1;
        if (aOwn !== bOwn) return aOwn - bOwn;
        return b.createdAt.getTime() - a.createdAt.getTime();
      },
    );
  }

  /**
   * Every project in the org, with visibility attached — newest first. Backs
   * the admin filter base set (a `project:admin` can see/oversee any project);
   * the service derives each project's viewerRole from the caller's real
   * access path.
   */
  static async listAllOrgProjects(params: {
    organizationId: string;
    // `active` (default) hides soft-deleted rows; `deleted` returns ONLY them
    // for the project:admin oversight view. There is no "both" slice.
    lifecycle?: ProjectLifecycle;
  }): Promise<ProjectWithVisibility[]> {
    const lifecycleFilter =
      params.lifecycle === "deleted"
        ? isNotNull(schema.projectsTable.deletedAt)
        : notDeleted(schema.projectsTable);
    const projects = await db
      .select()
      .from(schema.projectsTable)
      .where(
        and(
          eq(schema.projectsTable.organizationId, params.organizationId),
          lifecycleFilter,
        ),
      );
    return (await ProjectAccessModel.attachVisibility(projects)).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /** Each project's audience, keyed by project id. One pass over the policies. */
  static async getAudiences(
    projects: Pick<Project, "id" | "organizationId" | "userId">[],
  ): Promise<Map<string, ProjectAudience>> {
    const result = new Map<string, ProjectAudience>();
    if (projects.length === 0) return result;
    const policies = await db
      .select({
        organizationId: schema.resourcePermissionPoliciesTable.organizationId,
        scope: schema.resourcePermissionPoliciesTable.scope,
        grants: schema.resourcePermissionPoliciesTable.grants,
      })
      .from(schema.resourcePermissionPoliciesTable)
      .where(
        and(
          eq(schema.resourcePermissionPoliciesTable.resource, "project"),
          inArray(
            schema.resourcePermissionPoliciesTable.scope,
            projects.map((project) => project.id),
          ),
        ),
      );
    const grantsByProject = new Map<string, ResourcePermissionGrant[]>();
    for (const project of projects) {
      const policy = policies.find(
        (candidate) =>
          candidate.scope === project.id &&
          candidate.organizationId === project.organizationId,
      );
      grantsByProject.set(
        project.id,
        (policy?.grants ?? []).filter(
          (grant) =>
            grant.actions.includes("read") &&
            !(
              grant.subject.type === "user" &&
              grant.subject.id === project.userId
            ),
        ),
      );
    }
    const idsOf = (type: "team" | "user") => [
      ...new Set(
        [...grantsByProject.values()].flatMap((grants) =>
          grants
            .filter((grant) => grant.subject.type === type)
            .map((grant) => grant.subject.id),
        ),
      ),
    ];
    const [teamIds, userIds] = [idsOf("team"), idsOf("user")];
    const [teams, users] = await Promise.all([
      teamIds.length === 0
        ? []
        : db
            .select({ id: schema.teamsTable.id, name: schema.teamsTable.name })
            .from(schema.teamsTable)
            .where(inArray(schema.teamsTable.id, teamIds)),
      userIds.length === 0
        ? []
        : db
            .select({ id: schema.usersTable.id, name: schema.usersTable.name })
            .from(schema.usersTable)
            .where(inArray(schema.usersTable.id, userIds)),
    ]);
    const byName = (a: { name: string }, b: { name: string }) =>
      a.name.localeCompare(b.name);
    for (const [projectId, grants] of grantsByProject) {
      const granted = (type: "team" | "user") =>
        new Set(
          grants
            .filter((grant) => grant.subject.type === type)
            .map((grant) => grant.subject.id),
        );
      const teamSet = granted("team");
      const userSet = granted("user");
      const broad = grants.some(
        (grant) =>
          grant.subject.type === "organization" ||
          grant.subject.type === "role",
      );
      const named =
        userSet.size > 0 ||
        grants.some((grant) => grant.subject.type === "serviceAccount");
      result.set(projectId, {
        visibility: broad
          ? "organization"
          : teamSet.size > 0
            ? "team"
            : named
              ? "user"
              : null,
        teams: teams.filter((team) => teamSet.has(team.id)).sort(byName),
        users: users.filter((user) => userSet.has(user.id)).sort(byName),
      });
    }
    return result;
  }
  // SPDX-SnippetEnd

  /** One project's audience; see {@link getAudiences}. */
  static async findAudience(
    project: Pick<Project, "id" | "organizationId" | "userId">,
  ): Promise<ProjectAudience> {
    const audiences = await ProjectAccessModel.getAudiences([project]);
    return (
      audiences.get(project.id) ?? { visibility: null, teams: [], users: [] }
    );
  }

  private static async attachVisibility(
    projects: Project[],
  ): Promise<ProjectWithVisibility[]> {
    const audiences = await ProjectAccessModel.getAudiences(projects);
    return projects.map((project) => ({
      ...project,
      visibility: audiences.get(project.id)?.visibility ?? null,
    }));
  }
}

export default ProjectAccessModel;
