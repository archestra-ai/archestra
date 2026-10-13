import { get } from "lodash-es";

/**
 * The USD OpenRouter reports it billed, read from a response's `usage` block,
 * or undefined when it reports none.
 *
 * OpenRouter reports what it billed on every response (usage accounting is
 * always on). Prices vary by the upstream provider OpenRouter routed to, so
 * this is the real spend; the synced $/MTok list price is only an estimate.
 * Under BYOK `cost` is just OpenRouter's fee and the upstream provider's charge
 * to the user's own key comes back separately, so the two are added.
 * @see https://openrouter.ai/docs/use-cases/usage-accounting
 */
export function getOpenRouterReportedCost(
  rawUsage: unknown,
): number | undefined {
  const cost = get(rawUsage, "cost");
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    return undefined;
  }
  const upstreamCost = get(rawUsage, "cost_details.upstream_inference_cost");
  return get(rawUsage, "is_byok") === true &&
    typeof upstreamCost === "number" &&
    Number.isFinite(upstreamCost)
    ? cost + upstreamCost
    : cost;
}
