import type { ResourcePermissionGrant } from "@archestra/shared";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type {
  Project,
  ProjectLifecycle,
  ProjectListScope,
  ProjectVisibility,
} from "@/types";
import { chunkForBulkStatement } from "@/utils/db";
import ResourcePermissionAccessModel from "./resource-permission-access";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import type {
  GrantPrincipal,
  ResourceAccessSelection,
} from "./resource-permission-subject";

/** Who a project reaches besides its owner, read from its permission policy. */
type ProjectAudience = {
  visibility: ProjectVisibility | null;
  teams: { id: string; name: string }[];
  users: { id: string; name: string }[];
};

/**
 * A project row for the list's filter/sort pass: no `icon` (a data URL can be
 * ~1 MB) and no recipient names, only what the filters and ordering read.
 */
type ProjectListCandidate = Pick<
  Project,
  | "id"
  | "organizationId"
  | "userId"
  | "name"
  | "description"
  | "createdAt"
  | "deletedAt"
> & {
  visibility: ProjectVisibility | null;
  /** Whether the caller's own grants reach the project (vs. oversight only). */
  accessible: boolean;
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
    return ResourcePermissionAccessModel.canRead({
      ...params,
      resource: "project",
      scope: project.id,
      // Project-wide oversight does not reveal private session contents.
      includeWildcard: !params.sessionAccess,
    });
    // SPDX-SnippetEnd
  }

  /**
   * One page of the projects list, filtered, ordered and counted in SQL.
   *
   * Without `includeOversight` only projects the caller's grants reach come
   * back. With it every project in the slice does, flagged by `accessible`,
   * unless `reachableOnly` drops the unreachable ones again (the "All" view).
   * Order is owner-first (when `ownerFirst`), then newest, then id, so pages
   * never overlap. Visibility is derived per returned row; only a `scope`
   * filter evaluates it for every candidate.
   */
  static async listPage(params: {
    userId: string;
    organizationId: string;
    principal: GrantPrincipal;
    includeOversight?: boolean;
    reachableOnly?: boolean;
    lifecycle?: ProjectLifecycle;
    scope?: ProjectListScope;
    /** Projects shared with any of these teams. */
    teamIds?: string[];
    authorIds?: string[];
    excludeAuthorIds?: string[];
    search?: string;
    /** Keep only these ids (e.g. a label match). */
    ids?: string[];
    /** Keep only the caller's pinned (`pinned: true`) or unpinned projects. */
    pins?: { ids: string[]; pinned: boolean };
    access?: ResourceAccessSelection;
    ownerFirst?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ rows: ProjectListCandidate[]; total: number }> {
    const table = schema.projectsTable;
    const visibility = ResourcePermissionPolicyModel.sharedAudience({
      organizationId: table.organizationId,
      resource: "project",
      scopeColumn: table.id,
      ownerColumn: table.userId,
    });
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    const accessible = ResourcePermissionPolicyModel.grantCondition({
      ...params.principal,
      resource: "project",
      scopeColumn: table.id,
      action: "read",
    });
    const accessRelations = params.access
      ? ResourcePermissionPolicyModel.accessRelationCondition({
          organizationId: params.organizationId,
          resource: "project",
          scopeColumn: table.id,
          ownerColumn: table.userId,
          userId: params.userId,
          subjects: params.principal.subjects,
          ...params.access,
        })
      : undefined;
    // SPDX-SnippetEnd
    const search = params.search?.trim().toLowerCase();
    const where = and(
      eq(table.organizationId, params.organizationId),
      params.lifecycle === "deleted"
        ? isNotNull(table.deletedAt)
        : notDeleted(table),
      // An overseer's "All" view keeps what their grants reach plus their own
      // projects, which read as theirs even without an owner grant.
      !params.includeOversight
        ? accessible
        : params.reachableOnly
          ? or(accessible, eq(table.userId, params.userId))
          : undefined,
      params.scope === "personal"
        ? sql`${visibility} IS NULL`
        : params.scope === "team"
          ? sql`${visibility} = 'team'`
          : params.scope === "org"
            ? sql`${visibility} = 'organization'`
            : undefined,
      accessRelations,
      params.teamIds?.length
        ? ResourcePermissionPolicyModel.grantsReadToAnyTeam({
            organizationId: params.organizationId,
            resource: "project",
            scopeColumn: table.id,
            teamIds: params.teamIds,
          })
        : undefined,
      params.authorIds?.length
        ? inArray(table.userId, params.authorIds)
        : undefined,
      params.excludeAuthorIds?.length
        ? notInArray(table.userId, params.excludeAuthorIds)
        : undefined,
      search
        ? or(
            sql`position(${search} in lower(${table.name})) > 0`,
            sql`position(${search} in lower(coalesce(${table.description}, ''))) > 0`,
          )
        : undefined,
      params.ids ? idIn(params.ids) : undefined,
      params.pins
        ? params.pins.pinned
          ? idIn(params.pins.ids)
          : sql`NOT ${idIn(params.pins.ids)}`
        : undefined,
    );
    const page = db
      .select({
        id: table.id,
        organizationId: table.organizationId,
        userId: table.userId,
        name: table.name,
        description: table.description,
        createdAt: table.createdAt,
        deletedAt: table.deletedAt,
        visibility,
        accessible: params.includeOversight
          ? sql<boolean>`${accessible}`
          : sql<boolean>`true`,
      })
      .from(table)
      .where(where)
      .orderBy(
        ...(params.ownerFirst
          ? [sql`(${table.userId} = ${params.userId}) DESC`]
          : []),
        desc(table.createdAt),
        asc(table.id),
      )
      .offset(params.offset ?? 0)
      .$dynamic();
    const [rows, [{ total }]] = await Promise.all([
      params.limit === undefined ? page : page.limit(params.limit),
      db.select({ total: sql<number>`count(*)::int` }).from(table).where(where),
    ]);
    return {
      rows: rows.map((row) => ({
        ...row,
        visibility: row.visibility ?? null,
        accessible: row.accessible === true,
      })),
      total,
    };
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
    const policyTable = schema.resourcePermissionPoliciesTable;
    const policies = (
      await Promise.all(
        chunkForBulkStatement(projects.map((project) => project.id)).map(
          (scopes) =>
            db
              .select({
                organizationId: policyTable.organizationId,
                scope: policyTable.scope,
                grants: policyTable.grants,
              })
              .from(policyTable)
              .where(
                and(
                  eq(policyTable.resource, "project"),
                  inArray(policyTable.scope, scopes),
                ),
              ),
        ),
      )
    ).flat();
    const policyKey = (organizationId: string, scope: string) =>
      `${organizationId}:${scope}`;
    const policyByKey = new Map(
      policies.map((policy) => [
        policyKey(policy.organizationId, policy.scope),
        policy,
      ]),
    );
    const grantsByProject = new Map<string, ResourcePermissionGrant[]>();
    for (const project of projects) {
      const policy = policyByKey.get(
        policyKey(project.organizationId, project.id),
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
      Promise.all(
        chunkForBulkStatement(teamIds).map((ids) =>
          db
            .select({ id: schema.teamsTable.id, name: schema.teamsTable.name })
            .from(schema.teamsTable)
            .where(inArray(schema.teamsTable.id, ids)),
        ),
      ).then((chunks) => chunks.flat()),
      Promise.all(
        chunkForBulkStatement(userIds).map((ids) =>
          db
            .select({ id: schema.usersTable.id, name: schema.usersTable.name })
            .from(schema.usersTable)
            .where(inArray(schema.usersTable.id, ids)),
        ),
      ).then((chunks) => chunks.flat()),
    ]);
    const teamById = new Map(teams.map((team) => [team.id, team]));
    const userById = new Map(users.map((user) => [user.id, user]));
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
        teams: [...teamSet]
          .flatMap((id) => teamById.get(id) ?? [])
          .sort(byName),
        users: [...userSet]
          .flatMap((id) => userById.get(id) ?? [])
          .sort(byName),
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
}

export default ProjectAccessModel;

// ===== Internal =====

/** `projects.id` among `ids`, as one array parameter whatever its length (empty matches none). */
function idIn(ids: string[]) {
  return sql`${schema.projectsTable.id} = ANY(${sql.param(ids)}::uuid[])`;
}
