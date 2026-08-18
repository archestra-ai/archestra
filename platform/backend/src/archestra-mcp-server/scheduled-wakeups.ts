import {
  TOOL_CANCEL_SCHEDULED_WAKEUP_SHORT_NAME,
  TOOL_LIST_SCHEDULED_WAKEUPS_SHORT_NAME,
  TOOL_SCHEDULE_WAKEUP_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import { ConversationModel, ScheduleTriggerModel } from "@/models";
import {
  createCron,
  isValidTimezone,
  normalizeCronExpression,
  normalizeTimezone,
} from "@/utils/schedule-trigger";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

/**
 * Scheduled wakeups: the model schedules its own future turns in the CURRENT
 * conversation — a one-shot "remind me at 5pm" or a recurring "check this
 * every morning". Each wakeup is an ordinary `schedule_triggers` row targeting
 * the conversation; when it fires, the run handler delivers a wake
 * notification through `conversationWakeService` and a wake turn runs
 * (browser-streamed when the user is watching, headless otherwise).
 *
 * Guard rails, deliberately: cron wakeups may not fire more often than every
 * 5 minutes, each conversation holds at most 10 enabled wakeups, and locked
 * chats get none (server-side delivery can never write into them).
 */

// === Internal ===

/** Every wakeup turn is a full LLM run — keep recurrence sane. */
const MIN_CRON_INTERVAL_MS = 5 * 60 * 1000;
/** At most this many enabled wakeups per conversation. */
const MAX_ENABLED_WAKEUPS_PER_CONVERSATION = 10;
/** One-shots must fire within a year — beyond that it's a typo, not a plan. */
const MAX_ONE_SHOT_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

const WakeupSchema = z.object({
  wakeupId: z
    .string()
    .describe("The wakeup's id (for cancel_scheduled_wakeup)."),
  name: z.string().describe("Short human-readable label."),
  prompt: z.string().describe("What the wakeup turn will be asked to do."),
  recurring: z
    .boolean()
    .describe("True for cron wakeups, false for one-shots."),
  cron: z
    .string()
    .nullable()
    .describe("The cron expression (recurring wakeups)."),
  runAt: z
    .string()
    .nullable()
    .describe("The one-shot fire time (ISO), null for recurring wakeups."),
  timezone: z.string().describe("IANA timezone the schedule is evaluated in."),
  enabled: z
    .boolean()
    .describe("False once a one-shot has fired or the wakeup was disabled."),
  quiet: z
    .boolean()
    .describe("Monitor mode: no-change replies collapse to a muted line."),
  lastFiredAt: z
    .string()
    .nullable()
    .describe("When the wakeup last fired, null if never."),
});

function resolveWakeupCaller(
  context: ArchestraContext,
):
  | { conversationId: string; userId: string; agentId: string }
  | { error: ReturnType<typeof errorResult> } {
  const userId = context.userId ?? context.tokenAuth?.userId;
  if (
    !context.conversationId ||
    !context.agentId ||
    !userId ||
    userId === "system"
  ) {
    return {
      error: errorResult(
        "Scheduled wakeups exist only in interactive chat conversations.",
      ),
    };
  }
  return {
    conversationId: context.conversationId,
    userId,
    agentId: context.agentId,
  };
}

/**
 * Reject cron expressions that fire more often than the floor. Sampling the
 * next few occurrences is a practical check, not a proof — a schedule whose
 * sampled gaps all clear the floor is accepted.
 */
function validateCronInterval(params: {
  cronExpression: string;
  timezone: string;
}): string | null {
  const cron = createCron(params);
  const runs = cron.nextRuns(6);
  for (let i = 1; i < runs.length; i++) {
    if (runs[i].getTime() - runs[i - 1].getTime() < MIN_CRON_INTERVAL_MS) {
      return "Cron wakeups may not fire more often than every 5 minutes.";
    }
  }
  if (runs.length === 0) {
    return "That cron expression never fires.";
  }
  return null;
}

function deriveWakeupName(prompt: string): string {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  return normalized.length > 60
    ? `${normalized.slice(0, 57).trimEnd()}...`
    : normalized || "Scheduled wakeup";
}

function toWakeupOutput(row: {
  id: string;
  name: string;
  messageTemplate: string;
  cronExpression: string | null;
  runAt: Date | null;
  timezone: string;
  enabled: boolean;
  quiet: boolean;
  lastExecutedAt: Date | null;
}) {
  return {
    wakeupId: row.id,
    name: row.name,
    prompt: row.messageTemplate,
    recurring: row.runAt === null,
    cron: row.cronExpression,
    runAt: row.runAt ? row.runAt.toISOString() : null,
    timezone: row.timezone,
    enabled: row.enabled,
    quiet: row.quiet,
    lastFiredAt: row.lastExecutedAt ? row.lastExecutedAt.toISOString() : null,
  };
}

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_SCHEDULE_WAKEUP_SHORT_NAME,
    title: "Schedule Wakeup",
    description:
      "Schedule a future turn in THIS conversation: at the given time (one-shot reminder) or on a cron schedule (recurring check-in), this conversation wakes up with your prompt and you act on it — whether or not the user has a tab open. Use it for 'remind me at 5pm', 'check the deploy every 30 minutes', 'summarize my inbox every morning'. Provide exactly one of `at` or `cron`. Cron wakeups fire at most every 5 minutes; a conversation holds at most 10 enabled wakeups.",
    schema: z
      .object({
        prompt: z
          .string()
          .trim()
          .min(1)
          .describe(
            "What the wakeup turn should do, written as an instruction to your future self (context included — the wakeup turn sees the conversation history).",
          ),
        at: z
          .string()
          .optional()
          .describe(
            "One-shot fire time, ISO 8601 (e.g. 2026-08-18T17:00:00Z or with offset). Mutually exclusive with `cron`.",
          ),
        cron: z
          .string()
          .optional()
          .describe(
            "5-part cron expression for a recurring wakeup (e.g. '0 9 * * 1-5'). Mutually exclusive with `at`.",
          ),
        timezone: z
          .string()
          .optional()
          .describe(
            "IANA timezone the schedule is evaluated in (default UTC). Set it whenever the user names a local time.",
          ),
        name: z
          .string()
          .trim()
          .max(120)
          .optional()
          .describe("Short label; derived from the prompt when omitted."),
        quiet: z
          .boolean()
          .optional()
          .describe(
            "Monitor mode (recommended for recurring checks): when a wake turn finds nothing noteworthy, its reply collapses to a muted line and the user is not notified — only real findings surface.",
          ),
      })
      .strict(),
    outputSchema: z.object({ wakeup: WakeupSchema }),
    async handler({ args, context }) {
      const caller = resolveWakeupCaller(context);
      if ("error" in caller) return caller.error;

      if ((args.at === undefined) === (args.cron === undefined)) {
        return errorResult("Provide exactly one of `at` or `cron`.");
      }
      const timezone = args.timezone ?? "UTC";
      if (!isValidTimezone(timezone)) {
        return errorResult(`"${timezone}" is not a valid IANA timezone.`);
      }

      try {
        const lockInfo = await ConversationModel.getLockedChatKeyInfo(
          caller.conversationId,
        );
        if (!lockInfo) {
          return errorResult("Conversation not found.");
        }
        if (lockInfo.lockedChat) {
          return errorResult(
            "Scheduled wakeups are not available in locked chats.",
          );
        }

        const enabledCount =
          await ScheduleTriggerModel.countEnabledForConversation(
            caller.conversationId,
          );
        if (enabledCount >= MAX_ENABLED_WAKEUPS_PER_CONVERSATION) {
          return errorResult(
            `This conversation already has ${enabledCount} enabled wakeups (the maximum). Cancel one first with cancel_scheduled_wakeup.`,
          );
        }

        let runAt: Date | null = null;
        let cronExpression: string | null = null;
        if (args.at !== undefined) {
          const parsed = new Date(args.at);
          if (Number.isNaN(parsed.getTime())) {
            return errorResult(
              `Could not parse "${args.at}" as an ISO 8601 time.`,
            );
          }
          const now = Date.now();
          if (parsed.getTime() <= now) {
            return errorResult("The wakeup time must be in the future.");
          }
          if (parsed.getTime() - now > MAX_ONE_SHOT_HORIZON_MS) {
            return errorResult("The wakeup time must be within the next year.");
          }
          runAt = parsed;
        } else if (args.cron !== undefined) {
          cronExpression = normalizeCronExpression(args.cron);
          const intervalError = validateCronInterval({
            cronExpression,
            timezone: normalizeTimezone(timezone),
          });
          if (intervalError) {
            return errorResult(intervalError);
          }
        }

        const created = await ScheduleTriggerModel.create({
          organizationId: context.organizationId as string,
          name: args.name || deriveWakeupName(args.prompt),
          agentId: caller.agentId,
          projectId: null,
          messageTemplate: args.prompt,
          cronExpression,
          runAt,
          conversationId: caller.conversationId,
          timezone,
          enabled: true,
          quiet: args.quiet ?? false,
          actorUserId: caller.userId,
        });

        return structuredSuccessResult(
          { wakeup: toWakeupOutput(created) },
          runAt
            ? `Wakeup scheduled for ${runAt.toISOString()}. This conversation will wake up then and act on the prompt — no need to keep a tab open.`
            : `Recurring wakeup scheduled (${cronExpression}, ${timezone}). This conversation will wake up on that schedule — no need to keep a tab open.`,
        );
      } catch (error) {
        return catchError(error, "scheduling a wakeup");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_LIST_SCHEDULED_WAKEUPS_SHORT_NAME,
    title: "List Scheduled Wakeups",
    description:
      "List this conversation's scheduled wakeups: one-shot reminders and recurring check-ins, including spent one-shots (enabled: false).",
    schema: z.object({}).strict(),
    outputSchema: z.object({ wakeups: z.array(WakeupSchema) }),
    async handler({ context }) {
      const caller = resolveWakeupCaller(context);
      if ("error" in caller) return caller.error;
      try {
        const rows = await ScheduleTriggerModel.listForConversation({
          conversationId: caller.conversationId,
          actorUserId: caller.userId,
        });
        const wakeups = rows.map(toWakeupOutput);
        return structuredSuccessResult(
          { wakeups },
          wakeups.length === 0
            ? "No scheduled wakeups in this conversation."
            : `${wakeups.length} scheduled wakeup(s).`,
        );
      } catch (error) {
        return catchError(error, "listing scheduled wakeups");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_CANCEL_SCHEDULED_WAKEUP_SHORT_NAME,
    title: "Cancel Scheduled Wakeup",
    description:
      "Cancel (delete) one of this conversation's scheduled wakeups by wakeupId (from schedule_wakeup or list_scheduled_wakeups).",
    schema: z
      .object({
        wakeupId: z.string().describe("Id of the wakeup to cancel."),
      })
      .strict(),
    outputSchema: z.object({
      cancelled: z
        .boolean()
        .describe(
          "True when the wakeup was deleted; false when it did not exist, was not yours, or belongs to another conversation.",
        ),
    }),
    async handler({ args, context }) {
      const caller = resolveWakeupCaller(context);
      if ("error" in caller) return caller.error;
      try {
        const cancelled = await ScheduleTriggerModel.deleteForConversationActor(
          {
            id: args.wakeupId,
            conversationId: caller.conversationId,
            actorUserId: caller.userId,
          },
        );
        return structuredSuccessResult(
          { cancelled },
          cancelled
            ? "Wakeup cancelled."
            : "Nothing to cancel — no such wakeup in this conversation.",
        );
      } catch (error) {
        return catchError(error, "cancelling a scheduled wakeup");
      }
    },
  }),
] as const);

// === Exports ===

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;
