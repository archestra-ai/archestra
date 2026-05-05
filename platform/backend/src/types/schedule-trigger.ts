import {
  type ScheduleTriggerReplyChannel,
  ScheduleTriggerReplyChannelSchema,
} from "@shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import {
  createCron,
  FORM_SHAPE_CRON_ERROR_MESSAGE,
  isFormShapeCron,
  isValidTimezone,
  normalizeCronExpression,
  normalizeTimezone,
} from "@/schedule-triggers/utils";

export { ScheduleTriggerReplyChannelSchema, type ScheduleTriggerReplyChannel };

export const ScheduleTriggerRunKindSchema = z.enum(["due", "manual"]);
export type ScheduleTriggerRunKind = z.infer<
  typeof ScheduleTriggerRunKindSchema
>;

export const ScheduleTriggerRunStatusSchema = z.enum([
  "running",
  "success",
  "failed",
]);
export type ScheduleTriggerRunStatus = z.infer<
  typeof ScheduleTriggerRunStatusSchema
>;

export const ScheduleTriggerActorSummarySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
});

export const ScheduleTriggerAgentSummarySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  agentType: z.string().nullable(),
});

export const ScheduleTriggerSuggestionAgentCandidateSchema = z.object({
  agent: z.object({
    id: z.string(),
    name: z.string(),
    icon: z.string().nullable(),
  }),
  interactionCount: z.number().int().nonnegative(),
  lastUsedAt: z.coerce.date(),
});

export const ScheduleTriggerSuggestionReasonSchema = z.enum([
  "explicit",
  "last-interaction",
  "current-conversation-agent",
  "member-default",
  "org-default",
  "none",
]);

export const ScheduleTriggerSuggestionSchema = z.object({
  suggestedAgentId: z.string().nullable(),
  candidates: z.array(ScheduleTriggerSuggestionAgentCandidateSchema),
  reason: ScheduleTriggerSuggestionReasonSchema,
  suggestedName: z.string(),
  suggestedMessageTemplate: z.string(),
  suggestedMessageTemplatePreview: z.string(),
});

export type ScheduleTriggerSuggestion = z.infer<
  typeof ScheduleTriggerSuggestionSchema
>;

export const ScheduleTriggerConfigurationSchemaBase = z.object({
  cronExpression: z.string().min(1),
  timezone: z.string().min(1),
  messageTemplate: z.string().min(1),
});

export const ScheduleTriggerConfigurationSchema =
  ScheduleTriggerConfigurationSchemaBase.superRefine(
    validateScheduleTriggerFields,
  );

export const SelectScheduleTriggerSchema = createSelectSchema(
  schema.scheduleTriggersTable,
).extend({
  actor: ScheduleTriggerActorSummarySchema.nullable().optional(),
  agent: ScheduleTriggerAgentSummarySchema.nullable().optional(),
});

export const InsertScheduleTriggerSchema = createInsertSchema(
  schema.scheduleTriggersTable,
  {
    replyChannel: ScheduleTriggerReplyChannelSchema.optional(),
  },
)
  .omit({
    id: true,
    createdAt: true,
  })
  .superRefine(validateScheduleTriggerFields);

export const UpdateScheduleTriggerSchema = createUpdateSchema(
  schema.scheduleTriggersTable,
  {
    replyChannel: ScheduleTriggerReplyChannelSchema.optional(),
  },
)
  .omit({
    id: true,
    createdAt: true,
  })
  .superRefine((data, ctx) => {
    if (data.cronExpression !== undefined || data.timezone !== undefined) {
      validateScheduleTriggerFields(
        {
          cronExpression: data.cronExpression,
          timezone: data.timezone,
        },
        ctx,
      );
    }
  });

const selectRunExtendedFields = {
  runKind: ScheduleTriggerRunKindSchema,
  status: ScheduleTriggerRunStatusSchema,
};

const insertRunExtendedFields = {
  runKind: ScheduleTriggerRunKindSchema,
  status: ScheduleTriggerRunStatusSchema.optional(),
};

export const SelectScheduleTriggerRunSchema = createSelectSchema(
  schema.scheduleTriggerRunsTable,
  selectRunExtendedFields,
);

export const InsertScheduleTriggerRunSchema = createInsertSchema(
  schema.scheduleTriggerRunsTable,
  insertRunExtendedFields,
).omit({
  id: true,
  createdAt: true,
});

export const UpdateScheduleTriggerRunSchema = createUpdateSchema(
  schema.scheduleTriggerRunsTable,
  insertRunExtendedFields,
).omit({
  id: true,
  createdAt: true,
});

export type ScheduleTrigger = z.infer<typeof SelectScheduleTriggerSchema>;
export type InsertScheduleTrigger = z.infer<typeof InsertScheduleTriggerSchema>;
export type UpdateScheduleTrigger = z.infer<typeof UpdateScheduleTriggerSchema>;

export type ScheduleTriggerRun = z.infer<typeof SelectScheduleTriggerRunSchema>;
export type InsertScheduleTriggerRun = z.infer<
  typeof InsertScheduleTriggerRunSchema
>;
export type UpdateScheduleTriggerRun = z.infer<
  typeof UpdateScheduleTriggerRunSchema
>;

function validateScheduleTriggerFields(
  data: {
    cronExpression?: string | null;
    timezone?: string | null;
  },
  ctx: z.RefinementCtx,
) {
  const cronExpression = data.cronExpression?.trim();
  const timezone = data.timezone?.trim();

  if (!cronExpression) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Cron expression is required",
      path: ["cronExpression"],
    });
  }

  if (!timezone) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Timezone is required",
      path: ["timezone"],
    });
    return;
  }

  if (!isValidTimezone(timezone)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Timezone must be a valid IANA timezone",
      path: ["timezone"],
    });
    return;
  }

  if (!cronExpression) {
    return;
  }

  const normalizedCron = normalizeCronExpression(cronExpression);

  try {
    createCron({
      cronExpression: normalizedCron,
      timezone: normalizeTimezone(timezone),
    });
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        error instanceof Error ? error.message : "Invalid cron expression",
      path: ["cronExpression"],
    });
    return;
  }

  if (!isFormShapeCron(normalizedCron)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: FORM_SHAPE_CRON_ERROR_MESSAGE,
      path: ["cronExpression"],
    });
  }
}
