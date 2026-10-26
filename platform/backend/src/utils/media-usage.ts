import type { UsageView } from "@/types/llm-provider";

/** Audit-only marker: provider-supplied values are removed before ours is added. */
export function withMediaUsageAvailability(
  response: unknown,
  usage: UsageView,
): unknown {
  if (!response || typeof response !== "object" || Array.isArray(response))
    return response;
  const { __mediaUsage: _untrusted, ...record } = response as Record<
    string,
    unknown
  >;
  return {
    ...record,
    ...(usage.usageUnavailable || usage.costUnavailable
      ? {
          __mediaUsage: {
            tokensAvailable: !usage.usageUnavailable,
            costAvailable: false,
          },
        }
      : {}),
  };
}

export function hasUnavailableMediaCost(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  const marker = (response as Record<string, unknown>).__mediaUsage;
  return (
    !!marker &&
    typeof marker === "object" &&
    (marker as Record<string, unknown>).costAvailable === false
  );
}
