import { TOOL_CREATE_SCHEDULED_TASK_SHORT_NAME } from "@shared";
import { z } from "zod";
import { hasAnyAgentTypeAdminPermission } from "@/auth";
import logger from "@/logging";
import { AgentModel, ScheduleTriggerModel } from "@/models";
import { ScheduleTriggerConfigurationSchema, UuidIdSchema } from "@/types";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";

// === Constants ===

const CreateScheduledTaskArgsSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe(
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

const CreateScheduledTaskOutputSchema = z.object({
  success: z.literal(true).describe("Whether the schedule was created."),
  scheduleTriggerId: z.string().describe("The ID of the new scheduled task."),
  name: z.string().describe("The scheduled task name."),
  agentId: z.string().describe("The agent ID assigned to run the task."),
  cronExpression: z.string().describe("The cron expression that was stored."),
  timezone: z.string().describe("The timezone that was stored."),
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

      const targetAgentId = args.agentId ?? context.agentId ?? contextAgent.id;
      if (!targetAgentId) {
        return errorResult(
          "No agent is associated with this chat — cannot create a scheduled task.",
        );
      }

      logger.info(
        {
          callerAgentId: contextAgent.id,
          targetAgentId,
          userId,
          organizationId,
          cronExpression: args.cronExpression,
          timezone: args.timezone,
        },
        "create_scheduled_task tool called",
      );

      try {
        const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
          userId,
          organizationId,
        });

        const agent = await AgentModel.findById(
          targetAgentId,
          userId,
          isAgentAdmin,
        );
        if (!agent) {
          return errorResult(
            "You do not have access to the selected agent, or it does not exist.",
          );
        }

        if (
          agent.organizationId !== organizationId ||
          agent.agentType !== "agent"
        ) {
          return errorResult(
            "Scheduled tasks can only target internal agents in your organization.",
          );
        }

        const trigger = await ScheduleTriggerModel.create({
          organizationId,
          name: args.name,
          agentId: targetAgentId,
          messageTemplate: args.messageTemplate,
          cronExpression: args.cronExpression,
          timezone: args.timezone,
          enabled: true,
          actorUserId: userId,
        });

        return structuredSuccessResult(
          {
            success: true,
            scheduleTriggerId: trigger.id,
            name: trigger.name,
            agentId: trigger.agentId,
            cronExpression: trigger.cronExpression,
            timezone: trigger.timezone,
          },
          `Scheduled task "${trigger.name}" created (id: ${trigger.id}). It will run on cron "${trigger.cronExpression}" in ${trigger.timezone}.`,
        );
      } catch (error) {
        return catchError(error, "creating scheduled task");
      }
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;

// === Exports ===

export const tools = registry.tools;
