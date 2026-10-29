import { userKeyForModel } from "@/auto-routing/eligibility";
import { loadTrio } from "@/auto-routing/tiers";
import config from "@/config";
import { ModelModel, OrganizationModel } from "@/models";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import { ApiError } from "@/types";

/**
 * What an agent or chat set to "Auto" stores next to the flag: the
 * organization's default model, which is auto routing's normal tier, on a key
 * the user may use. Everything that needs one concrete model reads it.
 */
export async function resolveAutoRoutedAnchor(params: {
  organizationId: string;
  userId: string;
}): Promise<{ chatApiKeyId: string; modelId: string }> {
  const { organizationId, userId } = params;
  if (!(await autoRoutingAvailable(organizationId))) {
    throw new ApiError(
      400,
      "Auto routing is not enabled for this organization.",
    );
  }
  const organization = await OrganizationModel.getById(organizationId);
  const model = organization?.defaultModelId
    ? await ModelModel.findById(organization.defaultModelId)
    : null;
  if (!model) {
    throw new ApiError(400, "The organization has no default model.");
  }
  const key = await userKeyForModel({ organizationId, userId, model });
  if (key.kind === "none" || key.apiKeyId === null) {
    throw new ApiError(
      400,
      `Auto routing's normal tier "${model.provider}/${model.modelId}" has no API key you can use.`,
    );
  }
  return { chatApiKeyId: key.apiKeyId, modelId: model.id };
}

/**
 * Applies an agent's or chat's model choice in place: "Auto" stores the
 * anchor and leaves any pool, and picking a pool, key or model leaves "Auto".
 */
export async function applyAutoRoutedChoice<
  K extends "llmApiKeyId" | "chatApiKeyId",
>(params: {
  body: {
    autoRouted?: boolean;
    modelPoolId?: string | null;
    modelId?: string | null;
  } & Partial<Record<K, string | null>>;
  keyField: K;
  organizationId: string;
  userId: string;
}): Promise<void> {
  const { body, keyField } = params;
  if (body.autoRouted) {
    const anchor = await resolveAutoRoutedAnchor(params);
    body.modelPoolId = null;
    body.modelId = anchor.modelId;
    body[keyField] = anchor.chatApiKeyId as (typeof body)[K];
    return;
  }
  if (
    body.autoRouted === undefined &&
    (body[keyField] !== undefined ||
      body.modelId !== undefined ||
      body.modelPoolId)
  ) {
    body.autoRouted = false;
  }
}

// === Internal ===

async function autoRoutingAvailable(organizationId: string): Promise<boolean> {
  if (!config.autoRouting.enabled) return false;
  const settings = await AutoRoutingSettingsModel.find(organizationId);
  if (!settings?.enabled) return false;
  return (await loadTrio(settings)).kind === "ok";
}
