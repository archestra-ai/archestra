// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  canDelegateScopedPermissions,
  hasScopedPermission,
  isBuiltInCatalogId,
  type PermissionSubject,
  PredefinedRoleNameSchema,
  type ResourcePermissionAction,
  ResourcePermissionActionSchema,
  type ResourcePermissionGrant,
  type ResourcePermissionScope,
  roleDisplayNames,
  type ScopedPermission,
  type ScopedResource,
  TEAM_RESOURCE_SCOPE,
} from "@archestra/shared";
import {
  getPermissionsForUserContext,
  SERVICE_ACCOUNT_USER_ID_PREFIX,
} from "@/auth/utils";
import { enterpriseTier } from "@/enterprise-tier";
import MemberModel from "@/models/member";
import OrganizationRoleModel from "@/models/organization-role";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import ResourcePermissionSubjectModel from "@/models/resource-permission-subject";
import ResourcePermissionTargetModel from "@/models/resource-permission-target";
import RoleCompositionModel from "@/models/role-composition";
import ServiceAccountModel from "@/models/service-account";
import TeamModel from "@/models/team";
import type { ListInternalMcpCatalog } from "@/types";
import { ApiError } from "@/types";
import { resolveLegacyResourcePermissions } from "./resource-permission-compatibility";

export class ResourcePermissions {
  /** Old sharing fields cannot mutate an authoritative grant policy. */
  static async rejectLegacySharing(params: {
    organizationId: string;
    resource: ScopedResource;
    scope: string;
  }): Promise<void> {
    const policies = await ResourcePermissionPolicyModel.findApplicable(params);
    if (policies.some((policy) => policy.legacySharingMigrated)) {
      throw new ApiError(
        400,
        "Use the resource permissions API to change access; visibility and team/user sharing fields are retired.",
      );
    }
  }

  /** Assigning a role or team also delegates every scoped grant it carries. */
  static async validateSubjectAssignment(params: {
    organizationId: string;
    userId: string;
    subjects: PermissionSubject[];
  }): Promise<void> {
    const policies =
      await ResourcePermissionPolicyModel.findForSubjects(params);
    const keys = new Set(params.subjects.map(subjectKey));
    for (const policy of policies) {
      const requested = policy.grants
        .filter((grant) => keys.has(subjectKey(grant.subject)))
        .flatMap((grant) =>
          grant.actions.map((action) => ({
            organizationId: params.organizationId,
            resource: policy.resource,
            scope: policy.scope,
            action,
          })),
        );
      const { grants } = await ResourcePermissions.getEffective({
        ...params,
        resource: policy.resource,
        scope: policy.scope,
      });
      if (!canDelegateScopedPermissions({ grants, requested })) {
        throw new ApiError(
          403,
          "You cannot assign a role or team whose scoped permissions you cannot grant",
        );
      }
    }
  }

  /** Validate sharing before any resource or secret is written. */
  static async validateInitialGrants(params: {
    organizationId: string;
    userId: string;
    resource: ScopedResource;
    grants: ResourcePermissionGrant[];
    target: NonNullable<
      Awaited<ReturnType<typeof ResourcePermissionTargetModel.find>>
    >;
  }): Promise<void> {
    if (params.grants.length && !enterpriseTier.isCoreActive()) {
      throw new ApiError(
        403,
        "Resource permission grants require an active Enterprise entitlement or the small-team allowance.",
      );
    }
    // Creation assigns the creator full access to this new object. Sharing
    // those actions is therefore confined to authority the creator receives
    // in the same transaction; it grants no authority on existing objects.
    const permissions = await getPermissionsForUserContext(params);
    if (!permissions[params.resource]?.includes("create")) {
      throw new ApiError(
        403,
        "You do not have permission to create this resource",
      );
    }
    await ResourcePermissions.validateRecipients(params);
  }

  /** Load scoped capabilities once for a request that touches several targets. */
  static async resolveAll(params: {
    organizationId: string;
    userId: string;
  }): Promise<ScopedPermission[]> {
    const subjects = await ResourcePermissions.getSubjects(params);
    const policies = await ResourcePermissionPolicyModel.findForSubjects({
      ...params,
      subjects,
    });
    const keys = new Set(subjects.map(subjectKey));
    return expandScopedGrants({ policies, subjectKeys: keys });
  }

  /** Resolve a catalog page in batches; never query once per listed resource. */
  static async getCatalogActions(params: {
    organizationId: string;
    userId: string;
    targets: ListInternalMcpCatalog[];
  }): Promise<Map<string, ResourcePermissionAction[]>> {
    const result = new Map<string, ResourcePermissionAction[]>();
    const subjects = await ResourcePermissions.getSubjects(params);
    if (subjects.length === 0) return result;
    const subjectKeys = new Set(subjects.map(subjectKey));
    const [permissions, teamIds, policies] = await Promise.all([
      getPermissionsForUserContext(params),
      TeamModel.getUserTeamIds(params.userId),
      ResourcePermissionPolicyModel.findApplicableBatch({
        ...params,
        resource: "mcpRegistry",
        scopes: params.targets.map((target) => target.id),
      }),
    ]);
    const explicit = expandScopedGrants({ policies, subjectKeys });
    for (const target of params.targets) {
      if (
        isBuiltInCatalogId(target.id) ||
        (target.organizationId !== null &&
          target.organizationId !== params.organizationId)
      ) {
        result.set(
          target.id,
          target.organizationId === null &&
            permissions.mcpRegistry?.includes("read")
            ? ["read", "use"]
            : [],
        );
        continue;
      }
      const context = {
        ...params,
        resource: "mcpRegistry" as const,
        scope: target.id,
      };
      const legacy = policies.some(
        (policy) => policy.scope === target.id && policy.legacySharingMigrated,
      )
        ? []
        : resolveLegacyResourcePermissions({
            ...context,
            permissions,
            teamIds,
            target: { ...target, users: [] },
          });
      result.set(
        target.id,
        ResourcePermissionActionSchema.options.filter((action) =>
          hasScopedPermission({
            grants: [...legacy, ...explicit],
            required: { ...context, action },
          }),
        ),
      );
    }
    return result;
  }

  static async require(
    params: PermissionContext & { action: ResourcePermissionAction },
  ): Promise<void> {
    const effective = await ResourcePermissions.getEffective(params);
    if (!hasScopedPermission({ grants: effective.grants, required: params }))
      throw new ApiError(
        403,
        "You do not have permission to perform this action on this resource",
      );
  }

  static async searchInitialSubjects(params: {
    organizationId: string;
    userId: string;
    resource: ScopedResource;
    query: string;
  }) {
    const permissions = await getPermissionsForUserContext(params);
    if (!permissions[params.resource]?.includes("create"))
      throw new ApiError(
        403,
        "You do not have permission to create this resource",
      );
    return ResourcePermissions.findRecipients(params);
  }

  static async searchSubjects(params: PermissionContext & { query: string }) {
    const effective = await ResourcePermissions.getEffective(params);
    if (
      !hasScopedPermission({
        grants: effective.grants,
        required: { ...params, action: "manage-permissions" },
      })
    )
      throw new ApiError(
        403,
        "You do not have permission to manage access to this resource",
      );
    return ResourcePermissions.findRecipients(params);
  }

  static async getEffective(params: PermissionContext) {
    const target =
      params.scope === "*" || params.scope === TEAM_RESOURCE_SCOPE
        ? null
        : await ResourcePermissionTargetModel.find({
            ...params,
            id: params.scope,
          });
    if (params.scope !== "*" && params.scope !== TEAM_RESOURCE_SCOPE && !target)
      throw new ApiError(404, "Resource not found");
    if (
      params.resource === "app" &&
      target?.enabled === false &&
      target.authorId !== params.userId
    )
      return { target, grants: [] as ScopedPermission[] };
    // Legacy role resolution must not reintroduce access for a disabled service
    // account or a user whose organization membership has been removed.
    if ((await ResourcePermissions.getSubjects(params)).length === 0)
      return { target, grants: [] as ScopedPermission[] };
    const policy = await ResourcePermissionPolicyModel.find(params);
    const organizationPolicy = await ResourcePermissionPolicyModel.find({
      ...params,
      scope: "*",
    });
    if (
      policy?.legacySharingMigrated ||
      organizationPolicy?.legacySharingMigrated
    ) {
      return { target, grants: await ResourcePermissions.resolve(params) };
    }
    const [permissions, teamIds, explicit] = await Promise.all([
      getPermissionsForUserContext(params),
      TeamModel.getUserTeamIds(params.userId),
      ResourcePermissions.resolve(params),
    ]);
    const legacy = resolveLegacyResourcePermissions({
      ...params,
      permissions,
      teamIds,
      target,
    });
    return { target, grants: [...legacy, ...explicit] };
  }

  static async getPolicy(params: PermissionContext) {
    const effective = await ResourcePermissions.getEffective(params);
    if (
      !hasScopedPermission({
        grants: effective.grants,
        required: { ...params, action: "read" },
      }) &&
      !hasScopedPermission({
        grants: effective.grants,
        required: { ...params, action: "manage-permissions" },
      })
    )
      throw new ApiError(
        403,
        "You do not have permission to view this resource's permissions",
      );
    const policy = await ResourcePermissionPolicyModel.find(params);
    const applicable =
      await ResourcePermissionPolicyModel.findApplicable(params);
    const inherited = inheritedPolicyGrants({
      policies: applicable,
      scope: params.scope,
      directGrants: policy?.grants ?? [],
    });
    return {
      resource: params.resource,
      scope: params.scope,
      name:
        effective.target?.name ??
        (params.scope === TEAM_RESOURCE_SCOPE
          ? "Resources shared with your teams"
          : "All resources"),
      revision: policy?.revision ?? 0,
      grants: await ResourcePermissions.describeGrants({
        organizationId: params.organizationId,
        grants: policy?.grants ?? [],
      }),
      inheritedGrants: await ResourcePermissions.describeGrants({
        organizationId: params.organizationId,
        grants: inherited,
      }),
      legacyAccess: policy?.legacySharingMigrated
        ? []
        : await ResourcePermissions.describeLegacyAccess({
            ...params,
            target: effective.target,
          }),
      effectiveActions: effectiveActionsForPolicy({
        ...params,
        grants: effective.grants,
      }),
    };
  }

  static async updatePolicy(
    params: PermissionContext & {
      revision: number;
      grants: ResourcePermissionGrant[];
    },
  ) {
    const effective = await ResourcePermissions.getEffective(params);
    const policy = await ResourcePermissions.replace({
      ...params,
      authority: effective.grants,
    });
    const updated = await ResourcePermissions.getEffective(params);
    return {
      resource: params.resource,
      scope: params.scope,
      name:
        effective.target?.name ??
        (params.scope === TEAM_RESOURCE_SCOPE
          ? "Resources shared with your teams"
          : "All resources"),
      revision: policy.revision,
      grants: await ResourcePermissions.describeGrants({
        organizationId: params.organizationId,
        grants: policy.grants,
      }),
      inheritedGrants: await ResourcePermissions.describeGrants({
        organizationId: params.organizationId,
        grants: inheritedPolicyGrants({
          policies: await ResourcePermissionPolicyModel.findApplicable(params),
          scope: params.scope,
          directGrants: policy.grants,
        }),
      }),
      legacyAccess: policy?.legacySharingMigrated
        ? []
        : await ResourcePermissions.describeLegacyAccess({
            ...params,
            target: effective.target,
          }),
      effectiveActions: effectiveActionsForPolicy({
        ...params,
        grants: updated.grants,
      }),
    };
  }
  static async allows(
    params: PermissionContext & { action: ResourcePermissionAction },
  ): Promise<boolean> {
    const grants = await ResourcePermissions.resolve(params);
    return hasScopedPermission({ grants, required: params });
  }

  static async resolve(params: PermissionContext): Promise<ScopedPermission[]> {
    const subjects = await ResourcePermissions.getSubjects(params);
    if (subjects.length === 0) return [];
    const policies = await ResourcePermissionPolicyModel.findApplicable(params);
    const subjectKeys = new Set(subjects.map(subjectKey));
    return expandScopedGrants({ policies, subjectKeys }).filter(
      (grant) => grant.scope === "*" || grant.scope === params.scope,
    );
  }

  static async validateRecipients(params: {
    organizationId: string;
    grants: ResourcePermissionGrant[];
  }): Promise<void> {
    const subjects = params.grants.map((grant) => grant.subject);
    if (new Set(subjects.map(subjectKey)).size !== subjects.length)
      throw new ApiError(400, "Each recipient can have only one direct grant");
    const existing = await ResourcePermissionSubjectModel.findExisting({
      ...params,
      subjects,
    });
    const keys = new Set(existing.map(subjectKey));
    for (const subject of subjects) {
      if (
        subject.type === "organization" ||
        (subject.type === "role" &&
          PredefinedRoleNameSchema.safeParse(subject.id).success)
      )
        continue;
      if (!keys.has(subjectKey(subject)))
        throw new ApiError(
          400,
          "A permission recipient does not exist in this organization or is disabled",
        );
    }
  }

  /** The caller's complete effective grants must include inherited authority. */
  static async replace(
    params: PermissionContext & {
      revision: number;
      grants: ResourcePermissionGrant[];
      authority: readonly ScopedPermission[];
    },
  ) {
    const current = await ResourcePermissionPolicyModel.find(params);
    const requested = params.grants.flatMap((grant) =>
      grant.actions.map((action) => ({
        organizationId: params.organizationId,
        resource: params.resource,
        scope: params.scope,
        action,
      })),
    );
    // Adding a resource to a team's reach can activate that team's members'
    // existing relative grants. Authorize those actions as part of sharing.
    const addsTeam = params.grants.some(
      (grant) =>
        grant.subject.type === "team" &&
        !current?.grants.some(
          (existing) =>
            subjectKey(existing.subject) === subjectKey(grant.subject),
        ),
    );
    if (
      addsTeam &&
      params.scope !== "*" &&
      params.scope !== TEAM_RESOURCE_SCOPE
    ) {
      const teamPolicy = await ResourcePermissionPolicyModel.find({
        ...params,
        scope: TEAM_RESOURCE_SCOPE,
      });
      for (const action of new Set(
        teamPolicy?.grants.flatMap((grant) => grant.actions) ?? [],
      )) {
        requested.push({
          organizationId: params.organizationId,
          resource: params.resource,
          scope: params.scope,
          action,
        });
      }
    }
    if (
      !hasScopedPermission({
        grants: params.authority,
        required: {
          ...params,
          scope: params.scope === TEAM_RESOURCE_SCOPE ? "*" : params.scope,
          action: "manage-permissions",
        },
      }) ||
      !canDelegateScopedPermissions({ grants: params.authority, requested })
    ) {
      throw new ApiError(
        403,
        "You can only grant permissions you hold on this resource",
      );
    }
    if (!enterpriseTier.isCoreActive()) {
      const expandsAccess = params.grants.some((grant) =>
        grant.actions.some(
          (action) =>
            !current?.grants.some(
              (existing) =>
                subjectKey(existing.subject) === subjectKey(grant.subject) &&
                existing.actions.includes(action),
            ),
        ),
      );
      if (expandsAccess)
        throw new ApiError(
          403,
          "Resource permission grants require an active Enterprise entitlement or the small-team allowance.",
        );
    }
    await ResourcePermissions.validateRecipients(params);
    const policy = await ResourcePermissionPolicyModel.replace(params);
    if (!policy)
      throw new ApiError(
        409,
        "Permissions changed since you opened this editor. Reload before saving.",
      );
    return policy;
  }

  private static async findRecipients(params: {
    organizationId: string;
    query: string;
  }) {
    const recipients = await ResourcePermissionSubjectModel.search(params);
    const defaults: { subject: PermissionSubject; name: string }[] = [
      {
        subject: { type: "organization" as const, id: "*" as const },
        name: "Everyone in the organization",
      },
      ...PredefinedRoleNameSchema.options.map((id) => ({
        subject: { type: "role" as const, id },
        name: roleDisplayNames[id],
      })),
    ];
    return defaults
      .filter((recipient) =>
        recipient.name.toLowerCase().includes(params.query.toLowerCase()),
      )
      .concat(recipients);
  }
  private static async describeLegacyAccess(
    params: PermissionContext & {
      target: Awaited<ReturnType<typeof ResourcePermissionTargetModel.find>>;
    },
  ) {
    const inputs = await ResourcePermissionSubjectModel.getLegacyAccessInputs(
      params.organizationId,
    );
    const teamsById = new Map(inputs.teams.map((team) => [team.id, team]));
    const membershipsByUser = new Map<string, typeof inputs.memberships>();
    for (const membership of inputs.memberships) {
      const existing = membershipsByUser.get(membership.userId) ?? [];
      existing.push(membership);
      membershipsByUser.set(membership.userId, existing);
    }
    const actors = [
      ...inputs.members.map((member) => ({
        ...member,
        subject: { type: "user" as const, id: member.id },
        userId: member.id,
      })),
      ...inputs.accounts.map((account) => ({
        ...account,
        subject: { type: "serviceAccount" as const, id: account.id },
        userId: `${SERVICE_ACCOUNT_USER_ID_PREFIX}${account.id}`,
      })),
    ].map((actor) => {
      const memberships = membershipsByUser.get(actor.userId) ?? [];
      const teamIds = new Set<string>();
      for (const membership of memberships) {
        let id: string | null = membership.teamId;
        while (id && !teamIds.has(id)) {
          teamIds.add(id);
          id = teamsById.get(id)?.parentId ?? null;
        }
      }
      return {
        ...actor,
        teamIds: [...teamIds],
        roles: [
          ...new Set([
            ...actor.role
              .split(",")
              .map((role) => role.trim())
              .filter(Boolean),
            ...[...teamIds].flatMap((id) => teamsById.get(id)?.roles ?? []),
          ]),
        ],
      };
    });
    const permissions = await OrganizationRoleModel.getPermissionsBatch({
      organizationId: params.organizationId,
      identifiers: actors.flatMap((actor) => actor.roles),
    });
    return actors
      .flatMap((actor) => {
        const grants = resolveLegacyResourcePermissions({
          ...params,
          userId: actor.userId,
          teamIds: actor.teamIds,
          permissions: RoleCompositionModel.mergePermissions(
            actor.roles.map((role) => permissions[role] ?? {}),
          ),
        });
        return grants.length
          ? [
              {
                subject: actor.subject,
                name: actor.name,
                actions: ResourcePermissionActionSchema.options.filter(
                  (action) => grants.some((grant) => grant.action === action),
                ),
              },
            ]
          : [];
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private static async describeGrants(params: {
    organizationId: string;
    grants: (ResourcePermissionGrant & {
      sourceScope?: ResourcePermissionScope;
    })[];
  }) {
    const recipients = await ResourcePermissionSubjectModel.findExisting({
      organizationId: params.organizationId,
      subjects: params.grants.map((grant) => grant.subject),
    });
    const names = new Map(
      recipients.map((recipient) => [subjectKey(recipient), recipient.name]),
    );
    return params.grants.map((grant) => {
      const role =
        grant.subject.type === "role"
          ? PredefinedRoleNameSchema.safeParse(grant.subject.id)
          : null;
      const name =
        grant.subject.type === "organization"
          ? "Everyone in the organization"
          : role?.success
            ? roleDisplayNames[role.data]
            : (names.get(subjectKey(grant.subject)) ?? "Unavailable recipient");
      return { ...grant, name };
    });
  }

  private static async getSubjects(params: {
    userId: string;
    organizationId: string;
  }): Promise<PermissionSubject[]> {
    const subjects: PermissionSubject[] = [{ type: "organization", id: "*" }];
    let identifiers: string[];
    if (params.userId.startsWith(SERVICE_ACCOUNT_USER_ID_PREFIX)) {
      const id = params.userId.slice(SERVICE_ACCOUNT_USER_ID_PREFIX.length);
      const account = await ServiceAccountModel.findById(
        id,
        params.organizationId,
      );
      if (!account || account.disabled) return [];
      subjects.push({ type: "serviceAccount", id });
      identifiers = account.role.split(",");
    } else {
      const member = await MemberModel.getByUserId(
        params.userId,
        params.organizationId,
      );
      if (!member) return [];
      const [teamIds, sources] = await Promise.all([
        TeamModel.getUserTeamIds(params.userId),
        RoleCompositionModel.getUserSources(params),
      ]);
      subjects.push(
        { type: "user", id: params.userId },
        ...teamIds.map((id) => ({ type: "team" as const, id })),
      );
      identifiers = sources.map((source) => source.role);
    }
    const roles = await ResourcePermissionSubjectModel.getRoleIds({
      organizationId: params.organizationId,
      identifiers,
    });
    subjects.push(
      ...roles.map(({ id }) => ({ type: "role" as const, id })),
      ...identifiers
        .filter((id) => PredefinedRoleNameSchema.safeParse(id).success)
        .map((id) => ({ type: "role" as const, id })),
    );
    return subjects;
  }
}

type PermissionContext = {
  userId: string;
  organizationId: string;
  resource: ScopedResource;
  scope: ResourcePermissionScope;
};

function subjectKey(subject: PermissionSubject): string {
  return JSON.stringify([subject.type, subject.id]);
}

/** Expand a relative team selector only onto objects actually shared with a current team. */
function expandScopedGrants(params: {
  policies: Awaited<
    ReturnType<typeof ResourcePermissionPolicyModel.findForSubjects>
  >;
  subjectKeys: Set<string>;
}): ScopedPermission[] {
  const teamScopes = new Map<ScopedResource, Set<string>>();
  for (const policy of params.policies) {
    if (policy.scope === "*" || policy.scope === TEAM_RESOURCE_SCOPE) continue;
    if (
      policy.grants.some(
        (grant) =>
          grant.subject.type === "team" &&
          params.subjectKeys.has(subjectKey(grant.subject)),
      )
    ) {
      const scopes = teamScopes.get(policy.resource) ?? new Set<string>();
      scopes.add(policy.scope);
      teamScopes.set(policy.resource, scopes);
    }
  }
  return params.policies.flatMap((policy) =>
    policy.grants.flatMap((grant) => {
      if (!params.subjectKeys.has(subjectKey(grant.subject))) return [];
      const scopes =
        policy.scope === TEAM_RESOURCE_SCOPE
          ? [TEAM_RESOURCE_SCOPE, ...(teamScopes.get(policy.resource) ?? [])]
          : [policy.scope];
      return scopes.flatMap((scope) =>
        grant.actions.map((action) => ({
          organizationId: policy.organizationId,
          resource: policy.resource,
          scope,
          action,
        })),
      );
    }),
  );
}

function inheritedPolicyGrants(params: {
  policies: Awaited<
    ReturnType<typeof ResourcePermissionPolicyModel.findApplicable>
  >;
  scope: string;
  directGrants: ResourcePermissionGrant[];
}) {
  const sharedWithTeams =
    params.scope !== "*" &&
    params.scope !== TEAM_RESOURCE_SCOPE &&
    params.directGrants.some((grant) => grant.subject.type === "team");
  return params.policies
    .filter(
      (policy) =>
        policy.scope !== params.scope &&
        (policy.scope !== TEAM_RESOURCE_SCOPE || sharedWithTeams),
    )
    .flatMap((policy) =>
      policy.grants.map((grant) => ({ ...grant, sourceScope: policy.scope })),
    );
}

function effectiveActionsForPolicy(
  params: PermissionContext & { grants: ScopedPermission[] },
) {
  return ResourcePermissionActionSchema.options.filter((action) =>
    hasScopedPermission({
      grants: params.grants,
      required: {
        ...params,
        action,
        scope:
          action === "manage-permissions" &&
          params.scope === TEAM_RESOURCE_SCOPE
            ? "*"
            : params.scope,
      },
    }),
  );
}
