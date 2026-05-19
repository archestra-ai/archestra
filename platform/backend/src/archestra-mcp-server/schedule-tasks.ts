import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  TOOL_CREATE_SCHEDULED_TASK_SHORT_NAME,
  TOOL_DELETE_SCHEDULED_TASK_SHORT_NAME,
  TOOL_LIST_SCHEDULED_TASKS_SHORT_NAME,
  TOOL_UPDATE_SCHEDULED_TASK_SHORT_NAME,
} from "@shared";
import { z } from "zod";
import { hasAnyAgentTypeAdminPermission, userHasPermission } from "@/auth";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  ConversationModel,
  ScheduleTriggerModel,
} from "@/models";
import {
  type Agent,
  type ScheduleTrigger,
  ScheduleTriggerConfigurationSchema,
  ScheduleTriggerConfigurationSchemaBase,
  UuidIdSchema,
} from "@/types";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";

// === Constants ===

const ScheduledTaskNameSchema = z.string().trim().min(1).max(200);

const CreateScheduledTaskArgsSchema = z
  .object({
    name: ScheduledTaskNameSchema.describe(
      "Short human-readable label for the task (e.g. 'Daily shave reminder').",
    ),
    messageTemplate: z
      .string()
      .trim()
      .min(1)
      .describe(
        "The exact prompt the agent will execute each time the schedule fires. Write it as if you were the user asking the agent to do the thing (e.g. 'Remind me to shave.').",
      ),
    cronExpression: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Standard 5-field cron expression in the user's timezone. Examples: '0 7 * * *' (every day at 7am), '0 9 * * 1-5' (weekday mornings at 9am), '0 */6 * * *' (every 6 hours).",
      ),
    timezone: z
      .string()
      .trim()
      .min(1)
      .describe(
        "IANA timezone for the cron schedule (e.g. 'America/New_York', 'Asia/Kolkata', 'UTC'). REQUIRED — do not guess. If you do not know the user's timezone from context, ask them before calling this tool.",
      ),
    agentId: UuidIdSchema.optional().describe(
      "Optional internal agent ID that should run the scheduled prompt. Defaults to the current chat's agent — only set this if the user explicitly names a different agent.",
    ),
  })
  .strict()
  .superRefine((data, ctx) => {
    const result = ScheduleTriggerConfigurationSchema.safeParse({
      cronExpression: data.cronExpression,
      timezone: data.timezone,
      messageTemplate: data.messageTemplate,
    });
    if (result.success) return;
    for (const issue of result.error.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: issue.message,
        path: issue.path,
      });
    }
  });

const ScheduledTaskOutputSchema = z.object({
  id: z.string().describe("The scheduled task id."),
  name: z.string().describe("The task name."),
  agentId: z.string().describe("The agent assigned to run the task."),
  cronExpression: z.string().describe("The cron expression."),
  timezone: z.string().describe("The IANA timezone."),
  messageTemplate: z.string().describe("The prompt run on each fire."),
  enabled: z.boolean().describe("Whether the task is currently enabled."),
});

const CreateScheduledTaskOutputSchema = z.object({
  success: z.literal(true).describe("Whether the schedule was created."),
  scheduleTriggerId: z.string().describe("The ID of the new scheduled task."),
  name: z.string().describe("The scheduled task name."),
  agentId: z.string().describe("The agent ID assigned to run the task."),
  cronExpression: z.string().describe("The cron expression that was stored."),
  timezone: z.string().describe("The timezone that was stored."),
});

const ListScheduledTasksArgsSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Optional case-insensitive name filter. Use when the user references a task by name and you need to find its id.",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe("Maximum number of tasks to return. Defaults to 20."),
  })
  .strict();

const ListScheduledTasksOutputSchema = z.object({
  total: z.number().describe("How many tasks were returned."),
  tasks: z.array(ScheduledTaskOutputSchema),
});

const UpdateScheduledTaskArgsSchema = z
  .object({
    id: UuidIdSchema.describe(
      "The scheduled task id. Look it up with list_scheduled_tasks if the user references the task by name.",
    ),
    name: ScheduledTaskNameSchema.optional().describe("New name for the task."),
    messageTemplate:
      ScheduleTriggerConfigurationSchemaBase.shape.messageTemplate
        .optional()
        .describe("New prompt the agent will execute when the task fires."),
    cronExpression: ScheduleTriggerConfigurationSchemaBase.shape.cronExpression
      .optional()
      .describe(
        "New 5-field cron expression (in the task's timezone). If you change the cron without changing the timezone, the existing timezone is preserved.",
      ),
    timezone: ScheduleTriggerConfigurationSchemaBase.shape.timezone
      .optional()
      .describe(
        "New IANA timezone for the schedule (e.g. 'America/New_York'). Do not guess — ask the user if unknown.",
      ),
    agentId: UuidIdSchema.optional().describe(
      "Optional new internal agent id to run the task. Only set if the user explicitly asks to move the task to a different agent.",
    ),
    enabled: z
      .boolean()
      .optional()
      .describe(
        "Set to false to pause the task without deleting it, or true to resume.",
      ),
  })
  .strict()
  .superRefine((data, ctx) => {
    const onlyId =
      data.name === undefined &&
      data.messageTemplate === undefined &&
      data.cronExpression === undefined &&
      data.timezone === undefined &&
      data.agentId === undefined &&
      data.enabled === undefined;
    if (onlyId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pass at least one field besides id to update.",
      });
    }
  });

const DeleteScheduledTaskArgsSchema = z
  .object({
    id: UuidIdSchema.describe(
      "The scheduled task id to delete. Look it up with list_scheduled_tasks if the user references the task by name.",
    ),
  })
  .strict();

const DeleteScheduledTaskOutputSchema = z.object({
  success: z.literal(true),
  id: z.string().describe("The id of the deleted task."),
  name: z.string().describe("The name of the deleted task."),
  agentId: z.string().describe("The agent that had been assigned to the task."),
  cronExpression: z
    .string()
    .describe("The cron expression the task had at deletion time."),
  timezone: z.string().describe("The timezone the task had at deletion time."),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_CREATE_SCHEDULED_TASK_SHORT_NAME,
    title: "Create Scheduled Task",
    description:
      "Create a scheduled task that runs a chat prompt on a cron schedule. Use this when the user asks for recurring reminders, periodic reports, or anything that should repeat on a timeline (e.g. 'remind me to X every morning', 'send a weekly summary'). Always confirm the schedule back to the user in your reply (e.g. 'Done — I'll run this every weekday at 9am Eastern.'). If the user's timezone is not known, ask before calling.",
    schema: CreateScheduledTaskArgsSchema,
    outputSchema: CreateScheduledTaskOutputSchema,
    async handler({ args, context }) {
      const { userId, organizationId, agent: contextAgent } = context;

      if (!userId || !organizationId) {
        return errorResult(
          "Cannot create a scheduled task without a logged-in user context.",
        );
      }

      // Re-read conversations.agentId in case swap_agent fired earlier in 
      // this same tool round; context.agentId is captured at turn start and 
      // stays stale until the next turn.
      let targetAgentId = args.agentId;
      if (!targetAgentId && context.conversationId) {
        const conversation = await ConversationModel.findById({
          id: context.conversationId,
          userId,
          organizationId,
        });
        if (conversation) {
          targetAgentId = conversation.agentId ?? undefined;
        }
      }
      targetAgentId ??= context.agentId ?? contextAgent.id;
      if (!targetAgentId) {
        return errorResult(
          "No agent is associated with this chat — cannot create a scheduled task.",
        );
      }

      logger.info(
        {
          callerAgentId: contextAgent.id,
          targetAgentId,
          conversationId: context.conversationId ?? null,
          userId,
          organizationId,
          cronExpression: args.cronExpression,
          timezone: args.timezone,
        },
        "create_scheduled_task tool called",
      );

      try {
        const accessibleAgent = await loadAgentForCaller({
          agentId: targetAgentId,
          userId,
          organizationId,
        });
        if ("error" in accessibleAgent) return accessibleAgent.error;

        const trigger = await ScheduleTriggerModel.create({
          organizationId,
          name: args.name,
          agentId: accessibleAgent.agent.id,
          messageTemplate: args.messageTemplate,
          cronExpression: args.cronExpression,
          timezone: args.timezone,
          enabled: true,
          actorUserId: userId,
        });

        return structuredSuccessResult({
          success: true,
          scheduleTriggerId: trigger.id,
          name: trigger.name,
          agentId: trigger.agentId,
          cronExpression: trigger.cronExpression,
          timezone: trigger.timezone,
        });
      } catch (error) {
        return catchError(error, "creating scheduled task");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_LIST_SCHEDULED_TASKS_SHORT_NAME,
    title: "List Scheduled Tasks",
    description:
      "List the user's existing scheduled tasks, optionally filtered by name. Use this when the user references a task by name (e.g. 'change my shave reminder') and you need to look up its id before calling update_scheduled_task or delete_scheduled_task.",
    schema: ListScheduledTasksArgsSchema,
    outputSchema: ListScheduledTasksOutputSchema,
    async handler({ args, context }) {
      const { userId, organizationId, agent: contextAgent } = context;

      if (!userId || !organizationId) {
        return errorResult(
          "Cannot list scheduled tasks without a logged-in user context.",
        );
      }

      logger.info(
        { agentId: contextAgent.id, userId, listArgs: args },
        "list_scheduled_tasks tool called",
      );

      try {
        const triggers = await ScheduleTriggerModel.listByOrganization({
          organizationId,
          limit: args.limit ?? 20,
          name: args.name,
          actorUserId: userId,
        });

        const output = {
          total: triggers.length,
          tasks: triggers.map(toolOutputForTrigger),
        };

        return structuredSuccessResult(output, JSON.stringify(output, null, 2));
      } catch (error) {
        return catchError(error, "listing scheduled tasks");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_UPDATE_SCHEDULED_TASK_SHORT_NAME,
    title: "Update Scheduled Task",
    description:
      "Update an existing scheduled task. All fields besides id are optional; only provided fields are changed. Use enabled=false to pause a task without deleting it. If you only have the task's name, call list_scheduled_tasks first to get its id.",
    schema: UpdateScheduledTaskArgsSchema,
    outputSchema: ScheduledTaskOutputSchema,
    async handler({ args, context }) {
      const { userId, organizationId, agent: contextAgent } = context;

      if (!userId || !organizationId) {
        return errorResult(
          "Cannot update a scheduled task without a logged-in user context.",
        );
      }

      logger.info(
        { agentId: contextAgent.id, userId, taskId: args.id },
        "update_scheduled_task tool called",
      );

      try {
        const existing = await loadAccessibleTrigger({
          id: args.id,
          userId,
          organizationId,
        });
        if ("error" in existing) return existing.error;

        if (args.agentId && args.agentId !== existing.trigger.agentId) {
          const newAgent = await loadAgentForCaller({
            agentId: args.agentId,
            userId,
            organizationId,
          });
          if ("error" in newAgent) return newAgent.error;

          const actorIsAgentAdmin = await hasAnyAgentTypeAdminPermission({
            userId: existing.trigger.actorUserId,
            organizationId,
          });
          const actorHasAgentAccess = await AgentTeamModel.userHasAgentAccess(
            existing.trigger.actorUserId,
            newAgent.agent.id,
            actorIsAgentAdmin,
          );

          if (!actorHasAgentAccess) {
            return errorResult(
              "The stored task actor must have access to the selected agent.",
            );
          }
        }

        // Validate cron + timezone together (one may be omitted; the other
        // stays at the existing value).
        const cronExpression =
          args.cronExpression ?? existing.trigger.cronExpression;
        const timezone = args.timezone ?? existing.trigger.timezone;
        const messageTemplate =
          args.messageTemplate ?? existing.trigger.messageTemplate;
        const validation = ScheduleTriggerConfigurationSchema.safeParse({
          cronExpression,
          timezone,
          messageTemplate,
        });
        if (!validation.success) {
          const firstIssue = validation.error.issues[0];
          return errorResult(
            firstIssue?.message ?? "Invalid schedule trigger configuration",
          );
        }

        const updated = await ScheduleTriggerModel.update(args.id, {
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.messageTemplate !== undefined
            ? { messageTemplate: args.messageTemplate }
            : {}),
          ...(args.cronExpression !== undefined
            ? { cronExpression: args.cronExpression }
            : {}),
          ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
          ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
          ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        });

        if (!updated) {
          return errorResult("Scheduled task not found.");
        }

        return structuredSuccessResult(toolOutputForTrigger(updated));
      } catch (error) {
        return catchError(error, "updating scheduled task");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_DELETE_SCHEDULED_TASK_SHORT_NAME,
    title: "Delete Scheduled Task",
    description:
      "Delete a scheduled task. Use this when the user wants to cancel a recurring task. If you only have the task's name, call list_scheduled_tasks first to get its id. Be conservative — confirm the task name back to the user in your reply.",
    schema: DeleteScheduledTaskArgsSchema,
    outputSchema: DeleteScheduledTaskOutputSchema,
    async handler({ args, context }) {
      const { userId, organizationId, agent: contextAgent } = context;

      if (!userId || !organizationId) {
        return errorResult(
          "Cannot delete a scheduled task without a logged-in user context.",
        );
      }

      logger.info(
        { agentId: contextAgent.id, userId, taskId: args.id },
        "delete_scheduled_task tool called",
      );

      try {
        const existing = await loadAccessibleTrigger({
          id: args.id,
          userId,
          organizationId,
        });
        if ("error" in existing) return existing.error;

        const deleted = await ScheduleTriggerModel.delete(args.id);
        if (!deleted) {
          const stillExists = await ScheduleTriggerModel.findById(args.id);
          if (stillExists) {
            return errorResult("Scheduled task not found.");
          }
        }

        return structuredSuccessResult({
          success: true,
          id: args.id,
          name: existing.trigger.name,
          agentId: existing.trigger.agentId,
          cronExpression: existing.trigger.cronExpression,
          timezone: existing.trigger.timezone,
        });
      } catch (error) {
        return catchError(error, "deleting scheduled task");
      }
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;

// === Exports ===

export const tools = registry.tools;

// === Internal helpers ===

function toolOutputForTrigger(trigger: ScheduleTrigger) {
  return {
    id: trigger.id,
    name: trigger.name,
    agentId: trigger.agentId,
    cronExpression: trigger.cronExpression,
    timezone: trigger.timezone,
    messageTemplate: trigger.messageTemplate,
    enabled: trigger.enabled,
  };
}

async function loadAgentForCaller(params: {
  agentId: string;
  userId: string;
  organizationId: string;
}): Promise<{ error: CallToolResult } | { agent: Agent }> {
  const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
    userId: params.userId,
    organizationId: params.organizationId,
  });

  const agent = await AgentModel.findById(
    params.agentId,
    params.userId,
    isAgentAdmin,
  );

  if (!agent) {
    return {
      error: errorResult(
        "You do not have access to the selected agent, or it does not exist.",
      ),
    };
  }

  if (
    agent.organizationId !== params.organizationId ||
    agent.agentType !== "agent"
  ) {
    return {
      error: errorResult(
        "Scheduled tasks can only target internal agents in your organization.",
      ),
    };
  }

  return { agent };
}

async function loadAccessibleTrigger(params: {
  id: string;
  userId: string;
  organizationId: string;
}): Promise<{ error: CallToolResult } | { trigger: ScheduleTrigger }> {
  const trigger = await ScheduleTriggerModel.findById(params.id);
  if (!trigger || trigger.organizationId !== params.organizationId) {
    return { error: errorResult("Scheduled task not found.") };
  }

  if (trigger.actorUserId === params.userId) {
    return { trigger };
  }

  const isScheduledTaskAdmin = await userHasPermission(
    params.userId,
    params.organizationId,
    "scheduledTask",
    "admin",
  );
  if (isScheduledTaskAdmin) {
    return { trigger };
  }

  return {
    error: errorResult("You do not have access to this scheduled task."),
  };
}
