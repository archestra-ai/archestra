import { z } from "zod";

export const ToonSkipReasonSchema = z.enum([
  "not_enabled",
  "not_effective",
  "no_tool_results",
  "addon_unavailable",
]);
export type ToonSkipReason = z.infer<typeof ToonSkipReasonSchema>;

export interface ToolCompressionStats {
  /** Total tokens before compression (always counted, even if compression not applied) */
  tokensBefore: number;
  /** Total tokens after compression (equals tokensBefore if compression not applied) */
  tokensAfter: number;
  /** Cost savings from compression (0 if no savings) */
  costSavings: number;
  /**
   * Indicates if tool result compression gave savings on tokens.
   * True when tokensAfter < tokensBefore.
   */
  wasEffective: boolean;
  /** Whether there were any tool results to compress */
  hadToolResults: boolean;
  /**
   * Set when compression could not run at all (native addon unavailable —
   * an infrastructure failure, not an outcome of trying). Takes precedence
   * over the reasons the handler derives from the count fields, so the
   * interaction is never misreported as not_effective/no_tool_results.
   */
  skipReason?: Extract<ToonSkipReason, "addon_unavailable">;
}

/**
 * @deprecated Use ToolCompressionStats instead
 */
export interface ToonCompressionResult {
  tokensBefore: number | null;
  tokensAfter: number | null;
  costSavings: number | null;
}
