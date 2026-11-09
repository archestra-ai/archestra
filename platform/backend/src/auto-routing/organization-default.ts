import config from "@/config";
import { ModelModel, OrganizationModel } from "@/models";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import type { GatewayAgent, Model } from "@/types";
import type {
  OrganizationDefaultModel,
  OrganizationDefaultModelRef,
} from "@/types/organization";
import { loadTrio } from "./tiers";

/**
 * Whether an agent's runs go to auto routing: it is set to `auto` itself, or
 * it has no model, key or pool of its own and the organization default is
 * `auto`. Agent Runtime agents are never routed: their CLI reaches the proxy
 * from its pod on a single-provider key with the model fixed at launch.
 */
export async function agentUsesAutoModel(
  agent: Pick<
    GatewayAgent,
    "autoModel" | "llmApiKeyId" | "modelId" | "modelPoolId" | "runtime"
  >,
  organizationId: string,
): Promise<boolean> {
  if (!config.autoRouting.enabled || agent.runtime !== null) return false;
  if (agent.autoModel) return true;
  if (
    agent.llmApiKeyId !== null ||
    agent.modelId !== null ||
    agent.modelPoolId !== null
  ) {
    return false;
  }
  const organization = await OrganizationModel.getById(organizationId);
  return organization?.defaultAutoModel ?? false;
}

/**
 * What "Organization default" currently runs on, named for any member, and
 * whether `auto` is offered: auto routing is on and its tiers are set. With
 * auto routing off, chats and agents on an `auto` default run on the normal
 * tier.
 */
export async function describeOrganizationDefaultModel(
  organizationId: string,
): Promise<OrganizationDefaultModel> {
  const organization = await OrganizationModel.getById(organizationId);
  const settings = config.autoRouting.enabled
    ? await AutoRoutingSettingsModel.find(organizationId)
    : null;
  const loaded = settings?.enabled ? await loadTrio(settings) : null;
  const autoRouting: OrganizationDefaultModel["autoRouting"] =
    loaded?.kind === "ok"
      ? {
          active: true,
          tiers: {
            fast: toRef(loaded.trio[0]),
            normal: toRef(loaded.trio[1]),
            smart: toRef(loaded.trio[2]),
          },
        }
      : { active: false };
  const defaultAutoModel =
    config.autoRouting.enabled && (organization?.defaultAutoModel ?? false);
  const normal =
    defaultAutoModel && settings?.normalModelId
      ? await ModelModel.findById(settings.normalModelId)
      : null;
  const model =
    normal ??
    (organization?.defaultModelId
      ? await ModelModel.findById(organization.defaultModelId)
      : null);
  return {
    model: model ? toRef(model) : null,
    defaultAutoModel,
    autoRouting,
  };
}

// === Internal ===

function toRef(model: Model): OrganizationDefaultModelRef {
  return {
    id: model.id,
    provider: model.provider,
    displayName: model.description || model.modelId,
  };
}
