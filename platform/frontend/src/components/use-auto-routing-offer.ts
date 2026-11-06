import {
  isChatCompletionsOnlyRouterProvider,
  requiresOpenAiResponsesApi,
  requiresResponsesApi,
  type SupportedProvider,
} from "@archestra/shared";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type AutoRoutingSettings,
  useAutoRoutingSettings,
} from "@/lib/auto-routing.query";
import { useFeature } from "@/lib/config/config.query";

/** The Unified Model API's auto routing model name. */
export const AUTO_MODEL = "auto";

type AutoRoutingTier = keyof AutoRoutingSettings["tiers"];
const TIERS: AutoRoutingTier[] = ["fast", "normal", "smart"];

/** A model the request example can pick for this credential. */
interface RoutableModel {
  /** Provider-qualified id, like `openai:gpt-5.5`. */
  value: string;
  supportedEndpoints: readonly string[] | null | undefined;
}

/** What the request example offers for auto routing. */
export type AutoRoutingOffer =
  /** Nothing: the alpha is off, or auto routing is off and the viewer can't set it up. */
  | { kind: "none" }
  /** Auto routing is off or has no model for a tier; the viewer can set it up. */
  | { kind: "setup" }
  /** The credential can call `auto`, on the endpoint every tier model serves. */
  | { kind: "available"; endpoint: "chat/completions" | "responses" }
  /** Auto routing is on, but the credential can't reach these tier models. */
  | {
      kind: "unreachable";
      missing: Array<{ tier: AutoRoutingTier; provider: SupportedProvider }>;
    }
  /** The tier models share no endpoint, so no request can call `auto`. */
  | { kind: "no-shared-endpoint" };

/**
 * Decides the offer. A tier counts as reachable when its model is among the
 * models the example can already pick for this credential, the same list the
 * model picker shows.
 *
 * The router refuses `auto` unless every tier model serves the request's
 * endpoint, so this mirrors its endpoint rules: a model that requires
 * Responses can't take Chat Completions, and a Chat Completions-only provider
 * can't take Responses.
 */
export function autoRoutingOffer({
  featureEnabled,
  settings,
  canConfigure,
  routableModels,
  modelsPending,
}: {
  featureEnabled: boolean;
  settings: Pick<AutoRoutingSettings, "enabled" | "tiers"> | null | undefined;
  canConfigure: boolean;
  routableModels: readonly RoutableModel[];
  modelsPending: boolean;
}): AutoRoutingOffer {
  if (!featureEnabled || !settings) return { kind: "none" };
  const configured = TIERS.flatMap((tier) => {
    const model = settings.tiers[tier];
    return model ? [{ tier, ...model }] : [];
  });
  if (!settings.enabled || configured.length < TIERS.length) {
    return canConfigure ? { kind: "setup" } : { kind: "none" };
  }
  // Wait for the models rather than flash "unreachable".
  if (modelsPending) return { kind: "none" };
  const tiers = configured.map((tier) => ({
    ...tier,
    routable: routableModels.find(
      (model) => model.value === `${tier.provider}:${tier.modelId}`,
    ),
  }));
  const missing = tiers.flatMap(({ tier, provider, routable }) =>
    routable ? [] : [{ tier, provider }],
  );
  if (missing.length > 0) return { kind: "unreachable", missing };

  const requiresResponses = tiers.map(
    ({ provider, modelId, routable }) =>
      requiresResponsesApi(routable?.supportedEndpoints) ||
      (provider === "openai" && requiresOpenAiResponsesApi(modelId)),
  );
  if (!requiresResponses.some(Boolean)) {
    return { kind: "available", endpoint: "chat/completions" };
  }
  const allServeResponses = tiers.every(
    ({ provider }, index) =>
      requiresResponses[index] ||
      !isChatCompletionsOnlyRouterProvider(provider),
  );
  return allServeResponses
    ? { kind: "available", endpoint: "responses" }
    : { kind: "no-shared-endpoint" };
}

export function useAutoRoutingOffer({
  enabled,
  routableModels,
  modelsPending,
}: {
  enabled: boolean;
  routableModels: readonly RoutableModel[];
  modelsPending: boolean;
}): AutoRoutingOffer {
  const featureEnabled = useFeature("autoRoutingEnabled") === true;
  const { data: settings } = useAutoRoutingSettings({
    enabled: enabled && featureEnabled,
  });
  const { data: canConfigure = false } = useHasPermissions({
    llmProxy: ["update"],
  });
  if (!enabled) return { kind: "none" };
  return autoRoutingOffer({
    featureEnabled,
    settings,
    canConfigure,
    routableModels,
    modelsPending,
  });
}
