import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const AgentScheduleTriggerTypeSchema = z.enum([
  "cron",
  "interval",
  "one_time",
]);
export type AgentScheduleTriggerType = z.infer<
  typeof AgentScheduleTriggerTypeSchema
>;

export const SelectAgentScheduleTriggerSchema = createSelectSchema(
  schema.agentScheduleTriggersTable,
  {
    triggerType: AgentScheduleTriggerTypeSchema,
  },
);

export const InsertAgentScheduleTriggerSchema = createInsertSchema(
  schema.agentScheduleTriggersTable,
  {
    triggerType: AgentScheduleTriggerTypeSchema,
    name: z.string().min(1).max(255),
    cronExpression: z.string().max(255).optional(),
    message: z.string().max(10000).optional(),
  },
).omit({ id: true, createdAt: true, updatedAt: true });

export const UpdateAgentScheduleTriggerSchema = createUpdateSchema(
  schema.agentScheduleTriggersTable,
  {
    triggerType: AgentScheduleTriggerTypeSchema.optional(),
    name: z.string().min(1).max(255).optional(),
    cronExpression: z.string().max(255).optional(),
    message: z.string().max(10000).optional(),
  },
).pick({
  name: true,
  triggerType: true,
  enabled: true,
  cronExpression: true,
  intervalSeconds: true,
  scheduledAt: true,
  message: true,
  misfireGraceSeconds: true,
  lastExecutedAt: true,
  nextExecutionAt: true,
  executionCount: true,
  lastError: true,
});

export const CreateAgentScheduleTriggerBodySchema = z
  .object({
    agentId: z.string().uuid(),
    name: z.string().min(1).max(255),
    triggerType: AgentScheduleTriggerTypeSchema,
    enabled: z.boolean().optional().default(true),
    cronExpression: z.string().max(255).optional(),
    intervalSeconds: z.number().int().min(60).optional(),
    scheduledAt: z.string().datetime().optional(),
    message: z.string().max(10000).optional().default(""),
    misfireGraceSeconds: z.number().int().min(0).optional().default(300),
  })
  .refine(
    (data) => {
      if (data.triggerType === "cron") return !!data.cronExpression;
      if (data.triggerType === "interval") return !!data.intervalSeconds;
      if (data.triggerType === "one_time") return !!data.scheduledAt;
      return false;
    },
    {
      message:
        "cron requires cronExpression, interval requires intervalSeconds, one_time requires scheduledAt",
    },
  );

export const UpdateAgentScheduleTriggerBodySchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    triggerType: AgentScheduleTriggerTypeSchema.optional(),
    enabled: z.boolean().optional(),
    cronExpression: z.string().max(255).optional(),
    intervalSeconds: z.number().int().min(60).optional(),
    scheduledAt: z.string().datetime().optional(),
    message: z.string().max(10000).optional(),
    misfireGraceSeconds: z.number().int().min(0).optional(),
  })
  .strict();

export type AgentScheduleTrigger = z.infer<
  typeof SelectAgentScheduleTriggerSchema
>;
export type InsertAgentScheduleTrigger = z.infer<
  typeof InsertAgentScheduleTriggerSchema
>;
export type UpdateAgentScheduleTrigger = z.infer<
  typeof UpdateAgentScheduleTriggerSchema
>;
