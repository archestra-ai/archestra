// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  isResourcePermissionPreset,
  type PermissionSubject,
  type ResourcePermissionAction,
  type ResourcePermissionGrant,
  type ResourcePermissionScope,
  resourcePermissionPresets,
  type ScopedResource,
  ScopedResourceSchema,
  widenToPreset,
} from "@archestra/shared";
import { predefinedRolesWithReadAccess } from "@archestra/shared/access-control";
import { and, eq, inArray, or, type SQLWrapper, sql } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import RoleCompositionModel from "./role-composition";
import TeamModel from "./team";

export default class ResourcePermissionPolicyModel {
  /**
   * Whether a policy puts an object within reach of the organization at large,
   * for a principal that carries no role of its own — a shared credential, an
   * anonymous marketplace reader, or a skill handed to every holder of a
   * gateway token.
   *
   * Two subjects say so. An explicit grant to everyone is one. A grant to a
   * role on the object's OWN policy is the other when the policy has the
   * legacy organization-audience marker. The upgrade writes organization-wide
   * visibility through role grants because a role without the resource's read
   * action never saw the object. A new role grant cannot publish an object to
   * role-less credentials.
   *
   * The SQL form of this rule lives in {@link organizationAccessCondition};
   * change both together.
   */
  static isOrganizationWide(params: {
    policy: {
      scope: string;
      grants: ResourcePermissionGrant[];
      legacyOrganizationAudience: boolean;
    };
    scope: string;
    action: ResourcePermissionAction;
  }): boolean {
    return params.policy.grants.some(
      (grant) =>
        grant.actions.includes(params.action) &&
        ((grant.subject.type === "organization" && grant.subject.id === "*") ||
          (grant.subject.type === "role" &&
            params.policy.legacyOrganizationAudience &&
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

  /**
   * Of `scopes`, the ones within reach of the organization at large for
   * `action` — {@link isOrganizationWide} over each object's own policy and
   * the resource's `*` policy. For principals with no user of their own.
   */
  static async findOrganizationWideScopes(params: {
    organizationId: string;
    resource: ScopedResource;
    scopes: string[];
    action: ResourcePermissionAction;
  }): Promise<Set<string>> {
    if (params.scopes.length === 0) return new Set();
    const policies =
      await ResourcePermissionPolicyModel.findApplicableBatch(params);
    return new Set(
      params.scopes.filter((scope) =>
        policies.some(
          (policy) =>
            (policy.scope === "*" || policy.scope === scope) &&
            ResourcePermissionPolicyModel.isOrganizationWide({
              policy,
              scope,
              action: params.action,
            }),
        ),
      ),
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
        ...ScopedResourceSchema.options
          .filter(
            (resource) =>
              resource !== "conversation" && resource !== "agentRun",
          )
          .map((resource) => ({
            organizationId: params.organizationId,
            resource,
            scope: "*",
            legacySharingMigrated: true,
            grants: [
              ...(resource === "log" || resource === "auditLog"
                ? ["admin"]
                : ["admin", "platform_admin"]
              ).map((id) => ({
                subject: { type: "role" as const, id },
                actions:
                  resource === "log" || resource === "auditLog"
                    ? ([
                        "read",
                        "manage-permissions",
                      ] as ResourcePermissionAction[])
                    : resourcePermissionPresets.manage.actions,
              })),
              ...(resource === "llmModel"
                ? [
                    {
                      // Editors manage models. They held every model action
                      // but delete, and no preset stops short of delete once
                      // it includes manage-permissions.
                      subject: { type: "role" as const, id: "editor" },
                      actions: resourcePermissionPresets.manage.actions,
                    },
                  ]
                : []),
              // Editors could always deploy into a restricted environment, back
              // when that was a `deploy-to-restricted` action on each kind of
              // thing deployed. `use` on every environment is that same reach.
              ...(resource === "environment"
                ? [
                    {
                      subject: { type: "role" as const, id: "editor" },
                      actions: ["read", "use"] as ResourcePermissionAction[],
                    },
                  ]
                : []),
            ],
          })),
        {
          // Reading other members' chats inside a project the reader can
          // open. The admin-tier roles held it as `project:read-all`; it is
          // honoured for project chats alone, never for a private chat. They
          // also manage it, so they can still assign the roles that carry it.
          organizationId: params.organizationId,
          resource: "conversation" as const,
          scope: "*",
          legacySharingMigrated: true,
          grants: ["admin", "platform_admin"].map((id) => ({
            subject: { type: "role" as const, id },
            actions: [
              "read",
              "manage-permissions",
            ] as ResourcePermissionAction[],
          })),
        },
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

  /**
   * Organization-wide publication and shared credentials, for principals that
   * carry no role of their own.
   *
   * Two subjects answer for "the organization at large". An explicit grant to
   * everyone is one. A grant to a role on the object's OWN policy is the
   * other when that policy carries the legacy organization-audience marker.
   * Explicit role grants on new resources do not publish them to role-less
   * credentials.
   *
   * The marker is the one piece of the retired visibility model still read
   * here, and deliberately: the conversion turned "visible to the whole
   * organization" into role grants, and a principal with no role would lose
   * every object it could reach without it. Retiring it needs its own
   * decision about how an object is published to role-less principals.
   */
  static organizationAccessCondition(params: {
    organizationId: string | SQLWrapper;
    resource: ScopedResource;
    scopeColumn: SQLWrapper;
    action: ResourcePermissionAction;
  }) {
    return sql`(
      EXISTS (
        SELECT 1 FROM resource_permission_policies organization_access_policy,
          jsonb_array_elements(organization_access_policy.grants) organization_grant
        WHERE organization_access_policy.organization_id = ${params.organizationId}
          AND organization_access_policy.resource = ${params.resource}
          AND organization_access_policy.scope IN ('*', (${params.scopeColumn})::text)
          AND (
            (organization_grant->'subject'->>'type' = 'organization'
              AND organization_grant->'subject'->>'id' = '*')
            OR (organization_grant->'subject'->>'type' = 'role'
              AND organization_access_policy.legacy_organization_audience
              AND organization_access_policy.scope = (${params.scopeColumn})::text)
          )
          AND (organization_grant->'actions') ? ${params.action}
      )
    )`;
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
    /**
     * Publish the new object to the whole organization, for callers that
     * speak for the system rather than for a person: built-in skills, the
     * seeded provider key, default plugins, demo apps. Request-driven creation
     * never sets it; a person shares through explicit `grants`, which the
     * routes bound by what the creator may delegate.
     */
    publishToOrganization?: boolean;
  }) {
    // Every object gets a policy, always. This used to wait for the
    // organization's wildcard policy to be converted, because writing one
    // sooner would have governed the object by grants while the old sharing
    // fields still decided access elsewhere. The conversion is unconditional
    // now and runs before the server accepts a request, so the object that
    // skipped its policy would simply be unreachable by its own author.
    const initialGrants: ResourcePermissionGrant[] = [...(params.grants ?? [])];
    if (params.publishToOrganization) {
      // Organization-wide visibility was two rules, not one, and the halves
      // were gated differently. Finding the object went through a route that
      // asked for this resource's read action, so a role which withheld it
      // never saw the object; that half becomes a grant to the roles which
      // hold read. Working with the object asked for no such thing — chatting
      // went through chat permissions, and an unrestricted model through
      // nothing at all — so for the three resources that have a "work with
      // it" path, use goes to the organization at large. Granting only the
      // readers would take chat from a role built for exactly that.
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
        ...(USE_UNGATED_BY_ROLE.has(params.resource)
          ? [
              {
                subject: { type: "organization" as const, id: "*" as const },
                actions: ["use" as const],
              },
            ]
          : []),
      );
    }
    const author: PermissionSubject | null = params.authorId
      ? params.authorId.startsWith("service-account:")
        ? {
            type: "serviceAccount",
            id: params.authorId.slice("service-account:".length),
          }
        : { type: "user", id: params.authorId }
      : null;
    const grants = asPresets(
      author
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
        : initialGrants,
      params.resource,
    );
    await params.tx.insert(schema.resourcePermissionPoliciesTable).values({
      organizationId: params.organizationId,
      resource: params.resource,
      scope: params.scope,
      grants,
      legacySharingMigrated: true,
      // The marker is how a published object reaches principals with no role
      // of their own (see organizationAccessCondition).
      legacyOrganizationAudience: params.publishToOrganization === true,
    });
  }

  static async findForSubjects(params: {
    organizationId: string;
    subjects: PermissionSubject[];
  }) {
    if (params.subjects.length === 0) return [];
    const table = schema.resourcePermissionPoliciesTable;
    return db
      .select()
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          sql`(${table.scope} = '*' OR ${table.scope} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')`,
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
    includeWildcard?: boolean;
  }) {
    const serviceAccountId = params.userId.startsWith("service-account:")
      ? params.userId.slice("service-account:".length)
      : null;
    const member = sql`EXISTS (SELECT 1 FROM member grant_member WHERE grant_member.organization_id = ${params.organizationId} AND grant_member.user_id = ${params.userId})`;
    const account = sql`EXISTS (SELECT 1 FROM service_accounts grant_account WHERE grant_account.organization_id = ${params.organizationId} AND grant_account.id::text = ${serviceAccountId} AND NOT grant_account.disabled)`;
    const membership = TeamModel.effectiveMembershipCondition({
      userId: params.userId,
      teamIdColumn: sql`grant_entry->'subject'->>'id'`,
    });
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
        AND ((${params.includeWildcard !== false} AND grant_policy.scope = '*') OR grant_policy.scope = ${params.scopeColumn}::text)
        AND (grant_entry->'actions') ? ${params.action}
        AND (
          (grant_entry->'subject'->>'type' = 'organization' AND grant_entry->'subject'->>'id' = '*')
          OR (grant_entry->'subject'->>'type' = ${serviceAccountId ? "serviceAccount" : "user"} AND grant_entry->'subject'->>'id' = ${serviceAccountId ?? params.userId})
          OR (${serviceAccountId ? sql`false` : sql`grant_entry->'subject'->>'type' = 'team' AND ${membership}`})
          OR (grant_entry->'subject'->>'type' = 'role' AND ${role})
        )
    )`;
  }

  /**
   * The broadest audience an object's own policy grants read to, besides its
   * owner, for the "shared with ..." badge on lists. A grant to everyone or to
   * a role reads as `organization`, then team grants as `team`, then named
   * people or service accounts as `user`. Null means only the owner reads it.
   * Inherited `*` grants are not the object's sharing, so they are left out.
   */
  static sharedAudience(params: {
    organizationId: string | SQLWrapper;
    resource: ScopedResource;
    scopeColumn: SQLWrapper;
    ownerColumn: SQLWrapper;
  }) {
    return sql<"organization" | "team" | "user" | null>`(
      SELECT CASE
        WHEN bool_or(audience_entry->'subject'->>'type' IN ('organization', 'role')) THEN 'organization'
        WHEN bool_or(audience_entry->'subject'->>'type' = 'team') THEN 'team'
        WHEN bool_or(audience_entry->'subject'->>'type' = 'serviceAccount'
          OR (audience_entry->'subject'->>'type' = 'user'
            AND audience_entry->'subject'->>'id' IS DISTINCT FROM ${params.ownerColumn}::text)) THEN 'user'
      END
      FROM resource_permission_policies audience_policy,
        jsonb_array_elements(audience_policy.grants) audience_entry
      WHERE audience_policy.organization_id = ${params.organizationId}
        AND audience_policy.resource = ${params.resource}
        AND audience_policy.scope = ${params.scopeColumn}::text
        AND (audience_entry->'actions') ? 'read'
    )`;
  }

  /**
   * Whether an object's own grants give it the named audience — the label the
   * retired visibility field used to carry, now derived from
   * {@link sharedAudience}: `org` when the policy reaches the organization or
   * a role, `team` when it reaches a team, and `personal` otherwise (the
   * owner alone, or named people). List filters and orderings that read the
   * old field read this instead, so they follow permission edits.
   */
  static audienceIs(params: {
    organizationId: string | SQLWrapper;
    resource: ScopedResource;
    scopeColumn: SQLWrapper;
    ownerColumn: SQLWrapper;
    audience: "personal" | "team" | "org";
  }) {
    const shared = ResourcePermissionPolicyModel.sharedAudience(params);
    switch (params.audience) {
      case "org":
        return sql<boolean>`coalesce(${shared} = 'organization', false)`;
      case "team":
        return sql<boolean>`coalesce(${shared} = 'team', false)`;
      case "personal":
        return sql<boolean>`coalesce(${shared}, 'user') = 'user'`;
    }
  }

  /**
   * Whether an object's own policy grants read to any of `teamIds`. Replaces
   * filtering by the retired team assignment rows.
   */
  static grantsReadToAnyTeam(params: {
    organizationId: string | SQLWrapper;
    resource: ScopedResource;
    scopeColumn: SQLWrapper;
    teamIds: string[];
  }) {
    if (params.teamIds.length === 0) return sql<boolean>`false`;
    return sql<boolean>`EXISTS (
      SELECT 1 FROM resource_permission_policies team_policy,
        jsonb_array_elements(team_policy.grants) team_entry
      WHERE team_policy.organization_id = ${params.organizationId}
        AND team_policy.resource = ${params.resource}
        AND team_policy.scope = ${params.scopeColumn}::text
        AND (team_entry->'actions') ? 'read'
        AND team_entry->'subject'->>'type' = 'team'
        AND ${inArray(sql`team_entry->'subject'->>'id'`, params.teamIds)}
    )`;
  }

  /**
   * The audience and granted teams of one object, from its own policy, in
   * the terms of {@link audienceIs}. For callers that decide in code rather
   * than in a query.
   */
  static async findAudience(params: {
    organizationId: string;
    resource: ScopedResource;
    scope: string;
  }): Promise<ObjectAudience> {
    return audienceOf(await ResourcePermissionPolicyModel.find(params));
  }

  /**
   * Whether an object's own policy reaches `userId` and nobody else: every
   * grant that can read or use it names that user. The per-user credential
   * rules ask this where they used to ask for a personal scope.
   */
  static async reachesOnlyUser(params: {
    organizationId: string;
    resource: ScopedResource;
    scope: string;
    userId: string;
  }): Promise<boolean> {
    const policy = await ResourcePermissionPolicyModel.find(params);
    const reaching = (policy?.grants ?? []).filter(
      (grant) =>
        grant.actions.includes("read") || grant.actions.includes("use"),
    );
    return (
      reaching.length > 0 &&
      reaching.every(
        (grant) =>
          grant.subject.type === "user" && grant.subject.id === params.userId,
      )
    );
  }

  /** {@link findAudience} for several objects of one resource at once. */
  static async findAudiences(params: {
    organizationId: string;
    resource: ScopedResource;
    scopes: string[];
  }): Promise<Map<string, ObjectAudience>> {
    if (params.scopes.length === 0) return new Map();
    const table = schema.resourcePermissionPoliciesTable;
    const policies = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.resource, params.resource),
          inArray(table.scope, params.scopes),
        ),
      );
    const byScope = new Map(policies.map((policy) => [policy.scope, policy]));
    return new Map(
      params.scopes.map((scope) => [scope, audienceOf(byScope.get(scope))]),
    );
  }

  /**
   * Names of the teams, or of the people other than the owner, that an
   * object's own policy grants read to, sorted. Backs the recipient list next
   * to {@link sharedAudience}.
   */
  static sharedRecipientNames(params: {
    organizationId: string | SQLWrapper;
    resource: ScopedResource;
    scopeColumn: SQLWrapper;
    ownerColumn: SQLWrapper;
    subject: "team" | "user";
  }) {
    const [table, alias] =
      params.subject === "team"
        ? [sql`team`, sql`recipient_team`]
        : [sql`"user"`, sql`recipient_user`];
    return sql<string[]>`coalesce(array(
      SELECT ${alias}.name
      FROM resource_permission_policies recipient_policy,
        jsonb_array_elements(recipient_policy.grants) recipient_entry,
        ${table} ${alias}
      WHERE recipient_policy.organization_id = ${params.organizationId}
        AND recipient_policy.resource = ${params.resource}
        AND recipient_policy.scope = ${params.scopeColumn}::text
        AND (recipient_entry->'actions') ? 'read'
        AND recipient_entry->'subject'->>'type' = ${params.subject}
        AND recipient_entry->'subject'->>'id' = ${alias}.id
        AND recipient_entry->'subject'->>'id' IS DISTINCT FROM ${params.ownerColumn}::text
      ORDER BY ${alias}.name
    ), array[]::text[])`;
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
          legacyOrganizationAudience: policy.legacyOrganizationAudience,
        }
      : { resource: resource.data, scope, grants: [] };
  }
  static async find(params: PolicyKey) {
    const [policy] = await db
      .select()
      .from(schema.resourcePermissionPoliciesTable)
      .where(policyCondition(params));
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
    return db
      .select()
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.resource, params.resource),
          inArray(table.scope, [...params.scopes, "*"]),
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
          grants: asPresets(params.grants, params.resource),
          legacySharingMigrated:
            params.resource === "conversation" ||
            params.resource === "agentRun",
        })
        .onConflictDoNothing()
        .returning();
      return created ?? null;
    }
    const [updated] = await db
      .update(table)
      .set({
        grants: asPresets(params.grants, params.resource),
        ...(params.resource === "conversation" || params.resource === "agentRun"
          ? { legacySharingMigrated: true }
          : {}),
        // An explicit edit makes the selected recipients authoritative. A
        // role grant must no longer retain the old organization audience.
        legacyOrganizationAudience: false,
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
    // Presets nest, so the union of two is the larger one. Widening only
    // guards a grant stored before every grant had to be a preset.
    const actions = widenToPreset(
      [...new Set([...(existing?.actions ?? []), ...moved.actions])],
      params.resource,
    ).sort();
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

type ObjectAudience = {
  audience: "personal" | "team" | "org";
  teamIds: string[];
};

/** See {@link ResourcePermissionPolicyModel.findAudience}. */
function audienceOf(
  policy: { grants: ResourcePermissionGrant[] } | null | undefined,
): ObjectAudience {
  const readers = (policy?.grants ?? []).filter((grant) =>
    grant.actions.includes("read"),
  );
  const teamIds = readers
    .filter((grant) => grant.subject.type === "team")
    .map((grant) => grant.subject.id);
  const audience = readers.some(
    (grant) =>
      grant.subject.type === "organization" || grant.subject.type === "role",
  )
    ? "org"
    : teamIds.length > 0
      ? "team"
      : "personal";
  return { audience, teamIds };
}

type PolicyKey = {
  organizationId: string;
  resource: ScopedResource;
  scope: ResourcePermissionScope;
};

/**
 * Store each grant as one preset of its resource. A grant already equal to a
 * preset keeps its action order, so an unchanged policy stays byte-identical.
 */
function asPresets(
  grants: ResourcePermissionGrant[],
  resource: ScopedResource,
): ResourcePermissionGrant[] {
  return grants
    .map((grant) =>
      isResourcePermissionPreset(grant.actions, resource)
        ? grant
        : { ...grant, actions: widenToPreset(grant.actions, resource) },
    )
    .filter((grant) => grant.actions.length);
}

function policyCondition(params: PolicyKey) {
  const table = schema.resourcePermissionPoliciesTable;
  return and(
    eq(table.organizationId, params.organizationId),
    eq(table.resource, params.resource),
    eq(table.scope, params.scope),
  );
}

/**
 * The resources whose "work with it" path never consulted the read action, so
 * organization-wide visibility reached every member for `use` regardless of
 * role. The matching clause lives in the conversion SQL's audience CTE
 * (`services/resource-permissions-cutover.ts`); change both together, or a
 * resource created after the conversion behaves unlike one converted by it.
 */
const USE_UNGATED_BY_ROLE = new Set<ScopedResource>([
  "agent",
  "mcpGateway",
  "llmModel",
]);
