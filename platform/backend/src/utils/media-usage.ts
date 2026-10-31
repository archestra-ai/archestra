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
    ...(usage.usageUnavailable || usage.costUnavailable || usage.mediaTariff
      ? {
          __mediaUsage: {
            tokensAvailable: !usage.usageUnavailable,
            costAvailable: !usage.usageUnavailable && !usage.costUnavailable,
          },
        }
      : {}),
  };
}

/**
 * Whether a recorded response is a media operation's. Its counts are not chat
 * tokens, so per-token tariffs and token quotas must not price them.
 */
export function isMediaUsage(response: unknown): boolean {
  return (
    !!response &&
    typeof response === "object" &&
    !!(response as Record<string, unknown>).__mediaUsage
  );
}
