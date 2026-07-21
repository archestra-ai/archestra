import { type BillingMode, DEFAULT_BILLING_MODE } from "@archestra/shared";

/**
 * Resolve the billing mode of an LLM interaction from its upstream fulfillment.
 *
 * "Billing mode" records whether the upstream call actually incurs a per-token
 * charge (`metered`) or is covered by a flat-rate subscription (`subscription`).
 * The interaction's `cost` is always kept as the list-price estimate; billed
 * spend is `cost` for metered rows and 0 for subscription rows.
 *
 * Precedence:
 * 1. A DB-managed provider key (`chat_api_keys`) carries an admin-configured
 *    mode — authoritative. This covers in-app chat, model-router, and any org
 *    that stores a subscription/OAuth token AS an Archestra provider key.
 * 2. Raw client passthrough (no DB key): classified `subscription` only when the
 *    forwarded credential is an OAuth Bearer token AND the request is robustly
 *    attributed to a Claude client. Both conditions are required for soundness —
 *    see below.
 * 3. Otherwise `metered`.
 *
 * Why both conditions in (2): a forwarded Bearer alone is NOT a reliable
 * subscription signal — a client can forward a *metered* Bearer (e.g. an
 * Anthropic Workload Identity Federation token) through the passthrough, and
 * zeroing it would silently under-report real spend. Requiring the Claude-client
 * body signal (`isClaudeClientRequest`, derived from the request body, not a
 * spoofable header) excludes those flows, since WIF / non-Claude Bearer
 * passthrough carries no Claude billing-header. Within genuine Claude-client
 * traffic, an OAuth Bearer means a Max/Pro subscription while an `x-api-key`
 * means a metered API key, so the split is clean.
 */
export function resolveInteractionBillingMode(params: {
  /** The chat_api_keys row that fulfilled the call, if a DB-managed key was used. */
  providerApiKeyRow: { billingMode: BillingMode } | null | undefined;
  /** Whether the provider treats the resolved credential as a forwarded OAuth (subscription) token. */
  isForwardedSubscriptionCredential: boolean;
  /** Whether the request is robustly attributed to a Claude client (from the request body). */
  isClaudeClientRequest: boolean;
  /** Global kill-switch for automatic subscription detection (config flag). */
  autodetectEnabled: boolean;
}): BillingMode {
  if (params.providerApiKeyRow) {
    return params.providerApiKeyRow.billingMode;
  }

  if (
    params.autodetectEnabled &&
    params.isForwardedSubscriptionCredential &&
    params.isClaudeClientRequest
  ) {
    return "subscription";
  }

  return DEFAULT_BILLING_MODE;
}
