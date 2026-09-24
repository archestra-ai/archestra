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
import KbFileModel from "@/models/kb-file";
import MemberModel from "@/models/member";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import ResourcePermissionSubjectModel from "@/models/resource-permission-subject";
import ResourcePermissionTargetModel from "@/models/resource-permission-target";
import RoleCompositionModel from "@/models/role-composition";
import ServiceAccountModel from "@/models/service-account";
import TeamModel from "@/models/team";
import { resyncAppBackingInstallScope } from "@/services/apps/app-mcp-backing";
import type { ListInternalMcpCatalog } from "@/types";
import { ApiError } from "@/types";
import { CredentialResourcePermissions } from "./credential-resource-permissions";

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
    const [permissions, policies] = await Promise.all([
      getPermissionsForUserContext(params),
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
      const required = {
        ...params,
        resource: "mcpRegistry" as const,
        scope: target.id,
      };
      result.set(
        target.id,
        ResourcePermissionActionSchema.options.filter((action) =>
          hasScopedPermission({
            grants: explicit,
            required: { ...required, action },
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
    // Stored grants are authoritative. `resolve` answers nothing for a
    // disabled service account or a user whose membership has been removed.
    return { target, grants: await ResourcePermissions.resolve(params) };
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
        grants: policy?.grants ?? [],
      }),
      inheritedGrants: await ResourcePermissions.describeGrants({
        organizationId: params.organizationId,
        grants: inherited,
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
      if (target?.policyConversation)
        throw new ApiError(400, "Policy conversations cannot be shared");
    }
    const effective = await ResourcePermissions.getEffective(params);
    const policy = await ResourcePermissions.replace({
      ...params,
      authority: effective.grants,
    });
    // An app's backing install follows the app's audience.
    if (params.resource === "app" && params.scope !== "*") {
      await resyncAppBackingInstallScope({
        appId: params.scope,
        organizationId: params.organizationId,
      });
    }
    // A file's indexed documents carry its audience as ACL tokens, so they
    // follow the edit, a revocation included.
    if (params.resource === "knowledgeFile" && params.scope !== "*") {
      await KbFileModel.refreshDocumentAcl({
        fileId: params.scope,
        organizationId: params.organizationId,
      });
    }
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
      effectiveActions: effectiveActionsForPolicy({
        ...params,
        grants: updated.grants,
      }),
    };
  }
  /**
   * Whether the stored grants allow this action, without loading the object.
   * `getEffective` answers the same question from the same grants, and also
   * 404s a missing object and hides a locked app or chat from everyone but
   * its author.
   */
  static async allows(
    params: PermissionContext & { action: ResourcePermissionAction },
  ): Promise<boolean> {
    const grants = await ResourcePermissions.resolve(params);
    return hasScopedPermission({ grants, required: params });
  }

  static async resolve(
    context: PermissionContext,
  ): Promise<ScopedPermission[]> {
    const params = await ResourcePermissions.grantContext(context);
    const subjects = await ResourcePermissions.getSubjects(params);
    if (subjects.length === 0) return [];
    const policies = await ResourcePermissionPolicyModel.findApplicable(params);
    const subjectKeys = new Set(subjects.map(subjectKey));
    return expandScopedGrants({ policies, subjectKeys })
      .filter(
        (grant) =>
          grant.scope === params.scope ||
          (grant.scope === "*" && !sessionOversightOnly(params)),
      )
      .map((grant) =>
        // A parent's grant answers for the variant that was asked about.
        grant.scope === params.scope
          ? { ...grant, scope: context.scope }
          : grant,
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

  /**
   * The context whose grants answer for an object. A registry runtime variant
   * has no policy of its own: its parent's grants decide, as they do for reads.
   */
  private static async grantContext(
    params: PermissionContext,
  ): Promise<PermissionContext> {
    if (params.resource !== "mcpRegistry" || params.scope === "*")
      return params;
    const parentId = await ResourcePermissionTargetModel.findRegistryParentId(
      params.scope,
    );
    return parentId ? { ...params, scope: parentId } : params;
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

/**
 * A grant on every chat is the oversight that used to be the `project:read-all`
 * role action: reading other members' chats inside a project the reader can
 * open. It is consulted there alone (see `ProjectService` and
 * `ConversationModel.findAccessibleById`), never when a single chat is
 * resolved, so it cannot reach a private chat outside a project.
 */
function sessionOversightOnly(params: PermissionContext): boolean {
  return params.resource === "conversation" && params.scope !== "*";
}

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
