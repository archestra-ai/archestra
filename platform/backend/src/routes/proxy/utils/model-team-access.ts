import type { SupportedProvider } from "@archestra/shared";
import { ModelModel } from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { ResourcePermissions } from "@/services/resource-permissions";

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
}): Promise<ModelTeamAccessResult> {
  const { provider, modelId, organizationId, authenticatedUserId } = params;

  const model = await ModelModel.findByProviderAndModelId(provider, modelId);
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
  const allowed = authenticatedUserId
    ? await ResourcePermissions.allows({
        ...key,
        userId: authenticatedUserId,
        action: "use",
      })
    : (await ResourcePermissionPolicyModel.findApplicable(key)).some(
        (entry) =>
          (entry.scope === "*" || entry.scope === model.id) &&
          ResourcePermissionPolicyModel.isOrganizationWide({
            policy: entry,
            scope: model.id,
            action: "use",
          }),
      );
  // SPDX-SnippetEnd
  return allowed
    ? { allowed: true }
    : {
        allowed: false,
        message: `You do not have permission to use model ${modelId}. Ask an administrator for access or pick a different model.`,
      };
}
