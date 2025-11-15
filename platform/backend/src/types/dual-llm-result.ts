import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

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
