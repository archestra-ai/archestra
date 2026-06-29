import { z } from "zod";

export const ToonSkipReasonSchema = z.enum([
  "not_enabled",
  "not_effective",
  "no_tool_results",
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
}

/**
 * @deprecated Use ToolCompressionStats instead
 */
export interface ToonCompressionResult {
  tokensBefore: number | null;
  tokensAfter: number | null;
  costSavings: number | null;
}
