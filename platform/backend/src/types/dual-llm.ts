import { z } from "zod";

export interface CommonDualLlmParams {
  toolCallId: string;
  userRequest: string;
  toolResult: unknown;
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
