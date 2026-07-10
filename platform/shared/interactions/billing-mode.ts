import { z } from "zod";

/**
 * Whether an LLM interaction's upstream fulfillment actually incurs a per-token
 * charge from the provider.
 *
 * - `metered`: the upstream call was (or would be) billed per token — a real
 *   provider API key, or a metered OAuth/workload-identity credential. This is
 *   the default and matches historical behavior.
 * - `subscription`: the traffic is covered by a flat-rate subscription and
 *   incurs NO per-token charge. The canonical case is Claude Code on a Max/Pro
 *   plan, whose OAuth token is forwarded upstream unchanged; Anthropic bills it
 *   against the subscription, not per token.
 *
 * The interaction's `cost` column is always kept as the list-price estimate
 * (what the usage WOULD cost at API rates), so nothing is lost. "Billed spend"
 * — the honest actual-cost figure shown in analytics — is `cost` for `metered`
 * rows and `0` for `subscription` rows.
 */
export const BillingModeSchema = z.enum(["metered", "subscription"]);

export type BillingMode = z.infer<typeof BillingModeSchema>;

/** Fallback used when no per-token billing signal is available. */
export const DEFAULT_BILLING_MODE: BillingMode = "metered";
