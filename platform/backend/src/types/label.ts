import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { UuidIdSchema } from "./api";

export const SelectLabelKeySchema = createSelectSchema(schema.labelKeysTable);
export const InsertLabelKeySchema = createInsertSchema(schema.labelKeysTable);

export const SelectLabelValueSchema = createSelectSchema(
  schema.labelValuesTable,
);
export const InsertLabelValueSchema = createInsertSchema(
  schema.labelValuesTable,
);

export const SelectAgentLabelSchema = createSelectSchema(
  schema.agentLabelsTable,
);
export const InsertAgentLabelSchema = createInsertSchema(
  schema.agentLabelsTable,
);

// Combined label schema for easier frontend consumption
export const AgentLabelWithDetailsSchema = z.object({
  key: z.string(),
  value: z.string(),
  keyId: UuidIdSchema.optional(),
  valueId: UuidIdSchema.optional(),
});

export type LabelKey = z.infer<typeof SelectLabelKeySchema>;
export type InsertLabelKey = z.infer<typeof InsertLabelKeySchema>;

export type LabelValue = z.infer<typeof SelectLabelValueSchema>;
export type InsertLabelValue = z.infer<typeof InsertLabelValueSchema>;

export type AgentLabel = z.infer<typeof SelectAgentLabelSchema>;
export type InsertAgentLabel = z.infer<typeof InsertAgentLabelSchema>;

export type AgentLabelWithDetails = z.infer<typeof AgentLabelWithDetailsSchema>;
