/**
 * The model a forked subagent runs on for a tier (`fast` / `smart`), and the
 * organization trio's tier checks. A tier's model runs on a key the user may
 * use for it, chosen as the Unified API chooses one, so this sits above the
 * Unified API's key eligibility rather than in utils/llm-resolution.ts.
 */
import {
  findTierDefault,
  providerRequiresPerUserCredential,
  type SubagentModelTier,
} from "@archestra/shared";
import { userKeyForModel } from "@/auto-routing/eligibility";
import {
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OrganizationModel,
} from "@/models";
import { checkModelTeamAccess } from "@/routes/proxy/utils/model-team-access";
import { ApiError, type Model } from "@/types";
import type { ConversationLlmSelection } from "@/utils/llm-resolution";

/** The optional `fast` / `smart` tiers of the organization's default trio. */
interface ModelTrioTiers {
  fastModelId: string | null;
  smartModelId: string | null;
}

/** A tier a fork can run on other than its parent's own (`normal`). */
export type ForkTier = Exclude<SubagentModelTier, "normal">;

const ORGANIZATION_TIER_FIELD = {
  fast: "defaultFastModelId",
  smart: "defaultSmartModelId",
} as const satisfies Record<ForkTier, string>;

/**
 * The model and key a forked subagent runs on for `tier`: the organization
 * trio's model for that tier, else the provider's default tier model on the
 * parent's key. The trio's model runs on the parent's key when it serves the
 * model, else on a key the user may use for it, chosen as the Unified API
 * chooses one for the user. Falls back to the parent's own selection.
 */
export async function resolveSubagentTierSelection(params: {
  tier: SubagentModelTier;
  parent: ConversationLlmSelection;
  organizationId: string;
  userId: string;
}): Promise<ConversationLlmSelection> {
  const { tier, parent } = params;
  if (tier === "normal" || !parent.modelId) return parent;
  return (await findTierSelection({ ...params, tier })) ?? parent;
}

/**
 * The tiers a fork of `parent` can run on: every tier that resolves to a model
 * the user can reach. A tier that lands on the parent's own model is still
 * offered — what counts as fast or smart is the organization's call.
 */
export async function availableSubagentTiers(params: {
  parent: ConversationLlmSelection;
  organizationId: string;
  userId: string;
}): Promise<ForkTier[]> {
  if (!params.parent.modelId) return [];
  const tiers = await Promise.all(
    (["fast", "smart"] as const).map(async (tier) =>
      (await findTierSelection({ ...params, tier })) ? [tier] : [],
    ),
  );
  return tiers.flat();
}

/** Each set trio tier must be a tool-capable chat model, on any provider. */
export async function assertModelTrioTiers(
  trio: ModelTrioTiers,
): Promise<void> {
  const ids = [trio.fastModelId, trio.smartModelId].filter((id): id is string =>
    Boolean(id),
  );
  if (ids.length === 0) return;
  const models = await ModelModel.findByIds(ids);
  for (const id of ids) {
    const model = models.find((m) => m.id === id);
    if (!model || !isSubagentTierCandidate(model)) {
      throw new ApiError(400, `Model ${id} is not a tool-capable chat model`);
    }
  }
}

async function findTierSelection(params: {
  tier: ForkTier;
  parent: ConversationLlmSelection;
  organizationId: string;
  userId: string;
}): Promise<ConversationLlmSelection | undefined> {
  const { tier, parent } = params;
  const [organization, parentKeyModels] = await Promise.all([
    OrganizationModel.getById(params.organizationId),
    parent.chatApiKeyId
      ? LlmProviderApiKeyModelLinkModel.getModelsForApiKey(parent.chatApiKeyId)
      : providerRequiresPerUserCredential(parent.selectedProvider)
        ? ModelModel.findAll({ provider: parent.selectedProvider })
        : Promise.resolve([]),
  ]);
  const trioModelId = organization?.[ORGANIZATION_TIER_FIELD[tier]] ?? null;
  const trioModel = trioModelId ? await ModelModel.findById(trioModelId) : null;
  if (trioModel && isSubagentTierCandidate(trioModel)) {
    const onParentKey =
      parent.chatApiKeyId !== null &&
      parentKeyModels.some((m) => m.id === trioModel.id) &&
      (
        await checkModelTeamAccess({
          provider: trioModel.provider,
          modelId: trioModel.modelId,
          organizationId: params.organizationId,
          authenticatedUserId: params.userId,
        })
      ).allowed;
    const key = onParentKey
      ? { kind: "found" as const, apiKeyId: parent.chatApiKeyId }
      : await userKeyForModel({ ...params, model: trioModel });
    if (key.kind === "found") return toSelection(trioModel, key.apiKeyId);
  }
  const fallback = findTierDefault(
    parentKeyModels.filter(isSubagentTierCandidate),
    parent.selectedProvider,
    tier,
  );
  return fallback ? toSelection(fallback, parent.chatApiKeyId) : undefined;
}

function toSelection(
  model: Model,
  chatApiKeyId: string | null,
): ConversationLlmSelection {
  return {
    modelId: model.id,
    chatApiKeyId,
    selectedModel: model.modelId,
    selectedProvider: model.provider,
  };
}

/** A fork runs the parent's tools, so its model must chat and call tools. */
function isSubagentTierCandidate(model: Model): boolean {
  return (
    ModelModel.supportsTextChat(model) && model.supportsToolCalling !== false
  );
}
