import {
  isChatCompletionsOnlyRouterProvider,
  requiresOpenAiResponsesApi,
  requiresResponsesApi,
  type SupportedProvider,
} from "@archestra/shared";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { type AutoRouter, useAutoRouters } from "@/lib/auto-routing.query";
import { useFeature } from "@/lib/config/config.query";

type AutoRoutingTier = keyof AutoRouter["tiers"];
const TIERS: AutoRoutingTier[] = ["fast", "normal", "smart"];
type RouterEndpoint = "chat/completions" | "responses";
type OfferedRouter = Pick<
  AutoRouter,
  "name" | "enabled" | "tiers" | "virtualApiKeyIds"
>;

/** A model the request example can pick for this credential. */
interface RoutableModel {
  /** Provider-qualified id, like `openai:gpt-5.5`. */
  value: string;
  supportedEndpoints: readonly string[] | null | undefined;
}

/** What the request example offers for auto routing. */
export type AutoRoutingOffer =
  /** Nothing: the alpha is off, or no router is set up and the viewer can't set one up. */
  | { kind: "none" }
  /** Auto routing is off or no router has its three models; the viewer can set it up. */
  | { kind: "setup" }
  /** The routers the credential can call, each on the endpoint every tier model serves. */
  | {
      kind: "available";
      routers: Array<{ name: string; endpoint: RouterEndpoint }>;
    }
  /** Routers exist, but the virtual key has none of them. */
  | { kind: "unassigned" }
  /** Auto routing is on, but the credential can't reach these tier models. */
  | {
      kind: "unreachable";
      missing: Array<{ tier: AutoRoutingTier; provider: SupportedProvider }>;
    }
  /** The tier models share no endpoint, so no request can call the router. */
  | { kind: "no-shared-endpoint" };

/**
 * Decides the offer. A virtual key reaches the routers it was given, on their
 * own provider keys. Any other credential reaches a router when every tier
 * model is among the models the example can already pick for it, the same
 * list the model picker shows.
 *
 * The proxy refuses a router unless every tier model serves the request's
 * endpoint, so this mirrors its endpoint rules: a model that requires
 * Responses can't take Chat Completions, and a Chat Completions-only provider
 * can't take Responses.
 */
export function autoRoutingOffer({
  featureEnabled,
  routers,
  virtualApiKeyId,
  canConfigure,
  routableModels,
  modelsPending,
}: {
  featureEnabled: boolean;
  routers: readonly OfferedRouter[] | null | undefined;
  /** The virtual key the example is for; null for any other credential. */
  virtualApiKeyId: string | null;
  canConfigure: boolean;
  routableModels: readonly RoutableModel[];
  modelsPending: boolean;
}): AutoRoutingOffer {
  if (!featureEnabled || !routers) return { kind: "none" };
  const ready = routers.filter(
    (router) =>
      router.enabled && TIERS.every((tier) => router.tiers[tier] !== null),
  );
  if (ready.length === 0) {
    return canConfigure ? { kind: "setup" } : { kind: "none" };
  }
  // Wait for the models rather than flash "unreachable".
  if (modelsPending) return { kind: "none" };

  const granted =
    virtualApiKeyId === null
      ? ready
      : ready.filter((router) =>
          router.virtualApiKeyIds.includes(virtualApiKeyId),
        );
  if (granted.length === 0) return { kind: "unassigned" };

  const outcomes = granted.map((router) => ({
    name: router.name,
    outcome: routerOutcome(router, routableModels, virtualApiKeyId !== null),
  }));
  const available = outcomes.flatMap(({ name, outcome }) =>
    outcome.kind === "available" ? [{ name, endpoint: outcome.endpoint }] : [],
  );
  if (available.length > 0) return { kind: "available", routers: available };
  // None can be called: say why for the first.
  for (const { outcome } of outcomes) {
    if (outcome.kind !== "available") return outcome;
  }
  return { kind: "none" };
}

type RouterOutcome =
  | { kind: "available"; endpoint: RouterEndpoint }
  | Extract<AutoRoutingOffer, { kind: "unreachable" | "no-shared-endpoint" }>;

function routerOutcome(
  router: OfferedRouter,
  routableModels: readonly RoutableModel[],
  usesRouterKeys: boolean,
): RouterOutcome {
  const tiers = TIERS.flatMap((tier) => {
    const model = router.tiers[tier];
    if (!model) return [];
    return [
      {
        tier,
        ...model,
        routable: routableModels.find(
          (candidate) =>
            candidate.value === `${model.provider}:${model.modelId}`,
        ),
      },
    ];
  });
  // A virtual key given the router spends the router's own keys.
  const missing = usesRouterKeys
    ? []
    : tiers.flatMap(({ tier, provider, routable }) =>
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
  virtualApiKeyId = null,
  routableModels,
  modelsPending,
}: {
  enabled: boolean;
  virtualApiKeyId?: string | null;
  routableModels: readonly RoutableModel[];
  modelsPending: boolean;
}): AutoRoutingOffer {
  const featureEnabled = useFeature("autoRoutingEnabled") === true;
  const { data: routers } = useAutoRouters({
    enabled: enabled && featureEnabled,
  });
  const { data: canConfigure = false } = useHasPermissions({
    llmProxy: ["update"],
  });
  if (!enabled) return { kind: "none" };
  return autoRoutingOffer({
    featureEnabled,
    routers,
    virtualApiKeyId,
    canConfigure,
    routableModels,
    modelsPending,
  });
}
