import {
  TOOL_CREATE_SCHEDULE_TRIGGER_SHORT_NAME,
  TOOL_DELETE_SCHEDULE_TRIGGER_SHORT_NAME,
  TOOL_DISABLE_SCHEDULE_TRIGGER_SHORT_NAME,
  TOOL_ENABLE_SCHEDULE_TRIGGER_SHORT_NAME,
  TOOL_GET_SCHEDULE_TRIGGER_RUN_SHORT_NAME,
  TOOL_GET_SCHEDULE_TRIGGER_SHORT_NAME,
  TOOL_LIST_SCHEDULE_TRIGGER_RUNS_SHORT_NAME,
  TOOL_LIST_SCHEDULE_TRIGGERS_SHORT_NAME,
  TOOL_RUN_SCHEDULE_TRIGGER_NOW_SHORT_NAME,
  TOOL_UPDATE_SCHEDULE_TRIGGER_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import logger from "@/logging";
import { ScheduleTriggerModel, ScheduleTriggerRunModel } from "@/models";
import { projectService } from "@/services/project";
import {
  findAccessibleScheduleTriggerOrThrow,
  findAccessibleScheduleTriggerRunOrThrow,
  isScheduledTaskAdmin,
  startManualScheduleTriggerRun,
} from "@/services/schedule-trigger-access";
import {
  createScheduleTrigger,
  updateScheduleTrigger,
} from "@/services/schedule-trigger-management";
import type { ScheduleTrigger, ScheduleTriggerRun } from "@/types";
import { ApiError, ScheduleTriggerRunStatusSchema } from "@/types";
import {
  CreateScheduleTriggerBodySchema,
  UpdateScheduleTriggerBodySchema,
} from "@/types/schedule-trigger-input";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

/** Cap on rows either list tool returns, so a busy org cannot flood the caller. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

const LimitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .optional()
  .describe(
    `How many rows to return, newest first (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
  );

const ScheduleTriggerSummarySchema = z.object({
  id: z
    .string()
    .describe("The trigger's id — pass it to get_schedule_trigger."),
  name: z.string().describe("The trigger's name."),
  agent_id: z.string().describe("Id of the agent the schedule runs."),
  agent_name: z.string().nullable().describe("Name of that agent."),
  project_id: z
    .string()
    .nullable()
    .describe("Project the schedule belongs to, when it is project-scoped."),
  cron_expression: z
    .string()
    .describe("5-part cron expression driving the schedule."),
  timezone: z
    .string()
    .describe("IANA timezone the cron expression is read in."),
  enabled: z
    .boolean()
    .describe("Whether the schedule is currently picked up when due."),
  last_executed_at: z
    .string()
    .nullable()
    .describe(
      "ISO 8601 timestamp of the last time the schedule fired, or null if it " +
        "never has. Compare with run history when checking schedule activity.",
    ),
  actor_user_id: z.string().describe("The user the scheduled run executes as."),
  actor_name: z.string().nullable().describe("Display name of that user."),
  created_at: z.string().describe("ISO 8601 creation timestamp."),
});

const ListScheduleTriggersOutputSchema = z.object({
  schedule_triggers: z
    .array(ScheduleTriggerSummarySchema)
    .describe("Matching schedules, newest first."),
});

const GetScheduleTriggerOutputSchema = ScheduleTriggerSummarySchema.extend({
  message_template: z
    .string()
    .describe("The prompt sent to the agent on every run."),
});

const ScheduleTriggerRunSummarySchema = z.object({
  id: z
    .string()
    .describe("The run's id — pass it to get_schedule_trigger_run."),
  trigger_id: z.string().describe("Id of the schedule this run belongs to."),
  run_kind: z
    .enum(["due", "manual"])
    .describe("`due` = fired by the schedule; `manual` = started by a person."),
  status: ScheduleTriggerRunStatusSchema.describe(
    "running | success | failed | cancelled.",
  ),
  started_at: z
    .string()
    .nullable()
    .describe("ISO 8601 timestamp the run started."),
  completed_at: z
    .string()
    .nullable()
    .describe("ISO 8601 timestamp the run settled; null while still running."),
  error: z
    .string()
    .nullable()
    .describe(
      "Failure text when the run failed or was skipped — for example a run " +
        "skipped because the previous one was still in progress.",
    ),
  chat_conversation_id: z
    .string()
    .nullable()
    .describe("Chat conversation holding the run's transcript, when linked."),
  runtime_task_id: z
    .string()
    .nullable()
    .describe("Agent Runtime task id, when the run executed on the runtime."),
  created_at: z.string().describe("ISO 8601 creation timestamp."),
});

const ListScheduleTriggerRunsOutputSchema = z.object({
  runs: z
    .array(ScheduleTriggerRunSummarySchema)
    .describe("Matching runs, newest first."),
});

const ScheduleFieldsSchema = z.object({
  name: z.string().min(1).describe("Name of the scheduled task."),
  project_id: z
    .string()
    .uuid()
    .describe("Project containing the scheduled task."),
  agent_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Agent to run. Defaults to the project's agent, then the organization default.",
    ),
  cron_expression: z
    .string()
    .min(1)
    .describe("Cron expression, for example 0 9 * * 1-5."),
  timezone: z
    .string()
    .min(1)
    .describe("IANA timezone, for example America/Toronto."),
  message_template: z
    .string()
    .min(1)
    .describe("Prompt sent to the agent on each run."),
  enabled: z
    .boolean()
    .optional()
    .describe("Whether the schedule is enabled. Defaults to true on creation."),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_CREATE_SCHEDULE_TRIGGER_SHORT_NAME,
    title: "Create Scheduled Task",
    description:
      "Create a scheduled agent task in a project you can access. It runs as you. Use list_projects to find the project id.",
    schema: ScheduleFieldsSchema.strict(),
    outputSchema: GetScheduleTriggerOutputSchema,
    async handler({ args, context }) {
      const identity = requireUserContext(context);
      if ("error" in identity) return identity.error;
      try {
        const trigger = await createScheduleTrigger({
          ...identity,
          body: CreateScheduleTriggerBodySchema.parse(toScheduleBody(args)),
        });
        return structuredSuccessResult({
          ...toTriggerSummary(trigger),
          message_template: trigger.messageTemplate,
        });
      } catch (error) {
        return apiErrorOr(error, "create scheduled task");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_UPDATE_SCHEDULE_TRIGGER_SHORT_NAME,
    title: "Update Scheduled Task",
    description:
      "Edit a scheduled task. Only its actor or a scheduled-task administrator may edit it. Omitted fields retain their values.",
    schema: ScheduleFieldsSchema.partial()
      .extend({ schedule_trigger_id: z.string().uuid() })
      .strict(),
    outputSchema: GetScheduleTriggerOutputSchema,
    async handler({ args, context }) {
      const identity = requireUserContext(context);
      if ("error" in identity) return identity.error;
      try {
        const trigger = await updateScheduleTrigger({
          ...identity,
          id: args.schedule_trigger_id,
          body: UpdateScheduleTriggerBodySchema.parse(toScheduleBody(args)),
        });
        return structuredSuccessResult({
          ...toTriggerSummary(trigger),
          message_template: trigger.messageTemplate,
        });
      } catch (error) {
        return apiErrorOr(error, "update scheduled task");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_DELETE_SCHEDULE_TRIGGER_SHORT_NAME,
    title: "Delete Scheduled Task",
    description:
      "Delete a scheduled task and its run history. Only its actor or a scheduled-task administrator may delete it.",
    schema: z.object({ schedule_trigger_id: z.string().uuid() }).strict(),
    outputSchema: z.object({ success: z.boolean() }),
    async handler({ args, context }) {
      const identity = requireUserContext(context);
      if ("error" in identity) return identity.error;
      try {
        const trigger = await findAccessibleScheduleTriggerOrThrow({
          ...identity,
          id: args.schedule_trigger_id,
          access: "mutate",
        });
        const success = await ScheduleTriggerModel.delete(trigger.id);
        if (!success) throw new ApiError(404, "Schedule trigger not found");
        return structuredSuccessResult({ success });
      } catch (error) {
        return apiErrorOr(error, "delete scheduled task");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_LIST_SCHEDULE_TRIGGERS_SHORT_NAME,
    title: "List Scheduled Tasks",
    description:
      "List the scheduled agent triggers the caller can see: which agent each " +
      "one runs, its cron expression and timezone, whether it is enabled, and " +
      "when it last fired. Use run history to investigate missed or failed runs. Defaults to the caller's own schedules; pass project_id " +
      "for a project's schedules, or include_all_users to sweep the whole " +
      "organization (requires organization-wide scheduled-task access).",
    schema: z
      .object({
        project_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Only schedules of this project. Shows every member's schedules " +
              "for it, so long as the caller can access the project.",
          ),
        enabled: z
          .boolean()
          .optional()
          .describe("Only enabled (true) or only disabled (false) schedules."),
        agent_id: z
          .string()
          .uuid()
          .optional()
          .describe("Only schedules that run this agent."),
        include_all_users: z
          .boolean()
          .optional()
          .describe(
            "Include other members' schedules. Ignored unless the caller holds " +
              "organization-wide scheduled-task access.",
          ),
        limit: LimitSchema,
      })
      .strict(),
    outputSchema: ListScheduleTriggersOutputSchema,
    async handler({ args, context }) {
      const identity = requireUserContext(context);
      if ("error" in identity) return identity.error;
      const { userId, organizationId } = identity;

      try {
        // Mirrors GET /api/schedule-triggers: the caller's own schedules by
        // default, the whole org only for a scheduled-task admin, and a
        // project's schedules once the project read has authorized them.
        let actorUserId: string | undefined = userId;

        if (args.project_id) {
          await projectService.get({
            id: args.project_id,
            organizationId,
            userId,
            allowAdminOversight: true,
          });
          actorUserId = undefined;
        } else if (
          args.include_all_users &&
          (await isScheduledTaskAdmin({ userId, organizationId }))
        ) {
          actorUserId = undefined;
        }

        const triggers = await ScheduleTriggerModel.listByOrganization({
          organizationId,
          limit: args.limit ?? DEFAULT_LIMIT,
          enabled: args.enabled,
          agentIds: args.agent_id ? [args.agent_id] : undefined,
          actorUserId,
          projectId: args.project_id,
        });

        const summaries = triggers.map(toTriggerSummary);
        return structuredSuccessResult(
          { schedule_triggers: summaries },
          summaries.length === 0
            ? "No scheduled tasks matched."
            : summaries
                .map(
                  (t) =>
                    `${t.name} (id=${t.id}, agent=${t.agent_name ?? t.agent_id}, ` +
                    `cron="${t.cron_expression}" ${t.timezone}, ` +
                    `${t.enabled ? "enabled" : "disabled"}, ` +
                    `last run ${t.last_executed_at ?? "never"})`,
                )
                .join("\n"),
        );
      } catch (error) {
        return apiErrorOr(error, "listing scheduled tasks");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_GET_SCHEDULE_TRIGGER_SHORT_NAME,
    title: "Get Scheduled Task",
    description:
      "Read one scheduled agent trigger, including the message template sent " +
      "to the agent on every run. Use list_schedule_triggers to find the id.",
    schema: z
      .object({
        schedule_trigger_id: z
          .string()
          .uuid()
          .describe("Id of the schedule to read."),
      })
      .strict(),
    outputSchema: GetScheduleTriggerOutputSchema,
    async handler({ args, context }) {
      const identity = requireUserContext(context);
      if ("error" in identity) return identity.error;

      try {
        const trigger = await findAccessibleScheduleTriggerOrThrow({
          id: args.schedule_trigger_id,
          userId: identity.userId,
          organizationId: identity.organizationId,
          access: "read",
        });
        return structuredSuccessResult({
          ...toTriggerSummary(trigger),
          message_template: trigger.messageTemplate,
        });
      } catch (error) {
        return apiErrorOr(error, "reading the scheduled task");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_LIST_SCHEDULE_TRIGGER_RUNS_SHORT_NAME,
    title: "List Scheduled Task Runs",
    description:
      "List a scheduled task's run history, newest first: whether each run " +
      "was due or manual, how it ended, when it started and completed, its " +
      "failure text, and the chat conversation holding its transcript. This " +
      "is how you confirm a schedule actually ran rather than trusting that " +
      "it was enabled.",
    schema: z
      .object({
        schedule_trigger_id: z
          .string()
          .uuid()
          .describe("Id of the schedule whose runs to list."),
        status: ScheduleTriggerRunStatusSchema.optional().describe(
          "Only runs in this state.",
        ),
        limit: LimitSchema,
      })
      .strict(),
    outputSchema: ListScheduleTriggerRunsOutputSchema,
    async handler({ args, context }) {
      const identity = requireUserContext(context);
      if ("error" in identity) return identity.error;
      const { userId, organizationId } = identity;

      try {
        const trigger = await findAccessibleScheduleTriggerOrThrow({
          id: args.schedule_trigger_id,
          userId,
          organizationId,
          access: "read",
        });
        const runs = await ScheduleTriggerRunModel.listByTrigger({
          organizationId,
          triggerId: trigger.id,
          limit: args.limit ?? DEFAULT_LIMIT,
          status: args.status,
        });

        const summaries = runs.map(toRunSummary);
        return structuredSuccessResult(
          { runs: summaries },
          summaries.length === 0
            ? `No runs recorded for "${trigger.name}".`
            : summaries
                .map(
                  (r) =>
                    `${r.started_at ?? r.created_at} ${r.run_kind} → ${r.status}` +
                    (r.error ? ` (${r.error})` : "") +
                    ` [id=${r.id}]`,
                )
                .join("\n"),
        );
      } catch (error) {
        return apiErrorOr(error, "listing scheduled task runs");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_GET_SCHEDULE_TRIGGER_RUN_SHORT_NAME,
    title: "Get Scheduled Task Run",
    description:
      "Read one run of a scheduled task, including its full error text. Use " +
      "list_schedule_trigger_runs to find the run id.",
    schema: z
      .object({
        schedule_trigger_id: z
          .string()
          .uuid()
          .describe("Id of the schedule the run belongs to."),
        run_id: z.string().uuid().describe("Id of the run to read."),
      })
      .strict(),
    outputSchema: ScheduleTriggerRunSummarySchema,
    async handler({ args, context }) {
      const identity = requireUserContext(context);
      if ("error" in identity) return identity.error;

      try {
        const run = await findAccessibleScheduleTriggerRunOrThrow({
          triggerId: args.schedule_trigger_id,
          runId: args.run_id,
          userId: identity.userId,
          organizationId: identity.organizationId,
          access: "read",
        });
        return structuredSuccessResult(toRunSummary(run));
      } catch (error) {
        return apiErrorOr(error, "reading the scheduled task run");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_ENABLE_SCHEDULE_TRIGGER_SHORT_NAME,
    title: "Enable Scheduled Task",
    description:
      "Enable a scheduled task so it is picked up again when due. Only the " +
      "user the schedule runs as, or someone with organization-wide " +
      "scheduled-task access, may change it.",
    schema: z
      .object({
        schedule_trigger_id: z
          .string()
          .uuid()
          .describe("Id of the schedule to enable."),
      })
      .strict(),
    outputSchema: ScheduleTriggerSummarySchema,
    async handler({ args, context }) {
      return await setEnabled({ args, context, enabled: true });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_DISABLE_SCHEDULE_TRIGGER_SHORT_NAME,
    title: "Disable Scheduled Task",
    description:
      "Disable a scheduled task so it stops firing, leaving its configuration " +
      "and run history intact. Only the user the schedule runs as, or someone " +
      "with organization-wide scheduled-task access, may change it.",
    schema: z
      .object({
        schedule_trigger_id: z
          .string()
          .uuid()
          .describe("Id of the schedule to disable."),
      })
      .strict(),
    outputSchema: ScheduleTriggerSummarySchema,
    async handler({ args, context }) {
      return await setEnabled({ args, context, enabled: false });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_RUN_SCHEDULE_TRIGGER_NOW_SHORT_NAME,
    title: "Run Scheduled Task Now",
    description:
      "Start a scheduled task immediately, outside its cron schedule. The run " +
      "is queued and returns straight away with status `running` — poll " +
      "get_schedule_trigger_run for the outcome. The run executes as the user " +
      "the schedule is configured to act as, so only that user or someone with " +
      "organization-wide scheduled-task access may start it.",
    schema: z
      .object({
        schedule_trigger_id: z
          .string()
          .uuid()
          .describe("Id of the schedule to run."),
      })
      .strict(),
    outputSchema: ScheduleTriggerRunSummarySchema,
    async handler({ args, context }) {
      const identity = requireUserContext(context);
      if ("error" in identity) return identity.error;

      try {
        const trigger = await findAccessibleScheduleTriggerOrThrow({
          id: args.schedule_trigger_id,
          userId: identity.userId,
          organizationId: identity.organizationId,
          access: "mutate",
        });
        const run = await startManualScheduleTriggerRun({
          trigger,
          initiatedByUserId: identity.userId,
        });
        logger.info(
          { triggerId: trigger.id, runId: run.id },
          "run_schedule_trigger_now tool started a manual run",
        );
        return structuredSuccessResult(
          toRunSummary(run),
          `Started "${trigger.name}" (run id=${run.id}). Poll get_schedule_trigger_run for the outcome.`,
        );
      } catch (error) {
        return apiErrorOr(error, "starting the scheduled task");
      }
    },
  }),
]);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

// === Internal helpers ===

/**
 * Every schedule read is scoped to the acting user (the trigger's actor, a
 * project member, or a scheduled-task admin), so there is no meaningful
 * organization-only answer for an application credential.
 */
function requireUserContext(
  context: ArchestraContext,
):
  | { userId: string; organizationId: string }
  | { error: ReturnType<typeof errorResult> } {
  if (!context.userId || !context.organizationId) {
    return {
      error: errorResult(
        "This tool requires an authenticated user context. Call it with a user token.",
      ),
    };
  }
  return { userId: context.userId, organizationId: context.organizationId };
}

/** Surfaces the actionable 403/404 verbatim; anything else stays generic. */
function apiErrorOr(error: unknown, action: string) {
  if (error instanceof z.ZodError)
    return errorResult(error.issues.map((issue) => issue.message).join("; "));
  if (error instanceof ApiError) {
    return errorResult(error.message);
  }
  return catchError(error, action);
}

async function setEnabled(params: {
  args: { schedule_trigger_id: string };
  context: ArchestraContext;
  enabled: boolean;
}) {
  const identity = requireUserContext(params.context);
  if ("error" in identity) return identity.error;

  const verb = params.enabled ? "enabling" : "disabling";
  try {
    const trigger = await findAccessibleScheduleTriggerOrThrow({
      id: params.args.schedule_trigger_id,
      userId: identity.userId,
      organizationId: identity.organizationId,
      access: "mutate",
    });
    const updated = await ScheduleTriggerModel.update(trigger.id, {
      enabled: params.enabled,
    });
    if (!updated) {
      return errorResult("Schedule trigger not found");
    }
    return structuredSuccessResult(
      toTriggerSummary(updated),
      `${params.enabled ? "Enabled" : "Disabled"} "${updated.name}".`,
    );
  } catch (error) {
    return apiErrorOr(error, `${verb} the scheduled task`);
  }
}

function toTriggerSummary(trigger: ScheduleTrigger) {
  return {
    id: trigger.id,
    name: trigger.name,
    agent_id: trigger.agentId,
    agent_name: trigger.agent?.name ?? null,
    project_id: trigger.projectId ?? null,
    cron_expression: trigger.cronExpression,
    timezone: trigger.timezone,
    enabled: trigger.enabled,
    last_executed_at: trigger.lastExecutedAt?.toISOString() ?? null,
    actor_user_id: trigger.actorUserId,
    actor_name: trigger.actor?.name ?? null,
    created_at: trigger.createdAt.toISOString(),
  };
}

function toRunSummary(run: ScheduleTriggerRun) {
  return {
    id: run.id,
    trigger_id: run.triggerId,
    run_kind: run.runKind,
    status: run.status,
    started_at: run.startedAt?.toISOString() ?? null,
    completed_at: run.completedAt?.toISOString() ?? null,
    error: run.error ?? null,
    chat_conversation_id: run.chatConversationId ?? null,
    runtime_task_id: run.runtimeTaskId ?? null,
    created_at: run.createdAt.toISOString(),
  };
}

function toScheduleBody(
  args:
    | z.infer<typeof ScheduleFieldsSchema>
    | Partial<z.infer<typeof ScheduleFieldsSchema>>,
) {
  return Object.fromEntries(
    Object.entries({
      name: args.name,
      projectId: args.project_id,
      agentId: args.agent_id,
      cronExpression: args.cron_expression,
      timezone: args.timezone,
      messageTemplate: args.message_template,
      enabled: args.enabled,
    }).filter(([, value]) => value !== undefined),
  );
}
