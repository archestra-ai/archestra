"use client";

import type { AutoRoutingOffer } from "@/components/use-auto-routing-offer";
import { useModelProviderCatalog } from "@/lib/integration-overrides";

/** Under the model field, when auto routing is on: why no auto router is listed. */
export function AutoRoutingUnavailableHint({
  offer,
}: {
  offer: AutoRoutingOffer;
}) {
  const providerCatalog = useModelProviderCatalog();
  if (offer.kind === "no-shared-endpoint") {
    return (
      <p className="text-xs text-muted-foreground">
        Auto routing is on, but its models don't share an API endpoint, so no
        request can use it.
      </p>
    );
  }
  if (offer.kind !== "unreachable") return null;
  const tiers = offer.missing.map(({ tier }) => tier).join(" or ");
  const providers = [...new Set(offer.missing.map((m) => m.provider))]
    .map((provider) => providerCatalog.label(provider))
    .join(", ");
  return (
    <p className="text-xs text-muted-foreground">
      Auto routing is on, but this credential can't reach its {tiers}{" "}
      {offer.missing.length === 1 ? "model" : "models"}. It needs access to{" "}
      {providers}.
    </p>
  );
}
