import type { AutoRoutingSettings } from "@/lib/auto-routing.query";
import { useLlmModels } from "@/lib/llm-models.query";
import { parseTierModelIds } from "./plan-document";
import type { TierName } from "./tiers";

/** The models a fit's tiers fingerprint names, which the current tiers may no longer be. */
export function useFittedTierModels(
  tiersFingerprint: unknown,
  savedTiers: AutoRoutingSettings["tiers"],
): Record<TierName, string> {
  const { data: models = [] } = useLlmModels();
  const ids = parseTierModelIds(tiersFingerprint);
  const saved = Object.values(savedTiers);
  const name = (id: string) =>
    models.find((model) => model.dbId === id)?.id ??
    saved.find((tier) => tier?.id === id)?.modelId ??
    id;
  return {
    fast: ids ? name(ids[0]) : "unknown",
    normal: ids ? name(ids[1]) : "unknown",
    smart: ids ? name(ids[2]) : "unknown",
  };
}
