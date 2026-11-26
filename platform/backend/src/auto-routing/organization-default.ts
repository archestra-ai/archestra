import { ModelModel, OrganizationModel } from "@/models";
import AutoRouterModel from "@/models/auto-router";
import type { GatewayAgent, Model } from "@/types";
import type {
  OrganizationDefaultModel,
  OrganizationDefaultModelRef,
} from "@/types/organization";
import { userModelRouterAuth } from "./eligibility";
import { chatAutoRouterAvailability } from "./router";
import { loadTrio } from "./tiers";

/**
 * The auto router an agent's runs go to: the one it is set to itself, or the
 * organization default's when it has no model, key or pool of its own. Null
 * when its runs are not auto routed. Agent Runtime agents never are: their CLI
 * reaches the proxy from its pod on a single-provider key with the model fixed
 * at launch.
 */
export async function agentAutoRouterId(
  agent: Pick<
    GatewayAgent,
    "autoRouterId" | "llmApiKeyId" | "modelId" | "modelPoolId" | "runtime"
  >,
  organizationId: string,
): Promise<string | null> {
  if (agent.runtime !== null) return null;
  if (agent.autoRouterId) return agent.autoRouterId;
  if (
    agent.llmApiKeyId !== null ||
    agent.modelId !== null ||
    agent.modelPoolId !== null
  ) {
    return null;
  }
  const organization = await OrganizationModel.getById(organizationId);
  return organization?.defaultAutoRouterId ?? null;
}

/**
 * What "Organization default" currently runs on, named for any member, and
 * the auto routers offered as a model: auto routing is on and their tiers are
 * set. With auto routing off, chats and agents on a router run on its normal
 * tier.
 */
export async function describeOrganizationDefaultModel(
  organizationId: string,
  chatUserId?: string,
): Promise<OrganizationDefaultModel> {
  const organization = await OrganizationModel.getById(organizationId);
  const routers = await AutoRouterModel.list(organizationId);
  const auth =
    chatUserId && routers.some((router) => router.enabled)
      ? await userModelRouterAuth({ organizationId, userId: chatUserId })
      : null;
  const autoRouters: OrganizationDefaultModel["autoRouters"] = [];
  for (const router of routers) {
    const loaded = router.enabled ? await loadTrio(router) : null;
    if (loaded?.kind !== "ok") continue;
    const availability = auth
      ? await chatAutoRouterAvailability({ router, auth, trio: loaded.trio })
      : null;
    autoRouters.push({
      id: router.id,
      name: router.name,
      ...(availability && {
        unavailableReason:
          availability.kind === "unavailable" ? availability.reason : null,
        normalOnlyReason:
          availability.kind === "normal" ? availability.reason : null,
      }),
      tiers: {
        fast: toRef(loaded.trio[0]),
        normal: toRef(loaded.trio[1]),
        smart: toRef(loaded.trio[2]),
      },
    });
  }
  const defaultRouter =
    routers.find((router) => router.id === organization?.defaultAutoRouterId) ??
    null;
  const normal = defaultRouter?.normalModelId
    ? await ModelModel.findById(defaultRouter.normalModelId)
    : null;
  const model =
    normal ??
    (organization?.defaultModelId
      ? await ModelModel.findById(organization.defaultModelId)
      : null);
  return {
    model: model ? toRef(model) : null,
    defaultAutoRouterId: defaultRouter?.id ?? null,
    autoRouters,
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
