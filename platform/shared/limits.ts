import { z } from "zod";

/**
 * Sentinel element used inside a `limits.model` JSONB array to indicate that the
 * limit covers spend across every model, not a specific set.
 */
export const ALL_MODELS_SENTINEL = "*";

export const LimitTypeSchema = z.enum(["token_cost"]);
export type LimitType = z.infer<typeof LimitTypeSchema>;

export function validateLimitShape(data: {
  limitType: LimitType;
  model?: string[] | null | undefined;
}): boolean {
  if (data.limitType === "token_cost") {
    if (!data.model || !Array.isArray(data.model) || data.model.length === 0) {
      return false;
    }
    if (data.model.includes(ALL_MODELS_SENTINEL) && data.model.length !== 1) {
      return false;
    }
  }
  return true;
}
