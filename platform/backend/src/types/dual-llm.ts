import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export interface CommonDualLlmParams {
  /** The tool call ID for tracking */
  toolCallId: string;
  /** The original user request */
  userRequest: string;
  /** The tool result to be analyzed */
  toolResult: unknown;
}

export const SelectDualLlmConfigSchema = createSelectSchema(
  schema.dualLlmConfigsTable,
);
export const InsertDualLlmConfigSchema = createInsertSchema(
  schema.dualLlmConfigsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type DualLlmConfig = z.infer<typeof SelectDualLlmConfigSchema>;
export type InsertDualLlmConfig = z.infer<typeof InsertDualLlmConfigSchema>;

export const DualLlmMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })
  .describe(
    "Simple message format used in dual LLM Q&A conversation. Provider-agnostic format for storing conversations.",
  );

export const SelectDualLlmResultSchema = createSelectSchema(
  schema.dualLlmResultsTable,
);

export const InsertDualLlmResultSchema = createInsertSchema(
  schema.dualLlmResultsTable,
);

export type DualLlmMessage = z.infer<typeof DualLlmMessageSchema>;
export type DualLlmResult = z.infer<typeof SelectDualLlmResultSchema>;
export type InsertDualLlmResult = z.infer<typeof InsertDualLlmResultSchema>;
