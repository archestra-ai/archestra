import type { SupportedProvider } from "@archestra/shared";
import { isPersonalSubscription } from "@/lib/llm-key-subscription";
import type { LlmProviderApiKey } from "@/lib/llm-provider-api-keys.query";

/** A connection as the company fields list it. */
export type ConnectionKey = Pick<
  LlmProviderApiKey,
  "id" | "name" | "provider"
> &
  Partial<Pick<LlmProviderApiKey, "subscriptionKind" | "scope">>;

/**
 * No company connection can run the agent yet, and none is set or fixed:
 * the fields give way to a line that says so and a button that adds one.
 * Nothing else about the fields applies then, so the lines beside them wait
 * for a connection too.
 */
export function noCompanyConnection(params: {
  keys: ConnectionKey[];
  apiKeyId: string | null;
  runsOn: (provider: SupportedProvider) => boolean;
  sharedOnly?: boolean;
  connectionFixed?: boolean;
  lockedConnection?: { name: string } | null;
}): boolean {
  if (
    params.connectionFixed ||
    params.lockedConnection ||
    companyConnectionIdOf(params.keys, params.apiKeyId)
  ) {
    return false;
  }
  return !params.keys.some(
    (key) =>
      !isPersonalSubscription(key) &&
      !(params.sharedOnly && key.scope === "personal") &&
      params.runsOn(key.provider),
  );
}

/**
 * The connection the company fields show. The agent's own key can be
 * somebody's personal subscription, on an agent that runs only on
 * subscriptions. That is nobody's company connection: the fields then show
 * none, and ask for one.
 */
export function companyConnectionIdOf(
  keys: ConnectionKey[],
  apiKeyId: string | null,
): string | null {
  return keys.some((key) => key.id === apiKeyId && isPersonalSubscription(key))
    ? null
    : apiKeyId;
}
