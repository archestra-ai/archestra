// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  type PermissionSubject,
  type ResourcePermissionAction,
  type ResourcePermissionGrant,
  type ResourcePermissionScope,
  resourcePermissionPresets,
  type ScopedResource,
  ScopedResourceSchema,
  TEAM_RESOURCE_SCOPE,
} from "@archestra/shared";
import { predefinedRolesWithReadAccess } from "@archestra/shared/access-control";
import { and, eq, inArray, or, type SQLWrapper, sql } from "drizzle-orm";
import config from "@/config";
import db, { schema, type Transaction } from "@/database";
import RoleCompositionModel from "./role-composition";
import TeamModel from "./team";

export default class ResourcePermissionPolicyModel {
  /**
   * Grants are written by the upgrade whether or not the deployment reads
   * them, so one place decides whether they are authoritative yet. While the
   * switch is off every policy reads as unmigrated and carries no grants, and
   * each caller falls back to the retired visibility columns on its own.
   */
  private static inert<T extends { legacySharingMigrated: boolean }>(
    policies: T[],
  ): T[] {
    if (config.resourcePermissions.enabled) return policies;
    return policies.map((policy) => ({
      ...policy,
      legacySharingMigrated: false,
      grants: [],
    }));
  }

  /**
   * Whether a policy puts an object within reach of the organization at large,
   * for a principal that carries no role of its own — a shared credential, an
   * anonymous marketplace reader, or a skill handed to every holder of a
   * gateway token.
   *
   * Two subjects say so. An explicit grant to everyone is one. A grant to a
   * role on the object's OWN policy is the other: the upgrade writes
   * organization-wide visibility that way, because a role without the
   * resource's read action never saw the object. The same subject at `*` scope
   * is one role's authority over every object of the type, which a role-less
   * principal does not inherit.
   *
   * The SQL form of this rule lives in {@link organizationAccessCondition};
   * change both together.
   */
  static isOrganizationWide(params: {
    policy: { scope: string; grants: ResourcePermissionGrant[] };
    scope: string;
    action: ResourcePermissionAction;
  }): boolean {
    return params.policy.grants.some(
      (grant) =>
        grant.actions.includes(params.action) &&
        ((grant.subject.type === "organization" && grant.subject.id === "*") ||
          (grant.subject.type === "role" &&
            params.policy.scope === params.scope)),
    );
  }

  /** Shared credentials represent their organization or team, never a user role. */
  static async sharedCredentialHasAccess(params: {
    organizationId: string;
    resource: ScopedResource;
    scope: string;
    teamId: string | null;
    action: ResourcePermissionAction;
  }): Promise<boolean> {
    const teams = params.teamId
      ? await RoleCompositionModel.getTeamSources({
          organizationId: params.organizationId,
          teamId: params.teamId,
        })
      : [];
    if (params.teamId && !teams.some((team) => team.id === params.teamId))
      return false;
    const teamIds = new Set(teams.map((team) => team.id));
    const policies = await ResourcePermissionPolicyModel.findApplicable(params);
    return policies.some(
      (policy) =>
        (policy.scope === "*" || policy.scope === params.scope) &&
        (ResourcePermissionPolicyModel.isOrganizationWide({
          policy,
          scope: params.scope,
          action: params.action,
        }) ||
          policy.grants.some(
            (grant) =>
              grant.actions.includes(params.action) &&
              grant.subject.type === "team" &&
              teamIds.has(grant.subject.id),
          )),
    );
  }

  /** Provider refreshes create defaults only for models without a policy. */
  static async initializeModels(params: {
    tx: Transaction;
    modelIds: string[];
  }) {
    if (!params.modelIds.length) return;
    await params.tx.execute(sql`
      INSERT INTO resource_permission_policies
        (organization_id, resource, scope, grants, legacy_sharing_migrated)
      SELECT organization_policy.organization_id, 'llmModel', model.id::text,
        '[{"subject":{"type":"organization","id":"*"},"actions":["read","use"]}]'::jsonb,
        true
      FROM models model
      JOIN resource_permission_policies organization_policy
        ON organization_policy.resource = 'llmModel'
        AND organization_policy.scope = '*'
        AND organization_policy.legacy_sharing_migrated
      WHERE ${inArray(sql`model.id`, params.modelIds)}
      ON CONFLICT (organization_id, resource, scope) DO NOTHING
    `);
  }

  /** Seed the same role scopes as the backfill when provisioning a new organization. */
  static async initializeOrganization(params: {
    tx: Transaction;
    organizationId: string;
  }) {
    await params.tx
      .insert(schema.resourcePermissionPoliciesTable)
      .values([
        ...ScopedResourceSchema.options.map((resource) => ({
          organizationId: params.organizationId,
          resource,
          scope: "*",
          legacySharingMigrated: true,
          grants: [
            ...["admin", "platform_admin"].map((id) => ({
              subject: { type: "role" as const, id },
              actions: resourcePermissionPresets.manage.actions,
            })),
            ...(resource === "llmModel"
              ? [
                  {
                    subject: { type: "role" as const, id: "editor" },
                    actions: [
                      "read",
                      "use",
                      "update",
                      "manage-permissions",
                    ] as ResourcePermissionAction[],
                  },
                ]
              : []),
          ],
        })),
        ...(["agent", "mcpGateway", "skill", "app"] as const).map(
          (resource) => ({
            organizationId: params.organizationId,
            resource,
            scope: TEAM_RESOURCE_SCOPE,
            legacySharingMigrated: true,
            grants: [
              {
                subject: { type: "role" as const, id: "editor" },
                actions: resourcePermissionPresets.manage.actions,
              },
            ],
          }),
        ),
      ])
      .onConflictDoNothing();
    const models = await params.tx
      .select({ id: schema.modelsTable.id })
      .from(schema.modelsTable);
    await ResourcePermissionPolicyModel.initializeModels({
      tx: params.tx,
      modelIds: models.map((model) => model.id),
    });
  }

  /** A migrated policy is authoritative even when its grant list is empty. */
  static legacySharingCondition(params: {
    organizationId: string | SQLWrapper;
    resource: ScopedResource;
    scopeColumn: SQLWrapper;
  }) {
    // Every list falls back to the visibility columns while the switch is off.
    if (!config.resourcePermissions.enabled) return sql`true`;
    return sql`NOT EXISTS (
      SELECT 1 FROM resource_permission_policies migrated_policy
      WHERE migrated_policy.organization_id = ${params.organizationId}
        AND migrated_policy.resource = ${params.resource}
        AND migrated_policy.scope IN (( ${params.scopeColumn})::text, '*')
        AND migrated_policy.legacy_sharing_migrated
    )`;
  }

  /**
   * Organization-wide publication and shared credentials, for principals that
   * carry no role of their own.
   *
   * Two subjects answer for "the organization at large". An explicit grant to
   * everyone is one. A grant to a role on the object's OWN policy is the
   * other: the upgrade writes organization-wide visibility that way, because a
   * role without the resource's read action never saw the object. The same
   * subject at `*` scope is one role's authority over every object of the
   * type, which a role-less principal does not inherit.
   */
  static organizationAccessCondition(params: {
    organizationId: string | SQLWrapper;
    resource: ScopedResource;
    scopeColumn: SQLWrapper;
    action: ResourcePermissionAction;
    legacyCondition: SQLWrapper;
  }) {
    if (!config.resourcePermissions.enabled) return params.legacyCondition;
    return sql`(
      (${ResourcePermissionPolicyModel.legacySharingCondition(params)} AND ${params.legacyCondition})
      OR EXISTS (
        SELECT 1 FROM resource_permission_policies organization_access_policy,
          jsonb_array_elements(organization_access_policy.grants) organization_grant
        WHERE organization_access_policy.organization_id = ${params.organizationId}
          AND organization_access_policy.resource = ${params.resource}
          AND organization_access_policy.scope IN ('*', (${params.scopeColumn})::text)
          AND (
            (organization_grant->'subject'->>'type' = 'organization'
              AND organization_grant->'subject'->>'id' = '*')
            OR (organization_grant->'subject'->>'type' = 'role'
              AND organization_access_policy.scope = (${params.scopeColumn})::text)
          )
          AND (organization_grant->'actions') ? ${params.action}
      )
    )`;
  }

  /** Extra list fence while old visibility columns remain during the cutover. */
  static migratedAccessCondition(params: {
    organizationId: string | SQLWrapper;
    resource: ScopedResource;
    scopeColumn: SQLWrapper;
    userId: string;
    action: ResourcePermissionAction;
  }) {
    return or(
      ResourcePermissionPolicyModel.legacySharingCondition(params),
      ResourcePermissionPolicyModel.grantCondition(params),
    );
  }

  static async deleteForTarget(params: {
    tx: Transaction;
    resources: ScopedResource[];
    scope: string;
  }) {
    await params.tx
      .delete(schema.resourcePermissionPoliciesTable)
      .where(
        and(
          inArray(
            schema.resourcePermissionPoliciesTable.resource,
            params.resources,
          ),
          eq(schema.resourcePermissionPoliciesTable.scope, params.scope),
        ),
      );
  }

  /** Called in the resource's insertion transaction, after service validation. */
  static async createInitial(params: {
    tx: Transaction;
    organizationId: string;
    resource: ScopedResource;
    scope: string;
    grants?: ResourcePermissionGrant[];
    authorId: string | null;
    visibility?: "personal" | "team" | "org";
    teams?: { id: string; level?: "use" | "write" }[];
    users?: string[];
  }) {
    if (params.grants === undefined) {
      const [migrated] = await params.tx
        .select({ scope: schema.resourcePermissionPoliciesTable.scope })
        .from(schema.resourcePermissionPoliciesTable)
        .where(
          and(
            eq(
              schema.resourcePermissionPoliciesTable.organizationId,
              params.organizationId,
            ),
            eq(
              schema.resourcePermissionPoliciesTable.resource,
              params.resource,
            ),
            eq(schema.resourcePermissionPoliciesTable.scope, "*"),
            eq(
              schema.resourcePermissionPoliciesTable.legacySharingMigrated,
              true,
            ),
          ),
        )
        .limit(1);
      if (!migrated) return;
    }
    const initialGrants: ResourcePermissionGrant[] = params.grants ?? [];
    if (params.grants === undefined) {
      if (params.visibility === "org") {
        // Organization-wide visibility never reached a member whose role
        // withheld this resource's read action, so it becomes a grant to the
        // roles that hold it rather than to everyone. Choosing everyone stays
        // available as a deliberate act in the permissions editor.
        const [predefined, custom] = await Promise.all([
          Promise.resolve(predefinedRolesWithReadAccess(params.resource)),
          params.tx
            .select({ id: schema.organizationRolesTable.id })
            .from(schema.organizationRolesTable)
            .where(
              and(
                eq(
                  schema.organizationRolesTable.organizationId,
                  params.organizationId,
                ),
                sql`coalesce(${schema.organizationRolesTable.permission}::jsonb -> ${params.resource}, '[]'::jsonb) ? 'read'`,
              ),
            ),
        ]);
        initialGrants.push(
          ...[
            ...predefined,
            ...custom.map((role: { id: string }) => role.id),
          ].map((id) => ({
            subject: { type: "role" as const, id },
            actions: ["read" as const, "use" as const],
          })),
        );
      } else if (params.visibility === "team" && params.teams?.length) {
        const teams = await params.tx
          .select({ id: schema.teamsTable.id })
          .from(schema.teamsTable)
          .where(
            and(
              eq(schema.teamsTable.organizationId, params.organizationId),
              inArray(
                schema.teamsTable.id,
                params.teams.map((team) => team.id),
              ),
            ),
          );
        for (const team of teams)
          initialGrants.push({
            subject: { type: "team", id: team.id },
            actions: params.teams.some(
              (entry) => entry.id === team.id && entry.level === "write",
            )
              ? ["read", "use", "update"]
              : ["read", "use"],
          });
      } else if (params.visibility === "personal" && params.users?.length) {
        initialGrants.push(
          ...[...new Set(params.users)].map((id) => ({
            subject: { type: "user" as const, id },
            actions: ["read" as const, "use" as const],
          })),
        );
      }
    }
    const author: PermissionSubject | null = params.authorId
      ? params.authorId.startsWith("service-account:")
        ? {
            type: "serviceAccount",
            id: params.authorId.slice("service-account:".length),
          }
        : { type: "user", id: params.authorId }
      : null;
    const grants = author
      ? [
          ...initialGrants.filter(
            (grant) =>
              grant.subject.type !== author.type ||
              grant.subject.id !== author.id,
          ),
          {
            subject: author,
            actions: resourcePermissionPresets.manage.actions,
          },
        ]
      : initialGrants;
    await params.tx.insert(schema.resourcePermissionPoliciesTable).values({
      organizationId: params.organizationId,
      resource: params.resource,
      scope: params.scope,
      grants,
      legacySharingMigrated: true,
    });
  }

  static async findForSubjects(params: {
    organizationId: string;
    subjects: PermissionSubject[];
  }) {
    if (params.subjects.length === 0) return [];
    if (!config.resourcePermissions.enabled) return [];
    const table = schema.resourcePermissionPoliciesTable;
    return db
      .select()
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          or(
            ...params.subjects.map(
              (subject) =>
                sql`${table.grants} @> ${JSON.stringify([{ subject }])}::jsonb`,
            ),
          ),
        ),
      );
  }

  /** SQL counterpart of the resolver, applied before list pagination/counts. */
  static grantCondition(params: {
    organizationId: string | SQLWrapper;
    userId: string;
    resource: ScopedResource;
    scopeColumn: SQLWrapper;
    action: ResourcePermissionAction;
  }) {
    // No grant answers for anyone until the deployment reads grants at all.
    if (!config.resourcePermissions.enabled) return sql`false`;
    const serviceAccountId = params.userId.startsWith("service-account:")
      ? params.userId.slice("service-account:".length)
      : null;
    const member = sql`EXISTS (SELECT 1 FROM member grant_member WHERE grant_member.organization_id = ${params.organizationId} AND grant_member.user_id = ${params.userId})`;
    const account = sql`EXISTS (SELECT 1 FROM service_accounts grant_account WHERE grant_account.organization_id = ${params.organizationId} AND grant_account.id::text = ${serviceAccountId} AND NOT grant_account.disabled)`;
    const membership = TeamModel.effectiveMembershipCondition({
      userId: params.userId,
      teamIdColumn: sql`grant_entry->'subject'->>'id'`,
    });
    const sharedWithTeam = sql`EXISTS (
      SELECT 1 FROM resource_permission_policies team_shared_policy,
        jsonb_array_elements(team_shared_policy.grants) shared_team_entry
      WHERE team_shared_policy.organization_id = ${params.organizationId}
        AND team_shared_policy.resource = ${params.resource}
        AND team_shared_policy.scope = ${params.scopeColumn}::text
        AND shared_team_entry->'subject'->>'type' = 'team'
        AND ${serviceAccountId ? sql`false` : TeamModel.effectiveMembershipCondition({ userId: params.userId, teamIdColumn: sql`shared_team_entry->'subject'->>'id'` })}
    )`;
    const inheritedRole = sql`EXISTS (SELECT 1 FROM team grant_team WHERE grant_team.organization_id = ${params.organizationId} AND ${TeamModel.effectiveMembershipCondition({ userId: params.userId, teamIdColumn: sql`grant_team.id` })} AND grant_role.identifier = ANY(grant_team.roles))`;
    const role = sql`EXISTS (
      SELECT 1 FROM (
        SELECT role AS identifier, id FROM organization_role WHERE organization_id = ${params.organizationId}
        UNION ALL SELECT builtin, builtin FROM unnest(ARRAY['admin','platform_admin','editor','member']) builtin
      ) grant_role
      WHERE grant_role.id = grant_entry->'subject'->>'id'
      AND (${serviceAccountId ? sql`EXISTS (SELECT 1 FROM service_accounts a WHERE a.organization_id = ${params.organizationId} AND a.id::text = ${serviceAccountId} AND grant_role.identifier = ANY(string_to_array(a.role, ',')))` : sql`EXISTS (SELECT 1 FROM member m WHERE m.organization_id = ${params.organizationId} AND m.user_id = ${params.userId} AND grant_role.identifier = ANY(string_to_array(m.role, ','))) OR ${inheritedRole}`})
    )`;
    return sql<boolean>`(${serviceAccountId ? account : member}) AND EXISTS (
      SELECT 1 FROM resource_permission_policies grant_policy,
        jsonb_array_elements(grant_policy.grants) grant_entry
      WHERE grant_policy.organization_id = ${params.organizationId}
        AND grant_policy.resource = ${params.resource}
        AND (grant_policy.scope = '*' OR grant_policy.scope = ${params.scopeColumn}::text
          OR (grant_policy.scope = ${TEAM_RESOURCE_SCOPE} AND ${sharedWithTeam}))
        AND (grant_entry->'actions') ? ${params.action}
        AND (
          (grant_entry->'subject'->>'type' = 'organization' AND grant_entry->'subject'->>'id' = '*')
          OR (grant_entry->'subject'->>'type' = ${serviceAccountId ? "serviceAccount" : "user"} AND grant_entry->'subject'->>'id' = ${serviceAccountId ?? params.userId})
          OR (${serviceAccountId ? sql`false` : sql`grant_entry->'subject'->>'type' = 'team' AND ${membership}`})
          OR (grant_entry->'subject'->>'type' = 'role' AND ${role})
        )
    )`;
  }
  static async findByIdForAudit(
    scope: string,
    organizationId: string,
    routeParams?: Record<string, unknown>,
  ) {
    const resource = ScopedResourceSchema.safeParse(routeParams?.resource);
    if (!resource.success) return null;
    const policy = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: resource.data,
      scope,
    });
    return policy
      ? {
          resource: policy.resource,
          scope: policy.scope,
          grants: policy.grants,
        }
      : { resource: resource.data, scope, grants: [] };
  }
  static async find(params: PolicyKey) {
    const [policy] = ResourcePermissionPolicyModel.inert(
      await db
        .select()
        .from(schema.resourcePermissionPoliciesTable)
        .where(policyCondition(params)),
    );
    return policy ?? null;
  }

  static async findApplicable(params: PolicyKey) {
    return ResourcePermissionPolicyModel.findApplicableBatch({
      ...params,
      scopes: [params.scope],
    });
  }

  static async findApplicableBatch(params: {
    organizationId: string;
    resource: ScopedResource;
    scopes: string[];
  }) {
    const table = schema.resourcePermissionPoliciesTable;
    return ResourcePermissionPolicyModel.inert(
      await db
        .select()
        .from(table)
        .where(
          and(
            eq(table.organizationId, params.organizationId),
            eq(table.resource, params.resource),
            inArray(table.scope, [...params.scopes, "*", TEAM_RESOURCE_SCOPE]),
          ),
        ),
    );
  }

  /** revision=0 creates a policy; stale writers never overwrite newer revocations. */
  static async replace(
    params: PolicyKey & { revision: number; grants: ResourcePermissionGrant[] },
  ) {
    const table = schema.resourcePermissionPoliciesTable;
    if (params.revision === 0) {
      const [created] = await db
        .insert(table)
        .values({
          organizationId: params.organizationId,
          resource: params.resource,
          scope: params.scope,
          grants: params.grants,
        })
        .onConflictDoNothing()
        .returning();
      return created ?? null;
    }
    const [updated] = await db
      .update(table)
      .set({
        grants: params.grants,
        revision: params.revision + 1,
        updatedAt: new Date(),
      })
      .where(and(policyCondition(params), eq(table.revision, params.revision)))
      .returning();
    return updated ?? null;
  }

  /**
   * Move one subject's direct grant to another subject, unioning any actions
   * the recipient already holds. Ownership transfer uses this so the previous
   * owner's creator grant follows the record; unrelated grants are untouched.
   */
  static async transferSubjectGrant(
    params: PolicyKey & {
      from: PermissionSubject;
      to: PermissionSubject;
      tx?: Transaction;
    },
  ): Promise<boolean> {
    const table = schema.resourcePermissionPoliciesTable;
    const executor = params.tx ?? db;
    const [policy] = await executor
      .select()
      .from(table)
      .where(policyCondition(params));
    if (!policy) return false;
    const sameSubject = (a: PermissionSubject, b: PermissionSubject) =>
      a.type === b.type && a.id === b.id;
    const moved = policy.grants.find((grant) =>
      sameSubject(grant.subject, params.from),
    );
    if (!moved) return false;
    const existing = policy.grants.find((grant) =>
      sameSubject(grant.subject, params.to),
    );
    const actions = [
      ...new Set([...(existing?.actions ?? []), ...moved.actions]),
    ].sort();
    const grants: ResourcePermissionGrant[] = [
      ...policy.grants.filter(
        (grant) =>
          !sameSubject(grant.subject, params.from) &&
          !sameSubject(grant.subject, params.to),
      ),
      { subject: params.to, actions },
    ];
    const [updated] = await executor
      .update(table)
      .set({ grants, revision: policy.revision + 1, updatedAt: new Date() })
      .where(and(policyCondition(params), eq(table.revision, policy.revision)))
      .returning({ scope: table.scope });
    return !!updated;
  }
}

type PolicyKey = {
  organizationId: string;
  resource: ScopedResource;
  scope: ResourcePermissionScope;
};

function policyCondition(params: PolicyKey) {
  const table = schema.resourcePermissionPoliciesTable;
  return and(
    eq(table.organizationId, params.organizationId),
    eq(table.resource, params.resource),
    eq(table.scope, params.scope),
  );
}
