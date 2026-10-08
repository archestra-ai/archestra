// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  canDelegateScopedPermissions,
  hasScopedPermission,
  isBuiltInCatalogId,
  isResourcePermissionPreset,
  ManagedResourceSchema,
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
import { SERVICE_ACCOUNT_USER_ID_PREFIX } from "@/auth/service-account-user-id";
import { getPermissionsForUserContext } from "@/auth/utils";
import { enterpriseTier } from "@/enterprise-tier";
import KbFileModel from "@/models/kb-file";
import MemberModel from "@/models/member";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import ResourcePermissionSubjectModel, {
  type PrincipalSource,
} from "@/models/resource-permission-subject";
import ResourcePermissionTargetModel from "@/models/resource-permission-target";
import { assertNoStaticPinsBrokenByTargetChange } from "@/services/agent-tool-assignment";
import { resyncAppBackingInstallScope } from "@/services/apps/app-mcp-backing";
import type { ListInternalMcpCatalog } from "@/types";
import { ApiError } from "@/types";
import { CredentialResourcePermissions } from "./credential-resource-permissions";

export class ResourcePermissions {
  /**
   * Assigning a role or team also delegates every scoped grant it carries.
   *
   * Grants on an object only its owner can share are the exception. No
   * organization-wide grant reaches another member's session, their own
   * provider key, or their encrypted chat or app, so nobody else can ever
   * hold the authority this rule asks for. The owner chose the role or team
   * as the audience, and whoever administers that audience decides who is in
   * it. Without this, one member sharing a chat with the Member role would
   * stop every administrator from assigning Member to anyone. Grants kept on
   * a deleted object are skipped too: they reach nothing.
   */
  static async validateSubjectAssignment(params: {
    organizationId: string;
    userId: string;
    subjects: PermissionSubject[];
  }): Promise<void> {
    const policies =
      await ResourcePermissionPolicyModel.findForSubjects(params);
    const keys = new Set(params.subjects.map(subjectKey));
    const canManageGlobal =
      await ResourcePermissions.canManageGlobalPolicy(params);
    for (const policy of policies) {
      if (!ManagedResourceSchema.safeParse(policy.resource).success) continue;
      if (policy.scope === "*" && canManageGlobal) continue;
      if (isSessionObject({ resource: policy.resource, scope: policy.scope }))
        continue;
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
      const context = {
        ...params,
        resource: policy.resource,
        scope: policy.scope,
      };
      const target =
        policy.scope === "*"
          ? null
          : await ResourcePermissionTargetModel.find({
              ...context,
              id: policy.scope,
            });
      // A deleted object reaches nobody, so its grants hand out nothing.
      if (policy.scope !== "*" && !target) continue;
      if (reservedToAuthor({ ...context, target })) continue;
      const grants = await ResourcePermissions.resolve(context);
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
  static async resolveAll(
    params:
      | { organizationId: string; userId: string; lookups?: PrincipalSource }
      | { organizationId: string; subjects: PermissionSubject[] },
  ): Promise<ManagedScopedPermission[]> {
    const subjects =
      "subjects" in params
        ? params.subjects
        : await ResourcePermissions.getSubjects(params);
    const policies = await ResourcePermissionPolicyModel.findForSubjects({
      organizationId: params.organizationId,
      subjects,
    });
    const keys = new Set(subjects.map(subjectKey));
    return expandScopedGrants({ policies, subjectKeys: keys });
  }

  /** Check a list of organization-owned environments with one policy read. */
  static async getUsableEnvironmentIds(params: {
    organizationId: string;
    userId: string;
    environmentIds: string[];
  }): Promise<Set<string>> {
    if (params.environmentIds.length === 0) return new Set();
    const subjects = await ResourcePermissions.getSubjects(params);
    if (subjects.length === 0) return new Set();
    const policies = await ResourcePermissionPolicyModel.findApplicableBatch({
      organizationId: params.organizationId,
      resource: "environment",
      scopes: params.environmentIds,
    });
    const grants = expandScopedGrants({
      policies,
      subjectKeys: new Set(subjects.map(subjectKey)),
    });
    return new Set(
      params.environmentIds.filter((scope) =>
        hasScopedPermission({
          grants,
          required: {
            organizationId: params.organizationId,
            resource: "environment",
            scope,
            action: "use",
          },
        }),
      ),
    );
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
    params: PermissionContext & {
      action: ResourcePermissionAction;
      includeDeleted?: boolean;
    },
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
    const canManage =
      params.scope === "*"
        ? await ResourcePermissions.canManageGlobalPolicy(params)
        : hasScopedPermission({
            grants: effective.grants,
            required: { ...params, action: "manage-permissions" },
          });
    if (!canManage)
      throw new ApiError(
        403,
        "You do not have permission to manage access to this resource",
      );
    return ResourcePermissions.findRecipients(params);
  }

  static async getEffective(
    params: PermissionContext & { includeDeleted?: boolean },
  ) {
    if (!ManagedResourceSchema.safeParse(params.resource).success)
      throw new ApiError(400, "Logs use Read and Admin role permissions");
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
    if (reservedToAuthor({ ...params, target }))
      return { target, grants: [] as ScopedPermission[] };
    // Stored grants are authoritative. `resolve` answers nothing for a
    // disabled service account or a user whose membership has been removed.
    return { target, grants: await ResourcePermissions.resolve(params) };
  }

  static async getPolicy(params: PermissionContext) {
    const effective = await ResourcePermissions.getEffective(params);
    const canView =
      params.scope === "*"
        ? await ResourcePermissions.canViewGlobalPolicy(params)
        : hasScopedPermission({
            grants: effective.grants,
            required: { ...params, action: "read" },
          }) ||
          hasScopedPermission({
            grants: effective.grants,
            required: { ...params, action: "manage-permissions" },
          });
    if (!canView)
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
      resource: ManagedResourceSchema.parse(params.resource),
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
        throw new ApiError(400, "Encrypted chats cannot be shared");
    }
    const effective = await ResourcePermissions.getEffective(params);
    await ResourcePermissions.assertNoStaticPinsBroken({
      ...params,
      authorId: effective.target?.authorId ?? null,
    });
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
      resource: ManagedResourceSchema.parse(params.resource),
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
    params: PermissionContext & {
      action: ResourcePermissionAction;
      lookups?: PrincipalSource;
    },
  ): Promise<boolean> {
    const grants = await ResourcePermissions.resolve(params);
    return hasScopedPermission({ grants, required: params });
  }

  static async resolve(
    context: PermissionContext & { lookups?: PrincipalSource },
  ): Promise<ScopedPermission[]> {
    if (!ManagedResourceSchema.safeParse(context.resource).success) return [];
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
    // Global policy administration is an explicit organization role action.
    // It does not grant access to the underlying resources, and scoped
    // manage-permissions never substitutes for it on a wildcard policy.
    const canManage =
      params.scope === "*"
        ? await ResourcePermissions.canManageGlobalPolicy(params)
        : hasScopedPermission({
            grants: params.authority,
            required: { ...params, action: "manage-permissions" },
          }) &&
          canDelegateScopedPermissions({ grants: params.authority, requested });
    if (!canManage) {
      throw new ApiError(
        403,
        params.scope === "*"
          ? "You need accessPolicies:update to edit access policies"
          : "You can only grant permissions you hold on this resource",
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
   * A static tool pin trusts its connection for good. A policy edit that takes
   * an agent or app out of the connection's team would leave the pin using a
   * credential its audience no longer shares, so the edit is refused.
   */
  private static async assertNoStaticPinsBroken(
    params: PermissionContext & {
      grants: ResourcePermissionGrant[];
      authorId: string | null;
    },
  ) {
    const { resource, scope, organizationId } = params;
    if (scope === "*") return;
    if (resource !== "agent" && resource !== "mcpGateway" && resource !== "app")
      return;
    const current = await ResourcePermissionPolicyModel.findAudience(params);
    const next = ResourcePermissionPolicyModel.audienceOfGrants(params.grants);
    const target = { organizationId, authorId: params.authorId };
    await assertNoStaticPinsBrokenByTargetChange({
      ...(resource === "app" ? { appId: scope } : { agentId: scope }),
      currentTarget: {
        ...target,
        scope: current.audience,
        teamIds: current.teamIds,
      },
      nextTarget: { ...target, scope: next.audience, teamIds: next.teamIds },
    });
  }

  private static async canViewGlobalPolicy(params: {
    userId: string;
    organizationId: string;
  }) {
    const permissions = await getPermissionsForUserContext(params);
    return (
      permissions.accessPolicies?.some(
        (action) => action === "read" || action === "update",
      ) ?? false
    );
  }

  private static async canManageGlobalPolicy(params: {
    userId: string;
    organizationId: string;
  }) {
    const permissions = await getPermissionsForUserContext(params);
    return permissions.accessPolicies?.includes("update") ?? false;
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
    lookups?: PrincipalSource;
  }): Promise<PermissionSubject[]> {
    const { subjects } =
      await ResourcePermissionSubjectModel.resolvePrincipalFrom(
        params.lookups,
        { userId: params.userId, organizationId: params.organizationId },
      );
    return subjects;
  }
}

type ManagedScopedPermission = ScopedPermission & {
  resource: Exclude<ScopedResource, "log" | "auditLog">;
};

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

/** A single chat or agent run. Only its owner holds authority over it. */
function isSessionObject(params: {
  resource: string;
  scope: ResourcePermissionScope;
}): boolean {
  return (
    (params.resource === "conversation" || params.resource === "agentRun") &&
    params.scope !== "*"
  );
}

/**
 * An object only its author reaches, whatever `*` grants anyone else holds: an
 * encrypted chat or a disabled app, and a provider key with an owner, which is
 * that person's own key.
 */
function reservedToAuthor(params: {
  userId: string;
  resource: ScopedResource;
  target: Awaited<ReturnType<typeof ResourcePermissionTargetModel.find>>;
}): boolean {
  const { target } = params;
  if (!target || target.authorId === params.userId) return false;
  if (
    (params.resource === "app" || params.resource === "conversation") &&
    target.enabled === false
  )
    return true;
  return params.resource === "llmProviderApiKey" && !!target.authorId;
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
}): ManagedScopedPermission[] {
  return params.policies.flatMap((policy) => {
    const resource = ManagedResourceSchema.safeParse(policy.resource);
    if (
      !resource.success ||
      !ResourcePermissionScopeSchema.safeParse(policy.scope).success
    )
      return [];
    return policy.grants.flatMap((grant) =>
      params.subjectKeys.has(subjectKey(grant.subject))
        ? grant.actions.map((action) => ({
            organizationId: policy.organizationId,
            resource: resource.data,
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
