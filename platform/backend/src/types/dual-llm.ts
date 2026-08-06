import { z } from "zod";

export interface CommonDualLlmParams {
  toolCallId: string;
  userRequest: string;
  toolResult: unknown;
  /**
   * Name and arguments of the tool call that produced the result under
   * analysis. Both were authored by the privileged calling agent (not by the
   * untrusted result), so they are safe to show to the main agent and anchor
   * its questioning to the right domain.
   */
  toolName: string;
  toolArguments?: Record<string, unknown>;
}

export const DualLlmMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })
  .describe(
    "Provider-agnostic transcript entry for the built-in Dual LLM workflow.",
  );

export const DualLlmAnalysisSchema = z.object({
  toolCallId: z.string(),
  conversations: z.array(DualLlmMessageSchema),
  result: z.string(),
});

export type DualLlmMessage = z.infer<typeof DualLlmMessageSchema>;
export type DualLlmAnalysis = z.infer<typeof DualLlmAnalysisSchema>;
