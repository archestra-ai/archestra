import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const AgentRunShareVisibilitySchema = z.enum([
  "organization",
  "team",
  "user",
]);

export const SelectAgentRunShareSchema = createSelectSchema(
  schema.agentRunSharesTable,
);

export const InsertAgentRunShareSchema = createInsertSchema(
  schema.agentRunSharesTable,
).omit({
  id: true,
  createdAt: true,
});

export const SelectAgentRunShareWithTargetsSchema =
  SelectAgentRunShareSchema.extend({
    teamIds: z.array(z.string()),
    userIds: z.array(z.string()),
  });

export type AgentRunShare = z.infer<typeof SelectAgentRunShareSchema>;
export type InsertAgentRunShare = z.infer<typeof InsertAgentRunShareSchema>;
export type AgentRunShareVisibility = z.infer<
  typeof AgentRunShareVisibilitySchema
>;
export type AgentRunShareWithTargets = z.infer<
  typeof SelectAgentRunShareWithTargetsSchema
>;
