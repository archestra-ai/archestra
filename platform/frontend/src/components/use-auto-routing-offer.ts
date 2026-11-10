import {
  isChatCompletionsOnlyRouterProvider,
  requiresOpenAiResponsesApi,
  requiresResponsesApi,
  type SupportedProvider,
} from "@archestra/shared";
import { type AutoRouter, useAutoRouters } from "@/lib/auto-routing.query";
import { useFeature } from "@/lib/config/config.query";

type AutoRoutingTier = keyof AutoRouter["tiers"];
const TIERS: AutoRoutingTier[] = ["fast", "normal", "smart"];
type RouterEndpoint = "chat/completions" | "responses";
type OfferedRouter = Pick<
  AutoRouter,
  "id" | "name" | "enabled" | "tiers" | "virtualApiKeyIds"
>;
type OfferedTier = NonNullable<AutoRouter["tiers"][AutoRoutingTier]>;

/** A model the request example can pick for this credential. */
interface RoutableModel {
  /** Provider-qualified id, like `openai:gpt-5.5`. */
  value: string;
  supportedEndpoints: readonly string[] | null | undefined;
}

/** What the request example offers for auto routing. */
export type AutoRoutingOffer =
  /** Nothing: the alpha is off, or the credential has no router that is set up. */
  | { kind: "none" }
  /** The routers the credential can call, each on the endpoint every tier model serves. */
  | {
      kind: "available";
      routers: Array<{
        name: string;
        endpoint: RouterEndpoint;
        tiers: Record<AutoRoutingTier, OfferedTier>;
      }>;
    }
  /** Auto routing is on, but the credential can't reach these tier models. */
  | {
      kind: "unreachable";
      missing: Array<{ tier: AutoRoutingTier; provider: SupportedProvider }>;
    }
  /** The tier models share no endpoint, so no request can call the router. */
  | { kind: "no-shared-endpoint" };

/**
 * Decides the offer. A virtual key, or an OAuth client calling as the app,
 * reaches the routers it was given, on their own provider keys. Any other
 * credential reaches a router when every tier
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
  grantedRouterIds = null,
  routableModels,
  modelsPending,
}: {
  featureEnabled: boolean;
  routers: readonly OfferedRouter[] | null | undefined;
  /** The virtual key the example is for; null for any other credential. */
  virtualApiKeyId: string | null;
  /** The routers given to an OAuth client calling as the app; null for any other credential. */
  grantedRouterIds?: readonly string[] | null;
  routableModels: readonly RoutableModel[];
  modelsPending: boolean;
}): AutoRoutingOffer {
  if (!featureEnabled || !routers) return { kind: "none" };
  const ready = routers.filter(
    (router) =>
      router.enabled && TIERS.every((tier) => router.tiers[tier] !== null),
  );
  // Wait for the models rather than flash "unreachable".
  if (ready.length === 0 || modelsPending) return { kind: "none" };

  const usesRouterKeys = virtualApiKeyId !== null || grantedRouterIds !== null;
  const granted =
    virtualApiKeyId !== null
      ? ready.filter((router) =>
          router.virtualApiKeyIds.includes(virtualApiKeyId),
        )
      : grantedRouterIds !== null
        ? ready.filter((router) => grantedRouterIds.includes(router.id))
        : ready;

  const outcomes = granted.map((router) => ({
    router,
    outcome: routerOutcome(router, routableModels, usesRouterKeys),
  }));
  const available = outcomes.flatMap(({ router, outcome }) =>
    outcome.kind === "available"
      ? [
          {
            name: router.name,
            endpoint: outcome.endpoint,
            tiers: router.tiers as Record<AutoRoutingTier, OfferedTier>,
          },
        ]
      : [],
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
  // A credential given the router spends the router's own keys.
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
  grantedRouterIds = null,
  routableModels,
  modelsPending,
}: {
  enabled: boolean;
  virtualApiKeyId?: string | null;
  grantedRouterIds?: readonly string[] | null;
  routableModels: readonly RoutableModel[];
  modelsPending: boolean;
}): AutoRoutingOffer {
  const featureEnabled = useFeature("autoRoutingEnabled") === true;
  const { data: routers } = useAutoRouters({
    enabled: enabled && featureEnabled,
  });
  if (!enabled) return { kind: "none" };
  return autoRoutingOffer({
    featureEnabled,
    routers,
    virtualApiKeyId,
    grantedRouterIds,
    routableModels,
    modelsPending,
  });
}
