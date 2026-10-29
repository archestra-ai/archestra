import type { SupportedProvider } from "@archestra/shared";
import { ModelModel } from "@/models";
import MemberModel from "@/models/member";
import type { ProxyRequestContext } from "@/models/proxy-request-context";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { ResourcePermissions } from "@/services/resource-permissions";
import type { Model } from "@/types/model";

export type ModelTeamAccessResult =
  | { allowed: true }
  | { allowed: false; message: string };

/**
 * Enforce model permissions at proxy request time: invoking a model takes a
 * `use` grant on it.
 *
 * `authenticatedUserId` MUST derive from a credential the caller proved they
 * hold. Identity hints a caller can set for themselves — the
 * X-Archestra-User-Id header above all — are not admissible here: they would
 * let anyone name a user who holds a grant and inherit their access. Requests
 * without a resolvable authenticated identity (e.g. an org-scoped virtual key
 * with no user attribution) may exercise only an organization-wide grant.
 */
export async function checkModelTeamAccess(params: {
  provider: SupportedProvider;
  modelId: string;
  organizationId: string;
  authenticatedUserId: string | undefined;
  /** The catalog row read by this request. */
  catalogModel?: Pick<Model, "id" | "provider" | "modelId">;
  /** Read once after authentication; never retain this across requests. */
  policySnapshot?: {
    organizationId: string;
    modelId: string;
    policies: ProxyRequestContext["modelPolicies"];
  };
}): Promise<ModelTeamAccessResult> {
  const { provider, modelId, organizationId, authenticatedUserId } = params;

  const model =
    params.catalogModel?.provider === provider &&
    params.catalogModel.modelId === modelId
      ? params.catalogModel
      : await ModelModel.findByProviderAndModelId(provider, modelId);
  if (!model) {
    // Unknown models cannot carry a restriction (nothing to reference), and
    // grants are per model, so there is no policy to read either. Demanding
    // authority over every model instead would take away an id an ordinary
    // caller could always reach — the proxy catalogues a first sighting a few
    // statements before this check, so the grant for it is written by then.
    return { allowed: true };
  }

  const key = {
    organizationId,
    resource: "llmModel" as const,
    scope: model.id,
  };
  // An organization credential has no acting person or service account.
  // It may exercise an explicit organization grant, never a user's or team's.
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  // An organization-wide use grant needs only current membership, not the
  // member's full team/role graph. Restricted models and service accounts
  // still resolve their complete grant subjects below. No result is cached
  // across requests, so membership and grant revocations take effect next call.
  const policies =
    params.policySnapshot?.organizationId === organizationId &&
    params.policySnapshot.modelId === model.id
      ? params.policySnapshot.policies
      : await ResourcePermissionPolicyModel.findApplicable(key);
  const organizationWide = policies.some(
    (entry) =>
      (entry.scope === "*" || entry.scope === model.id) &&
      (authenticatedUserId
        ? entry.grants.some(
            (grant) =>
              grant.subject.type === "organization" &&
              grant.subject.id === "*" &&
              grant.actions.includes("use"),
          )
        : ResourcePermissionPolicyModel.isOrganizationWide({
            policy: entry,
            scope: model.id,
            action: "use",
          })),
  );
  const member =
    organizationWide && authenticatedUserId
      ? await MemberModel.getByUserId(authenticatedUserId, organizationId)
      : undefined;
  const allowed =
    (organizationWide && (!authenticatedUserId || Boolean(member))) ||
    (authenticatedUserId
      ? await ResourcePermissions.allows({
          ...key,
          userId: authenticatedUserId,
          action: "use",
        })
      : false);
  // SPDX-SnippetEnd
  return allowed
    ? { allowed: true }
    : {
        allowed: false,
        message: `You do not have permission to use model ${modelId}. Ask an administrator for access or pick a different model.`,
      };
}
