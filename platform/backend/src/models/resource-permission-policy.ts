// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  grantsAudience,
  isResourcePermissionPreset,
  ManagedResourceSchema,
  type PermissionSubject,
  RESOURCE_ACCESS_RELATIONS,
  type ResourceAccessRelation,
  type ResourcePermissionAction,
  type ResourcePermissionGrant,
  type ResourcePermissionScope,
  resourcePermissionPresets,
  type ScopedResource,
  topResourcePermissionPreset,
  widenToPreset,
} from "@archestra/shared";
import {
  predefinedRolesWithReadAccess,
  roleActionResourceFor,
} from "@archestra/shared/access-control";
import {
  and,
  eq,
  inArray,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import type { GrantPrincipal } from "./resource-permission-subject";
import RoleCompositionModel from "./role-composition";

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
        ...ManagedResourceSchema.options
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
              ...["admin", "platform_admin"].map((id) => ({
                subject: { type: "role" as const, id },
                // Each resource's widest preset: OAuth registrations offer
                // every action except `use`, and only the MCP registry adds
                // deployment-spec configuration above Full access.
                actions: [...topResourcePermissionPreset(resource).actions],
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
              sql`coalesce(${schema.organizationRolesTable.permission}::jsonb -> ${roleActionResourceFor(params.resource)}, '[]'::jsonb) ? 'read'`,
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

  /**
   * SQL counterpart of the resolver, applied before list pagination/counts.
   * The caller's subjects are resolved up front, so the predicate is a
   * primary-key probe plus a JSONB containment test per row.
   */
  static grantCondition(params: {
    organizationId: string;
    subjects: PermissionSubject[];
    resource: ScopedResource;
    scopeColumn: SQLWrapper;
    action: ResourcePermissionAction;
    includeWildcard?: boolean;
  }): SQL<boolean> {
    if (params.subjects.length === 0) return sql<boolean>`false`;
    const candidates = params.subjects.map(
      (subject) =>
        sql`${JSON.stringify([{ subject, actions: [params.action] }])}`,
    );
    return sql<boolean>`EXISTS (
      SELECT 1 FROM resource_permission_policies grant_policy
      WHERE grant_policy.organization_id = ${params.organizationId}
        AND grant_policy.resource = ${params.resource}
        AND ((${params.includeWildcard !== false} AND grant_policy.scope = '*') OR grant_policy.scope = ${params.scopeColumn}::text)
        AND grant_policy.grants @> ANY(ARRAY[${sql.join(candidates, sql`, `)}]::jsonb[])
    )`;
  }

  /**
   * {@link grantCondition} for a query that is not fenced to one
   * organization: each row is checked against the caller's subjects in the
   * row's own organization.
   */
  static grantConditionForAny(params: {
    principals: GrantPrincipal[];
    organizationColumn: SQLWrapper;
    resource: ScopedResource;
    scopeColumn: SQLWrapper;
    action: ResourcePermissionAction;
  }): SQL<boolean> {
    const { principals, organizationColumn, resource, scopeColumn, action } =
      params;
    if (principals.length === 0) return sql<boolean>`false`;
    return sql<boolean>`(${sql.join(
      principals.map(
        (principal) =>
          sql`(${organizationColumn} = ${principal.organizationId} AND ${ResourcePermissionPolicyModel.grantCondition({ ...principal, resource, scopeColumn, action })})`,
      ),
      sql` OR `,
    )})`;
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
    return ResourcePermissionPolicyModel.grantsReadToAnySubject({
      ...params,
      subjects: params.teamIds.map((id) => ({ type: "team" as const, id })),
    });
  }

  /**
   * Whether an object's own policy grants read to any of `subjects`, matched
   * literally by type and id: a role grant matches only that role, and the
   * organization subject only a grant to everyone. Inherited `*` grants are
   * not the object's sharing, so they are left out.
   */
  static grantsReadToAnySubject(params: {
    organizationId: string | SQLWrapper;
    resource: ScopedResource;
    scopeColumn: SQLWrapper;
    subjects: PermissionSubject[];
  }) {
    const idsByType = new Map<PermissionSubject["type"], string[]>();
    for (const subject of params.subjects) {
      idsByType.set(subject.type, [
        ...(idsByType.get(subject.type) ?? []),
        subject.id,
      ]);
    }
    if (idsByType.size === 0) return sql<boolean>`false`;
    const matches = [...idsByType].map(
      ([type, ids]) =>
        sql`(subject_entry->'subject'->>'type' = ${type} AND ${inArray(sql`subject_entry->'subject'->>'id'`, ids)})`,
    );
    return sql<boolean>`EXISTS (
      SELECT 1 FROM resource_permission_policies subject_policy,
        jsonb_array_elements(subject_policy.grants) subject_entry
      WHERE subject_policy.organization_id = ${params.organizationId}
        AND subject_policy.resource = ${params.resource}
        AND subject_policy.scope = ${params.scopeColumn}::text
        AND (subject_entry->'actions') ? 'read'
        AND (${sql.join(matches, sql` OR `)})
    )`;
  }

  /**
   * The predicate behind every list's "Show" filter and its "Shared with" and
   * "Owner" narrowing, each optional and ANDed together:
   *
   * - `relations`: the object is in any of them for the caller. Selecting
   *   every relation filters nothing.
   * - `ownerIds`: the object's owner is one of them.
   * - `sharedWith`: the object's own policy grants read to one of them, see
   *   {@link grantsReadToAnySubject}.
   *
   * Undefined when nothing filters.
   *
   * Only the object's OWN policy counts. A grant at `*` reaches every object
   * of the type, so counting it would put every row in `shared` or `org` for
   * an administrator, and the filter could never hide other people's
   * personal objects. Role grants count as `org`, the same reading as
   * {@link sharedAudience}. A grant to the author's own user is `mine`, not
   * `shared`.
   */
  static accessRelationCondition(params: {
    organizationId: string | SQLWrapper;
    resource: ScopedResource;
    scopeColumn: SQLWrapper;
    ownerColumn: SQLWrapper;
    userId: string;
    /** The caller's subjects, e.g. from `resolvePrincipal(s)`. */
    subjects: PermissionSubject[];
    relations?: ResourceAccessRelation[];
    sharedWith?: PermissionSubject[];
    ownerIds?: string[];
  }): SQL<boolean> | undefined {
    const conditions: SQL<boolean>[] = [];
    const relations = relationCondition(params);
    if (relations) conditions.push(relations);
    if (params.ownerIds?.length)
      conditions.push(
        sql<boolean>`coalesce(${inArray(sql`${params.ownerColumn}::text`, params.ownerIds)}, false)`,
      );
    if (params.sharedWith?.length)
      conditions.push(
        ResourcePermissionPolicyModel.grantsReadToAnySubject({
          ...params,
          subjects: params.sharedWith,
        }),
      );
    if (conditions.length === 0) return undefined;
    return sql<boolean>`(${sql.join(conditions, sql` AND `)})`;
  }

  /**
   * The audience and granted teams of one object, from its own policy, in
   * the terms of {@link audienceIs}. For callers that decide in code rather
   * than in a query.
   */
  /** The audience a policy with these grants would have. */
  static audienceOfGrants(grants: ResourcePermissionGrant[]): ObjectAudience {
    return audienceOf({ grants });
  }

  static async findAudience(params: {
    organizationId: string;
    resource: ScopedResource;
    scope: string;
  }): Promise<ObjectAudience> {
    return audienceOf(await ResourcePermissionPolicyModel.find(params));
  }

  /**
   * Whether an object's own policy reaches nobody but its owner: no grant that
   * can read or use it names anyone else (a team, a role, the organization,
   * another person or a service account). An object with no policy reaches
   * nobody. The SQL form of "author-only", which readers of the retired
   * personal scope ask instead.
   */
  static reachesOnlyOwner(params: {
    organizationId: string | SQLWrapper;
    resource: ScopedResource;
    scopeColumn: SQLWrapper;
    ownerColumn: SQLWrapper;
  }) {
    return sql<boolean>`NOT EXISTS (
      SELECT 1 FROM resource_permission_policies owner_policy,
        jsonb_array_elements(owner_policy.grants) owner_entry
      WHERE owner_policy.organization_id = ${params.organizationId}
        AND owner_policy.resource = ${params.resource}
        AND owner_policy.scope = ${params.scopeColumn}::text
        AND ((owner_entry->'actions') ? 'read' OR (owner_entry->'actions') ? 'use')
        AND NOT (owner_entry->'subject'->>'type' = 'user'
          AND owner_entry->'subject'->>'id' IS NOT DISTINCT FROM ${params.ownerColumn}::text)
    )`;
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
   * The teams and people each object's own policy grants read to, keyed by
   * scope. Replaces reading the retired team and user assignment rows. Object
   * ids are unique across resources, so an agent lookup may pass both the
   * `agent` and `mcpGateway` resources and let each id find its own policy.
   */
  static async findReadRecipients(params: {
    resources: ScopedResource[];
    scopes: string[];
  }): Promise<Map<string, ReadRecipients>> {
    const recipients = new Map<string, ReadRecipients>(
      params.scopes.map((scope) => [
        scope,
        { teamIds: [], userIds: [], teamActions: {} },
      ]),
    );
    if (params.scopes.length === 0 || params.resources.length === 0)
      return recipients;
    const table = schema.resourcePermissionPoliciesTable;
    const policies = await db
      .select({ scope: table.scope, grants: table.grants })
      .from(table)
      .where(
        and(
          inArray(table.resource, params.resources),
          inArray(table.scope, params.scopes),
        ),
      );
    for (const policy of policies) {
      const entry = recipients.get(policy.scope);
      if (!entry) continue;
      for (const grant of policy.grants) {
        if (!grant.actions.includes("read")) continue;
        if (grant.subject.type === "team") {
          if (!entry.teamActions[grant.subject.id])
            entry.teamIds.push(grant.subject.id);
          entry.teamActions[grant.subject.id] = [
            ...new Set([
              ...(entry.teamActions[grant.subject.id] ?? []),
              ...grant.actions,
            ]),
          ];
        }
        if (
          grant.subject.type === "user" &&
          !entry.userIds.includes(grant.subject.id)
        )
          entry.userIds.push(grant.subject.id);
      }
    }
    return recipients;
  }

  /**
   * {@link findReadRecipients} with each team's name and each person's name
   * and email, for the "shared with" lists in API responses. People in
   * `excludeUserIds` (an object's author, keyed by scope) are left out: a
   * creator's own grant is not a share.
   */
  static async findReadRecipientDetails(params: {
    resources: ScopedResource[];
    scopes: string[];
    excludeUserIds?: Map<string, string | null>;
  }): Promise<Map<string, ReadRecipientDetails>> {
    const recipients =
      await ResourcePermissionPolicyModel.findReadRecipients(params);
    const teamIds = [
      ...new Set([...recipients.values()].flatMap((entry) => entry.teamIds)),
    ];
    const userIds = [
      ...new Set([...recipients.values()].flatMap((entry) => entry.userIds)),
    ];
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
            .select({
              id: schema.usersTable.id,
              name: schema.usersTable.name,
              email: schema.usersTable.email,
            })
            .from(schema.usersTable)
            .where(inArray(schema.usersTable.id, userIds)),
    ]);
    const teamById = new Map(teams.map((team) => [team.id, team]));
    const userById = new Map(users.map((user) => [user.id, user]));
    return new Map(
      [...recipients].map(([scope, entry]) => {
        const excluded = params.excludeUserIds?.get(scope);
        return [
          scope,
          {
            teams: entry.teamIds.flatMap((id) => {
              const team = teamById.get(id);
              return team
                ? [{ ...team, actions: entry.teamActions[id] ?? [] }]
                : [];
            }),
            users: entry.userIds.flatMap((id) => {
              const user = id === excluded ? undefined : userById.get(id);
              return user ? [user] : [];
            }),
          },
        ];
      }),
    );
  }

  /**
   * Scopes of `resources` whose own policy grants read to `teamId`. Replaces
   * listing the retired team assignment rows by team.
   */
  static async findScopesReadByTeam(params: {
    organizationId: string;
    resources: ScopedResource[];
    teamId: string;
  }): Promise<string[]> {
    const table = schema.resourcePermissionPoliciesTable;
    const rows = await db
      .select({ scope: table.scope })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          inArray(table.resource, params.resources),
          sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements(${table.grants}) team_entry
            WHERE (team_entry->'actions') ? 'read'
              AND team_entry->'subject'->>'type' = 'team'
              AND team_entry->'subject'->>'id' = ${params.teamId}
          )`,
        ),
      );
    return rows.map((row) => row.scope).filter((scope) => scope !== "*");
  }

  /**
   * Whether the object in `scopeColumn` has a policy that grants read to the
   * team in `teamColumn`. The join condition that replaces joining through a
   * retired team assignment table.
   */
  static grantsReadToTeamColumn(params: {
    organizationId: SQLWrapper;
    resource: ScopedResource | SQLWrapper;
    scopeColumn: SQLWrapper;
    teamColumn: SQLWrapper;
  }) {
    return sql<boolean>`EXISTS (
      SELECT 1 FROM resource_permission_policies team_policy,
        jsonb_array_elements(team_policy.grants) team_entry
      WHERE team_policy.organization_id = ${params.organizationId}
        AND team_policy.resource = ${params.resource}
        AND team_policy.scope = ${params.scopeColumn}::text
        AND (team_entry->'actions') ? 'read'
        AND team_entry->'subject'->>'type' = 'team'
        AND team_entry->'subject'->>'id' = ${params.teamColumn}::text
    )`;
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
    const resource = ManagedResourceSchema.safeParse(routeParams?.resource);
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
          // Bind the scopes as one array so large lists cannot exhaust the
          // PostgreSQL protocol's parameter limit.
          sql`${table.scope} = ANY(${sql.param([...params.scopes, "*"])}::text[])`,
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

type ReadRecipients = {
  teamIds: string[];
  userIds: string[];
  /** Every action granted to each team in `teamIds`. */
  teamActions: Record<string, ResourcePermissionAction[]>;
};

type ReadRecipientDetails = {
  teams: { id: string; name: string; actions: ResourcePermissionAction[] }[];
  users: { id: string; name: string; email: string }[];
};

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
  return { audience: grantsAudience(readers), teamIds };
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
  // Deploying into an environment never asked for an environment role action,
  // only for the right to create the thing deployed.
  "environment",
]);

/**
 * Whether an object's own policy grants read to one of the caller's teams, or
 * to the caller by name when the caller is not its author.
 */
/**
 * The `relations` part of
 * {@link ResourcePermissionPolicyModel.accessRelationCondition}. Undefined
 * when no relation is selected or every one is, because then nothing is
 * filtered.
 */
function relationCondition(params: {
  organizationId: string | SQLWrapper;
  resource: ScopedResource;
  scopeColumn: SQLWrapper;
  ownerColumn: SQLWrapper;
  userId: string;
  subjects: PermissionSubject[];
  relations?: ResourceAccessRelation[];
}): SQL<boolean> | undefined {
  const selected = new Set(params.relations ?? RESOURCE_ACCESS_RELATIONS);
  if (
    selected.size === 0 ||
    RESOURCE_ACCESS_RELATIONS.every((relation) => selected.has(relation))
  )
    return undefined;

  const mine = sql<boolean>`coalesce(${params.ownerColumn}::text = ${params.userId}, false)`;
  const shared = sharedWithCallerCondition(params);
  const org = ResourcePermissionPolicyModel.audienceIs({
    ...params,
    audience: "org",
  });
  const byRelation: Record<ResourceAccessRelation, SQL<boolean>> = {
    mine,
    shared,
    org,
    others: sql<boolean>`NOT (${mine} OR ${shared} OR ${org})`,
  };
  const kept = [...selected].map((relation) => byRelation[relation]);
  return sql<boolean>`(${sql.join(kept, sql` OR `)})`;
}

function sharedWithCallerCondition(params: {
  organizationId: string | SQLWrapper;
  resource: ScopedResource;
  scopeColumn: SQLWrapper;
  ownerColumn: SQLWrapper;
  subjects: PermissionSubject[];
}): SQL<boolean> {
  const teamIds = params.subjects
    .filter((subject) => subject.type === "team")
    .map((subject) => subject.id);
  const selfIds = params.subjects
    .filter(
      (subject) => subject.type === "user" || subject.type === "serviceAccount",
    )
    .map((subject) => subject.id);
  const reaches: SQL[] = [];
  if (teamIds.length > 0)
    reaches.push(
      sql`(shared_entry->'subject'->>'type' = 'team' AND ${inArray(sql`shared_entry->'subject'->>'id'`, teamIds)})`,
    );
  if (selfIds.length > 0)
    reaches.push(
      sql`(shared_entry->'subject'->>'type' IN ('user', 'serviceAccount') AND ${inArray(sql`shared_entry->'subject'->>'id'`, selfIds)} AND shared_entry->'subject'->>'id' IS DISTINCT FROM ${params.ownerColumn}::text)`,
    );
  if (reaches.length === 0) return sql<boolean>`false`;
  return sql<boolean>`EXISTS (
    SELECT 1 FROM resource_permission_policies shared_policy,
      jsonb_array_elements(shared_policy.grants) shared_entry
    WHERE shared_policy.organization_id = ${params.organizationId}
      AND shared_policy.resource = ${params.resource}
      AND shared_policy.scope = ${params.scopeColumn}::text
      AND (shared_entry->'actions') ? 'read'
      AND (${sql.join(reaches, sql` OR `)})
  )`;
}
