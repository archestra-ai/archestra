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
 * An agent with no model, key or pool of its own runs on the organization
 * default, which auto routing routes across the organization trio. Agent
 * Runtime agents are not routed: their CLI reaches the proxy from its pod on a
 * single-provider key with the model fixed at launch.
 */
export function followsOrganizationRouting(
  agent: Pick<
    GatewayAgent,
    "llmApiKeyId" | "modelId" | "modelPoolId" | "runtime"
  >,
): boolean {
  return (
    agent.runtime === null &&
    agent.llmApiKeyId === null &&
    agent.modelId === null &&
    agent.modelPoolId === null
  );
}

/** What "Organization default" currently runs on, named for any member. */
export async function describeOrganizationDefaultModel(
  organizationId: string,
): Promise<OrganizationDefaultModel> {
  const settings = config.autoRouting.enabled
    ? await AutoRoutingSettingsModel.find(organizationId)
    : null;
  const loaded = settings?.enabled ? await loadTrio(settings) : null;
  if (loaded?.kind === "ok") {
    const [fast, normal, smart] = loaded.trio.map(toRef);
    return {
      model: normal,
      autoRouting: { active: true, tiers: { fast, normal, smart } },
    };
  }
  const organization = await OrganizationModel.getById(organizationId);
  const model = organization?.defaultModelId
    ? await ModelModel.findById(organization.defaultModelId)
    : null;
  return { model: model ? toRef(model) : null, autoRouting: { active: false } };
}

// === Internal ===

function toRef(model: Model): OrganizationDefaultModelRef {
  return {
    id: model.id,
    provider: model.provider,
    displayName: model.description || model.modelId,
  };
}
