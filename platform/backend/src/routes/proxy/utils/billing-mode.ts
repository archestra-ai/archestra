import { type BillingMode, DEFAULT_BILLING_MODE } from "@archestra/shared";

/**
 * Resolve the billing mode of an LLM interaction from the credential that
 * fulfilled it.
 *
 * "Billing mode" records whether the upstream call actually incurs a per-token
 * charge (`metered`) or is covered by a flat-rate subscription (`subscription`).
 * The interaction's `cost` is always kept as the list-price estimate; billed
 * spend is `cost` for metered rows and 0 for subscription rows.
 *
 * Classification is purely by credential format, via the provider adapter's
 * `isSubscriptionCredential`: Anthropic OAuth access tokens (Claude Pro/Max —
 * what Claude Code forwards) are `sk-ant-oat…` while metered API keys are
 * `sk-ant-api…`, so the token itself says how the call is billed. This applies
 * uniformly to raw client passthrough, virtual-key, and DB-managed keys — no
 * per-key configuration is needed. Providers without a format marker never
 * classify as subscription, so real metered spend is never silently zeroed.
 */
export function resolveInteractionBillingMode(params: {
  /** Format-based judgment from the provider adapter for the resolved credential. */
  isSubscriptionCredential: boolean;
  /** Global kill-switch for automatic subscription detection (config flag). */
  autodetectEnabled: boolean;
}): BillingMode {
  if (params.autodetectEnabled && params.isSubscriptionCredential) {
    return "subscription";
  }
  return DEFAULT_BILLING_MODE;
}
