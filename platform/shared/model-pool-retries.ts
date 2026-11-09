import { z } from "zod";

const retryCount = z.number().int().min(0).max(10);

/** Additional attempts after the first failure, with per-error overrides.
 * Partial delays inherit from the pool/defaults; runtime caps the effective
 * initial delay at the effective maximum after merging.
 */
export const ModelPoolRetrySettingsSchema = z
  .object({
    numRetries: retryCount.optional(),
    retryPolicy: z
      .object({
        connectionError: retryCount.optional(),
        timeoutError: retryCount.optional(),
        rateLimitError: retryCount.optional(),
        internalServerError: retryCount.optional(),
      })
      .optional(),
    initialDelayMs: z.number().int().min(100).max(8000).optional(),
    maxDelayMs: z.number().int().min(100).max(60000).optional(),
  })
  .refine(
    (settings) =>
      settings.initialDelayMs === undefined ||
      settings.maxDelayMs === undefined ||
      settings.initialDelayMs <= settings.maxDelayMs,
    {
      message: "Initial retry delay must not exceed maximum retry delay",
      path: ["maxDelayMs"],
    },
  );

export type ModelPoolRetrySettings = z.infer<
  typeof ModelPoolRetrySettingsSchema
>;
