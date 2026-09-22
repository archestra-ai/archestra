// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  canDelegateScopedPermissions,
  hasScopedPermission,
  isBuiltInCatalogId,
  isResourcePermissionPreset,
  ORGANIZATION_WIDE_RESOURCES,
  type PermissionSubject,
  PredefinedRoleNameSchema,
  type ResourcePermissionAction,
  ResourcePermissionActionSchema,
  type ResourcePermissionGrant,
  type ResourcePermissionScope,
  ResourcePermissionScopeSchema,
  roleDisplayNames,
  type ScopedPermission,
  type ScopedResource,
} from "@archestra/shared";
import { roleActionResourceFor } from "@archestra/shared/access-control";
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
import { CredentialResourcePermissions } from "./credential-resource-permissions";
import { resolveLegacyResourcePermissions } from "./resource-permission-compatibility";

export class ResourcePermissions {
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
        "Granular access control requires an active Enterprise entitlement or the small-team allowance.",
      );
    }
    // Creation assigns the creator full access to this new object. Sharing
    // those actions is therefore confined to authority the creator receives
    // in the same transaction; it grants no authority on existing objects.
    const permissions = await getPermissionsForUserContext(params);
    if (
      !permissions[roleActionResourceFor(params.resource)]?.includes("create")
    ) {
      throw new ApiError(
        403,
        "You do not have permission to create this resource",
      );
    }
    await ResourcePermissions.validateRecipients(params);
  }

  /**
   * The grants a request-driven creation starts with.
   *
   * Publishing to the whole organization is a delegation act, and
   * {@link canDelegateScopedPermissions} has to bound it. The audience
   * `ResourcePermissionPolicyModel.createInitial` derives from the retired
   * `scope` field skips that check, so a caller holding no authority to grant
   * anything could publish a new resource organization-wide simply by posting
   * the field. Explicit grants were validated, implicit ones were not, and that
   * asymmetry is the hole: a route or tool asking for organization visibility
   * starts the resource with the creator alone.
   *
   * Only that audience is suppressed. Team and named-user sharing reach
   * recipients the create paths already validate, and creation is the one path
   * that still honours those fields, so they keep deriving — passing a blanket
   * empty list instead would silently drop named sharing for every client that
   * is not the UI.
   */
  static grantsForCreation(params: {
    grants?: ResourcePermissionGrant[];
    visibility?: string | null;
  }): ResourcePermissionGrant[] | undefined {
    if (params.grants !== undefined) return params.grants;
    return params.visibility === "org" ? [] : undefined;
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

  /**
   * Ownership transfer re-homes the creator's grant. The caller must be able
   * to change who can manage the object, and the recipient must be a member
   * who will then hold the transferred grant; no legacy scope rules apply.
   */
  static async authorizeOwnershipTransfer(params: {
    organizationId: string;
    userId: string;
    resource: ScopedResource;
    scope: string;
    ownerId: string;
  }): Promise<void> {
    const effective = await ResourcePermissions.getEffective(params);
    for (const action of ["update", "manage-permissions"] as const) {
      if (
        !hasScopedPermission({
          grants: effective.grants,
          required: { ...params, action },
        })
      )
        throw new ApiError(
          403,
          "You do not have permission to transfer this resource",
        );
    }
    if (
      params.ownerId.startsWith(SERVICE_ACCOUNT_USER_ID_PREFIX) ||
      !(await MemberModel.getByUserId(params.ownerId, params.organizationId))
    )
      throw new ApiError(
        400,
        "The new owner must be a user in this organization",
      );
  }

  /** Move the previous owner's direct grant to the new owner after the row changed hands. */
  static async transferOwnerGrant(params: {
    organizationId: string;
    resource: ScopedResource;
    scope: string;
    previousOwnerId: string | null;
    ownerId: string;
  }): Promise<void> {
    if (!params.previousOwnerId) return;
    await ResourcePermissionPolicyModel.transferSubjectGrant({
      organizationId: params.organizationId,
      resource: params.resource,
      scope: params.scope,
      from: subjectForUserId(params.previousOwnerId),
      to: { type: "user", id: params.ownerId },
    });
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
    if (
      !permissions[roleActionResourceFor(params.resource)]?.includes("create")
    )
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
    if (!ResourcePermissionScopeSchema.safeParse(params.scope).success)
      throw new ApiError(400, "Invalid permission scope");
    if (
      params.scope !== "*" &&
      ORGANIZATION_WIDE_RESOURCES.has(params.resource)
    )
      throw new ApiError(
        400,
        "This resource only supports organization-wide permissions",
      );
    const target =
      params.scope === "*"
        ? null
        : await ResourcePermissionTargetModel.find({
            ...params,
            id: params.scope,
          });
    if (params.scope !== "*" && !target)
      throw new ApiError(404, "Resource not found");
    if (
      (params.resource === "app" || params.resource === "conversation") &&
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
    });
    return {
      resource: params.resource,
      scope: params.scope,
      name: effective.target?.name ?? "All resources",
      revision: policy?.revision ?? 0,
      grants: await ResourcePermissions.describeGrants({
        organizationId: params.organizationId,
        grants:
          policy?.grants ??
          (params.resource === "conversation" || params.resource === "agentRun"
            ? sessionLegacyGrants(effective.target)
            : []),
      }),
      inheritedGrants: await ResourcePermissions.describeGrants({
        organizationId: params.organizationId,
        grants: inherited,
      }),
      legacyAccess:
        policy?.legacySharingMigrated ||
        params.resource === "conversation" ||
        params.resource === "agentRun"
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
    if (params.resource === "conversation" || params.resource === "agentRun") {
      if (
        params.grants.some((grant) =>
          grant.actions.some(
            (action) => action !== "read" && action !== "manage-permissions",
          ),
        )
      )
        throw new ApiError(
          400,
          "Sessions support viewing and managing access only",
        );
      const target = await ResourcePermissionTargetModel.find({
        ...params,
        id: params.scope,
      });
      if (target?.enabled === false)
        throw new ApiError(400, "Locked chats cannot be shared");
    }
    const effective = await ResourcePermissions.getEffective(params);
    const policy = await ResourcePermissions.replace({
      ...params,
      authority: effective.grants,
    });
    const updated = await ResourcePermissions.getEffective(params);
    return {
      resource: params.resource,
      scope: params.scope,
      name: effective.target?.name ?? "All resources",
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
        }),
      }),
      legacyAccess:
        policy?.legacySharingMigrated ||
        params.resource === "conversation" ||
        params.resource === "agentRun"
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
  /**
   * Whether the stored grants allow this action. Reads policies ONLY.
   *
   * A deployment that has not run the conversion yet has no policy for the
   * resource, and this answers "no" for everyone — including administrators.
   * A gate written on `allows` therefore fails closed for the whole
   * pre-cutover window, which is silent and looks like a permissions bug.
   * `getEffective` is the one that also consults the compatibility layer, so
   * prefer it for anything guarding a user-facing action, and keep `allows`
   * for checks that are meaningful only once grants are authoritative.
   */
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
    resource: ScopedResource;
    grants: ResourcePermissionGrant[];
    scope?: ResourcePermissionScope;
  }): Promise<void> {
    // Every stored grant is one preset. A set between two presets has no
    // label in the editor and no single meaning, so it is refused rather than
    // silently widened into authority the caller did not ask for.
    if (
      params.grants.some(
        (grant) => !isResourcePermissionPreset(grant.actions, params.resource),
      )
    )
      throw new ApiError(
        400,
        "Each grant must be one of the permission levels this resource offers",
      );
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
    await CredentialResourcePermissions.validatePolicy(params);
    const current = await ResourcePermissionPolicyModel.find(params);
    // Retaining an existing grant does not delegate new authority. A limited
    // permission manager may revoke access without removing stronger grants
    // held by other recipients, but may add only actions they hold themselves.
    const requested = params.grants.flatMap((grant) =>
      grant.actions
        .filter(
          (action) =>
            !current?.grants.some(
              (existing) =>
                subjectKey(existing.subject) === subjectKey(grant.subject) &&
                existing.actions.includes(action),
            ),
        )
        .map((action) => ({
          organizationId: params.organizationId,
          resource: params.resource,
          scope: params.scope,
          action,
        })),
    );
    if (
      !hasScopedPermission({
        grants: params.authority,
        required: {
          ...params,
          scope: params.scope,
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
          "Granular access control requires an active Enterprise entitlement or the small-team allowance.",
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
    scope?: ResourcePermissionScope;
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

/** A stored author id is either a member or a `service-account:<id>` marker. */
function subjectForUserId(userId: string): PermissionSubject {
  return userId.startsWith(SERVICE_ACCOUNT_USER_ID_PREFIX)
    ? {
        type: "serviceAccount",
        id: userId.slice(SERVICE_ACCOUNT_USER_ID_PREFIX.length),
      }
    : { type: "user", id: userId };
}

/** Resolve only explicit resource and organization-wide policies. */
function expandScopedGrants(params: {
  policies: Awaited<
    ReturnType<typeof ResourcePermissionPolicyModel.findForSubjects>
  >;
  subjectKeys: Set<string>;
}): ScopedPermission[] {
  return params.policies.flatMap((policy) => {
    if (!ResourcePermissionScopeSchema.safeParse(policy.scope).success)
      return [];
    return policy.grants.flatMap((grant) =>
      params.subjectKeys.has(subjectKey(grant.subject))
        ? grant.actions.map((action) => ({
            organizationId: policy.organizationId,
            resource: policy.resource,
            scope: policy.scope,
            action,
          }))
        : [],
    );
  });
}

function inheritedPolicyGrants(params: {
  policies: Awaited<
    ReturnType<typeof ResourcePermissionPolicyModel.findApplicable>
  >;
  scope: string;
}) {
  return params.policies
    .filter((policy) => policy.scope === "*" && policy.scope !== params.scope)
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
        scope: params.scope,
      },
    }),
  );
}

function sessionLegacyGrants(
  target: Awaited<ReturnType<typeof ResourcePermissionTargetModel.find>>,
): ResourcePermissionGrant[] {
  if (!target) return [];
  const grants: ResourcePermissionGrant[] = [];
  if (target.authorId)
    grants.push({
      subject: { type: "user", id: target.authorId },
      actions: ["read", "manage-permissions"],
    });
  if (target.enabled === false) return grants;
  if (target.scope === "org")
    grants.push({
      subject: { type: "organization", id: "*" },
      actions: ["read"],
    });
  for (const team of target.teams)
    grants.push({ subject: { type: "team", id: team.id }, actions: ["read"] });
  for (const user of target.users)
    if (user.id !== target.authorId)
      grants.push({
        subject: { type: "user", id: user.id },
        actions: ["read"],
      });
  return grants;
}
