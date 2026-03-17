import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const ScheduleTriggerTypeSchema = z.enum(["cron", "interval", "once"]);
export type ScheduleTriggerType = z.infer<typeof ScheduleTriggerTypeSchema>;

export const ScheduleTriggerStatusSchema = z.enum([
  "success",
  "error",
  "running",
]);
export type ScheduleTriggerStatus = z.infer<typeof ScheduleTriggerStatusSchema>;

const selectExtendedFields = {
  triggerType: ScheduleTriggerTypeSchema,
};

const insertExtendedFields = {
  triggerType: ScheduleTriggerTypeSchema,
};

export const SelectScheduleTriggerSchema = createSelectSchema(
  schema.agentScheduleTriggersTable,
  selectExtendedFields,
);

export const InsertScheduleTriggerSchema = createInsertSchema(
  schema.agentScheduleTriggersTable,
  insertExtendedFields,
)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    lastExecutedAt: true,
    nextExecuteAt: true,
    lastStatus: true,
    lastError: true,
    executionCount: true,
  })
  .superRefine((data, ctx) => {
    if (data.triggerType === "cron" && !data.cronExpression) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cronExpression is required for cron trigger type",
        path: ["cronExpression"],
      });
    }
    if (data.triggerType === "interval" && !data.intervalSeconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "intervalSeconds is required for interval trigger type",
        path: ["intervalSeconds"],
      });
    }
    if (
      data.triggerType === "interval" &&
      data.intervalSeconds != null &&
      data.intervalSeconds < 10
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "intervalSeconds must be at least 10",
        path: ["intervalSeconds"],
      });
    }
    if (data.triggerType === "once" && !data.executeAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "executeAt is required for once trigger type",
        path: ["executeAt"],
      });
    }
  });

export const UpdateScheduleTriggerSchema = createUpdateSchema(
  schema.agentScheduleTriggersTable,
  insertExtendedFields,
)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    createdBy: true,
    agentId: true,
    organizationId: true,
    lastExecutedAt: true,
    nextExecuteAt: true,
    lastStatus: true,
    lastError: true,
    executionCount: true,
  })
  .partial();

export const CreateScheduleTriggerBodySchema = z
  .object({
    name: z.string().min(1).max(255),
    triggerType: ScheduleTriggerTypeSchema,
    cronExpression: z.string().optional(),
    intervalSeconds: z.number().int().min(10).optional(),
    executeAt: z.string().datetime().optional(),
    timezone: z.string().default("UTC"),
    inputMessage: z.string().min(1),
    enabled: z.boolean().default(true),
    misfireGraceSeconds: z.number().int().min(0).default(60),
  })
  .superRefine((data, ctx) => {
    if (data.triggerType === "cron" && !data.cronExpression) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cronExpression is required for cron trigger type",
        path: ["cronExpression"],
      });
    }
    if (data.triggerType === "interval" && !data.intervalSeconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "intervalSeconds is required for interval trigger type",
        path: ["intervalSeconds"],
      });
    }
    if (data.triggerType === "once" && !data.executeAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "executeAt is required for once trigger type",
        path: ["executeAt"],
      });
    }
  });

export const UpdateScheduleTriggerBodySchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    triggerType: ScheduleTriggerTypeSchema.optional(),
    cronExpression: z.string().nullable().optional(),
    intervalSeconds: z.number().int().min(10).nullable().optional(),
    executeAt: z.string().datetime().nullable().optional(),
    timezone: z.string().optional(),
    inputMessage: z.string().min(1).optional(),
    misfireGraceSeconds: z.number().int().min(0).optional(),
  })
  .partial();

export const ScheduleTriggerResponseSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  organizationId: z.string(),
  name: z.string(),
  triggerType: ScheduleTriggerTypeSchema,
  cronExpression: z.string().nullable(),
  intervalSeconds: z.number().nullable(),
  executeAt: z.string().datetime().nullable(),
  timezone: z.string(),
  inputMessage: z.string(),
  enabled: z.boolean(),
  misfireGraceSeconds: z.number(),
  lastExecutedAt: z.string().datetime().nullable(),
  nextExecuteAt: z.string().datetime().nullable(),
  lastStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  executionCount: z.number(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ScheduleTrigger = z.infer<typeof SelectScheduleTriggerSchema>;
export type InsertScheduleTrigger = z.infer<typeof InsertScheduleTriggerSchema>;
export type UpdateScheduleTrigger = z.infer<typeof UpdateScheduleTriggerSchema>;
