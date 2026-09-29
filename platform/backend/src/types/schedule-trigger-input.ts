import { z } from "zod";
import { UuidIdSchema } from "./api";
import {
  ScheduleTriggerConfigurationSchema,
  ScheduleTriggerConfigurationSchemaBase,
} from "./schedule-trigger";

const ScheduleTriggerBodyFieldsSchema = z.object({
  name: z.string().min(1),
  // Optional: callers without `agent:read` (e.g. a basic-user role) omit it and
  // the handler falls back to the org's default agent.
  agentId: UuidIdSchema.optional(),
  // Optional in the shared shape so updates can omit it; create requires it
  // (see CreateScheduleTriggerBodySchema) since a scheduled task is scoped to a
  // project.
  projectId: UuidIdSchema.optional(),
  enabled: z.boolean().optional(),
  ...ScheduleTriggerConfigurationSchemaBase.shape,
});

// A scheduled task is scoped to a project, so create requires projectId — the
// contract clients see, not just a runtime check.
export const CreateScheduleTriggerBodySchema =
  ScheduleTriggerBodyFieldsSchema.extend({
    projectId: UuidIdSchema,
    enabled: z.boolean().optional().default(true),
  }).superRefine((data, ctx) => {
    const result = ScheduleTriggerConfigurationSchema.safeParse(data);
    if (result.success) {
      return;
    }

    for (const issue of result.error.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: issue.message,
        path: issue.path,
      });
    }
  });

export const UpdateScheduleTriggerBodySchema =
  ScheduleTriggerBodyFieldsSchema.partial().superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one field must be provided",
      });
      return;
    }

    const result =
      ScheduleTriggerConfigurationSchemaBase.partial().safeParse(data);
    if (result.success) {
      return;
    }

    for (const issue of result.error.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: issue.message,
        path: issue.path,
      });
    }
  });
