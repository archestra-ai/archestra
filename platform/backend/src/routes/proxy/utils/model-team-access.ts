import type { SupportedProvider } from "@archestra/shared";
import { userHasPermission } from "@/auth";
import { ModelModel, ModelTeamModel } from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { ResourcePermissions } from "@/services/resource-permissions";

export type ModelTeamAccessResult =
  | { allowed: true }
  | { allowed: false; message: string };

/**
 * Enforce per-team model restrictions at proxy request time.
 *
 * A model with `model_team` rows is only invocable by an authenticated user who
 * is a member of one of those teams, or who manages the model catalog
 * (`llmModel:update` — org admins included). Requests without a resolvable
 * authenticated identity (e.g. an org-scoped virtual key with no user
 * attribution) are denied for restricted models: "limited to these teams"
 * requires knowing the caller is in one of them.
 *
 * Both `authenticatedUserId` and `userTeamIds` MUST derive from a credential
 * the caller proved they hold. Identity hints a caller can set for themselves —
 * the X-Archestra-User-Id header above all — are not admissible here: they
 * would let anyone name a member of an allowed team (or a catalog admin) and
 * inherit their access.
 *
 * Unrestricted models (the default — no `model_team` rows) are always allowed,
 * so this check costs a single indexed lookup on the hot path.
 */
export async function checkModelTeamAccess(params: {
  provider: SupportedProvider;
  modelId: string;
  organizationId: string;
  authenticatedUserId: string | undefined;
  userTeamIds: string[];
}): Promise<ModelTeamAccessResult> {
  const {
    provider,
    modelId,
    organizationId,
    authenticatedUserId,
    userTeamIds,
  } = params;

  const model = await ModelModel.findByProviderAndModelId(provider, modelId);
  if (!model) {
    const key = { organizationId, resource: "llmModel" as const, scope: "*" };
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    const policy = await ResourcePermissionPolicyModel.find(key);
    // SPDX-SnippetEnd
    if (!policy?.legacySharingMigrated) return { allowed: true };
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    const allowed = authenticatedUserId
      ? await ResourcePermissions.allows({
          ...key,
          userId: authenticatedUserId,
          action: "use",
        })
      : policy.grants.some(
          (grant) =>
            grant.subject.type === "organization" &&
            grant.actions.includes("use"),
        );
    // SPDX-SnippetEnd
    return allowed
      ? { allowed: true }
      : {
          allowed: false,
          message:
            "An uncatalogued model requires permission to use all models.",
        };
  }

  const key = {
    organizationId,
    resource: "llmModel" as const,
    scope: model.id,
  };
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  const policies = await ResourcePermissionPolicyModel.findApplicable(key);
  // SPDX-SnippetEnd
  if (policies.some((policy) => policy.legacySharingMigrated)) {
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
      : policies.some(
          (entry) =>
            (entry.scope === "*" || entry.scope === model.id) &&
            entry.grants.some(
              (grant) =>
                grant.subject.type === "organization" &&
                grant.subject.id === "*" &&
                grant.actions.includes("use"),
            ),
        );
    // SPDX-SnippetEnd
    return allowed
      ? { allowed: true }
      : {
          allowed: false,
          message: `You do not have permission to use model ${modelId}. Ask an administrator for access or pick a different model.`,
        };
  }

  const restrictions = await ModelTeamModel.getTeamIdsForModels([model.id]);
  const restrictedToTeamIds = restrictions.get(model.id);
  if (!restrictedToTeamIds) {
    return { allowed: true };
  }

  if (authenticatedUserId) {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    if (
      await ResourcePermissions.allows({
        organizationId,
        userId: authenticatedUserId,
        resource: "llmModel",
        scope: model.id,
        action: "use",
      })
    )
      return { allowed: true };
    // SPDX-SnippetEnd
    const restrictedTeams = new Set(restrictedToTeamIds);
    if (userTeamIds.some((teamId) => restrictedTeams.has(teamId))) {
      return { allowed: true };
    }

    const isModelCatalogAdmin = await userHasPermission(
      authenticatedUserId,
      organizationId,
      "llmModel",
      "update",
    );
    if (isModelCatalogAdmin) {
      return { allowed: true };
    }
  }

  return {
    allowed: false,
    message: `Model ${modelId} is restricted to specific teams in this organization. Ask an administrator for access or pick a different model.`,
  };
}
