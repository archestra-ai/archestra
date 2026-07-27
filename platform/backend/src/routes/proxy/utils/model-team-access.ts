import type { SupportedProvider } from "@archestra/shared";
import { userHasPermission } from "@/auth";
import { ModelModel, ModelTeamModel } from "@/models";

export type ModelTeamAccessResult =
  | { allowed: true }
  | { allowed: false; message: string };

/**
 * Enforce per-team model restrictions at proxy request time.
 *
 * A model with `model_team` rows is only invocable by an identified user who
 * is a member of one of those teams, or who manages the model catalog
 * (`llmModel:update` — org admins included). Requests without a resolvable
 * user identity (e.g. an org-scoped virtual key with no user attribution) are
 * denied for restricted models: "limited to these teams" requires knowing the
 * caller is in one of them.
 *
 * Unrestricted models (the default — no `model_team` rows) are always allowed,
 * so this check costs a single indexed lookup on the hot path.
 */
export async function checkModelTeamAccess(params: {
  provider: SupportedProvider;
  modelId: string;
  organizationId: string;
  userId: string | undefined;
  userTeamIds: string[];
}): Promise<ModelTeamAccessResult> {
  const { provider, modelId, organizationId, userId, userTeamIds } = params;

  const model = await ModelModel.findByProviderAndModelId(provider, modelId);
  if (!model) {
    // Unknown models cannot carry a restriction (nothing to reference).
    return { allowed: true };
  }

  const restrictions = await ModelTeamModel.getTeamIdsForModels([model.id]);
  const restrictedToTeamIds = restrictions.get(model.id);
  if (!restrictedToTeamIds) {
    return { allowed: true };
  }

  if (userId) {
    const restrictedTeams = new Set(restrictedToTeamIds);
    if (userTeamIds.some((teamId) => restrictedTeams.has(teamId))) {
      return { allowed: true };
    }

    const isModelCatalogAdmin = await userHasPermission(
      userId,
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
