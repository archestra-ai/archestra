import type { SupportedProvider } from "@archestra/shared";
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

/** What the request example offers for auto routing. */
export type AutoRoutingOffer =
  /** Nothing: the alpha is off, or auto routing is off and the viewer can't set it up. */
  | { kind: "none" }
  /** Auto routing is off or has no model for a tier; the viewer can set it up. */
  | { kind: "setup" }
  /** The credential can call `auto`. */
  | { kind: "available" }
  /** Auto routing is on, but the credential can't reach these tier models. */
  | {
      kind: "unreachable";
      missing: Array<{ tier: AutoRoutingTier; provider: SupportedProvider }>;
    };

/**
 * Decides the offer. A tier counts as reachable when its model is among the
 * models the example can already pick for this credential, the same list the
 * model picker shows.
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
  /** Provider-qualified ids, like `openai:gpt-5.5`. */
  routableModels: readonly string[];
  modelsPending: boolean;
}): AutoRoutingOffer {
  if (!featureEnabled || !settings) return { kind: "none" };
  const tiers = TIERS.map((tier) => ({ tier, model: settings.tiers[tier] }));
  if (!settings.enabled || tiers.some(({ model }) => !model)) {
    return canConfigure ? { kind: "setup" } : { kind: "none" };
  }
  // Wait for the models rather than flash "unreachable".
  if (modelsPending) return { kind: "none" };
  const missing = tiers.flatMap(({ tier, model }) =>
    model && !routableModels.includes(`${model.provider}:${model.modelId}`)
      ? [{ tier, provider: model.provider }]
      : [],
  );
  return missing.length > 0
    ? { kind: "unreachable", missing }
    : { kind: "available" };
}

export function useAutoRoutingOffer({
  enabled,
  routableModels,
  modelsPending,
}: {
  enabled: boolean;
  routableModels: readonly string[];
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
