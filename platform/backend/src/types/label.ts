import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectLabelKeySchema = createSelectSchema(schema.labelKeyTable);
export const InsertLabelKeySchema = createInsertSchema(schema.labelKeyTable);

export const SelectLabelValueSchema = createSelectSchema(
  schema.labelValueTable,
);
export const InsertLabelValueSchema = createInsertSchema(
  schema.labelValueTable,
);

export const SelectAgentLabelSchema = createSelectSchema(
  schema.agentLabelTable,
);
export const InsertAgentLabelSchema = createInsertSchema(
  schema.agentLabelTable,
);

// Combined label schema for easier frontend consumption
export const AgentLabelWithDetailsSchema = z.object({
  key: z.string(),
  value: z.string(),
  keyId: z.string().uuid().optional(),
  valueId: z.string().uuid().optional(),
});

export type LabelKey = z.infer<typeof SelectLabelKeySchema>;
export type InsertLabelKey = z.infer<typeof InsertLabelKeySchema>;

export type LabelValue = z.infer<typeof SelectLabelValueSchema>;
export type InsertLabelValue = z.infer<typeof InsertLabelValueSchema>;

export type AgentLabel = z.infer<typeof SelectAgentLabelSchema>;
export type InsertAgentLabel = z.infer<typeof InsertAgentLabelSchema>;

export type AgentLabelWithDetails = z.infer<typeof AgentLabelWithDetailsSchema>;
