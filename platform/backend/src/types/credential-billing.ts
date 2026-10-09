import { z } from "zod";
import { LimitCleanupIntervalSchema } from "./limit";

/**
 * Spend cap a caller asks for on a virtual key or LLM OAuth client. Stored as
 * an ordinary `token_cost` limit on the credential, covering all models.
 */
export const CredentialSpendCapInputSchema = z.object({
  /** Dollars per window. */
  limitValue: z.number().int().positive(),
  cleanupInterval: LimitCleanupIntervalSchema,
});

export const CredentialSpendCapSchema = CredentialSpendCapInputSchema.extend({
  limitId: z.string(),
  /** Billed spend in the current window, in dollars. */
  currentUsage: z.number(),
});

export const CredentialBillingTeamSchema = z.object({
  id: z.string(),
  name: z.string(),
});

/** Billing fields every virtual key and LLM OAuth client response carries. */
export const CredentialBillingSchema = z.object({
  billingTeam: CredentialBillingTeamSchema.nullable(),
  spendCap: CredentialSpendCapSchema.nullable(),
});

export type CredentialSpendCapInput = z.infer<
  typeof CredentialSpendCapInputSchema
>;
export type CredentialSpendCap = z.infer<typeof CredentialSpendCapSchema>;
export type CredentialBillingTeam = z.infer<typeof CredentialBillingTeamSchema>;
export type CredentialBilling = z.infer<typeof CredentialBillingSchema>;
