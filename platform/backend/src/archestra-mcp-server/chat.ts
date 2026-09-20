import {
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_TODO_WRITE_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { OfferJwsSchema, verifyOfferClaims } from "@/openappa/offer-claims";
import { chatOpenAppaSession, type OpenAppaSession } from "@/openappa/service";
import { archestraMcpBranding } from "./branding";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

const TodoItemSchema = z
  .object({
    id: z.number().int().describe("Unique identifier for the todo item."),
    content: z
      .string()
      .describe("The content or description of the todo item."),
    status: z
      .enum(["pending", "in_progress", "completed"])
      .describe("The current status of the todo item."),
  })
  .strict();

const TodoWriteOutputSchema = z.object({
  success: z.literal(true).describe("Whether the write succeeded."),
  todoCount: z
    .number()
    .int()
    .nonnegative()
    .describe("How many todo items were written."),
});

const AskUserOptionSchema = z
  .object({
    label: z.string().min(1).max(200).describe("The option shown to the user."),
    description: z
      .string()
      .max(500)
      .optional()
      .describe("Optional extra detail shown next to the option."),
  })
  .strict();

const AskUserOutputSchema = z.object({
  action: z
    .enum(["accept", "decline", "cancel"])
    .describe("Whether the user submitted, declined, or cancelled."),
  selected: z
    .array(z.string())
    .describe(
      "The labels the user selected. Empty when they declined or cancelled.",
    ),
  timedOut: z
    .boolean()
    .optional()
    .describe("True when nobody answered before the question expired."),
});

const AskUserSchema = z
  .object({
    question: z
      .string()
      .min(1)
      .max(2000)
      .describe("The question shown above the options."),
    header: z
      .string()
      .trim()
      .min(1)
      .max(30)
      .optional()
      .describe(
        "A very short label shown as the question's tab, e.g. 'Visibility'.",
      ),
    options: z
      .array(AskUserOptionSchema)
      .min(2)
      .max(12)
      .describe("The options the user can pick. Labels must be unique."),
    allowMultiple: z
      .boolean()
      .optional()
      .describe(
        "When true, the user may select more than one option. Defaults to false (exactly one).",
      ),
    remedy_offer_ids: z
      .array(z.string().min(1).max(128))
      .max(12)
      .optional()
      .describe(
        "Exact offer IDs from the blocked ruling that this question asks the user to decide. Omit for ordinary questions.",
      ),
  })
  .strict();

const AskUserExecutionSchema = AskUserSchema.extend({
  remedy_offers: z
    .array(OfferJwsSchema)
    .optional()
    .describe("Signed live offers added by the proxy for this question."),
}).strict();

const NO_CHOICE_FORM_MESSAGE =
  "This client did not answer the choice form. If it has its own question tool (AskUserQuestion, Codex, OpenCode), use that instead. Do not ask this as a plain-text chat question.";

// A headless run (A2A, ChatOps, a schedule, a subagent) has no one to show a
// form to; the reply is the only place a question can reach the user.
const NO_VIEWER_MESSAGE =
  "No one can answer a choice form in this session. Ask the question in your reply instead, and list the options.";

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_TODO_WRITE_SHORT_NAME,
    title: "Write Todos",
    description:
      "Write todos to the current conversation. You have access to this tool to help you manage and plan tasks. Use it VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress. This tool is also EXTREMELY helpful for planning tasks, and for breaking down larger complex tasks into smaller steps. If you do not use this tool when planning, you may forget to do important tasks - and that is unacceptable. It is critical that you mark todos as completed as soon as you are done with a task. Do not batch up multiple tasks before marking them as completed.",
    schema: z
      .object({
        todos: z
          .array(TodoItemSchema)
          .describe("Array of todo items to write to the conversation."),
      })
      .strict(),
    outputSchema: TodoWriteOutputSchema,
    async handler({ args, context }) {
      const { agent: contextAgent } = context;

      logger.info(
        { agentId: contextAgent.id, todoArgs: args },
        "todo_write tool called",
      );

      try {
        return structuredSuccessResult(
          { success: true, todoCount: args.todos.length },
          `Successfully wrote ${args.todos.length} todo item(s) to the conversation`,
        );
      } catch (error) {
        return catchError(error, "writing todos");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_ASK_USER_SHORT_NAME,
    title: "Ask User",
    description: `Ask the user to pick from a short list of options. Use the client's own question tool when it has one (Claude Code AskUserQuestion, Codex, OpenCode). If it has none, you must call this tool: ${archestraMcpBranding.appName} chat shows the options as a form, and MCP clients get them with elicitation/create. Never ask a multiple-choice question in plain text, including yes or no. Do not use this for open questions. To ask several questions at once, call this tool once per question in the same turn and give each a short header.`,
    schema: AskUserExecutionSchema,
    publicSchema: AskUserSchema,
    outputSchema: AskUserOutputSchema,
    async handler({ args, context, toolName }) {
      const labels = args.options.map((option) => option.label);
      if (new Set(labels).size !== labels.length) {
        return errorResult("Give each option a different label.");
      }

      const elicitation = context.elicitation;
      if (!elicitation) {
        return errorResult(NO_VIEWER_MESSAGE);
      }

      const outcome = await elicitation.elicit({
        toolName,
        message: args.question,
        requestedSchema: args.allowMultiple
          ? buildMultiChoiceSchema(args.options)
          : buildSingleChoiceSchema(args.options),
        toolCallId: context.currentToolCallId,
        header: args.header,
      });

      if (outcome.status === "no_viewer") {
        return errorResult(NO_CHOICE_FORM_MESSAGE);
      }

      // No answer in time reads as a dismissal: nothing was accepted.
      const result =
        outcome.status === "answered"
          ? outcome.result
          : { action: "cancel" as const };
      const liveOffers = verifiedOfferIds(args.remedy_offers, context);
      if (result.action !== "accept") {
        const action = result.action === "decline" ? "decline" : "cancel";
        return structuredSuccessResult(
          {
            action,
            selected: [],
            ...(outcome.status === "unanswered" ? { timedOut: true } : {}),
          },
          [
            outcome.status === "unanswered"
              ? "The user did not answer the question in time."
              : action === "decline"
                ? "The user declined to pick."
                : "The user dismissed the question.",
            "This is the user's final decision on this question for this turn. Do not ask it again, offer the same options in prose, or end with a follow-up question or invitation. Wait for a new user message before revisiting this question.",
            // Several questions asked in one turn all carry the turn's offers,
            // so a dismissed one only refuses the remedy if it offered it.
            liveOffers.length > 0
              ? "If this question offered the remedy, the user did not accept it: do not retry the blocked call and do not ask again. Briefly state that the action remains blocked, without repeating the offered plan, and stop."
              : "Do not proceed with the question.",
          ].join(" "),
        );
      }

      const selected = selectedLabels({
        content: result.content,
        options: args.options,
        allowMultiple: args.allowMultiple === true,
      });
      if (selected.length === 0) {
        return errorResult("The user sent the form with no option selected.");
      }
      if (!args.allowMultiple && selected.length !== 1) {
        return errorResult("The user selected more than one option.");
      }

      return structuredSuccessResult(
        { action: "accept", selected },
        [
          `The user picked: ${selected.join(", ")}. Act on this choice.`,
          liveOffers.length > 0
            ? `Live remedy offers: ${liveOffers.join(", ")}. If the pick accepts a remedy, continue now exactly as the ruling says — call ${archestraMcpBranding.getToolName(
                TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
              )} with the offer_id and the plan from the ruling, then retry the blocked call. Do not ask the user again.`
            : "",
        ]
          .filter((part) => part.length > 0)
          .join(" "),
      );
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;

// === Exports ===

export const tools = registry.tools;

function buildSingleChoiceSchema(
  options: Array<{ label: string; description?: string }>,
) {
  const enumDescriptions = options.map((option) => option.description);
  return {
    type: "object" as const,
    properties: {
      choice: {
        type: "string" as const,
        title: "Choice",
        enum: options.map((option) => option.label),
        ...(enumDescriptions.some((description) => description)
          ? { enumDescriptions }
          : {}),
      },
    },
    required: ["choice"],
  };
}

function optionKey(index: number) {
  return `option_${index}`;
}

/**
 * Verified offer ids from the envelopes the proxy stamped onto this call.
 * Anything unsigned, minted with a different secret, or signed for another
 * organization, OpenAPPA session, or caller is dropped — the binding
 * execute_remedy_plan applies when it spends an offer — so an envelope
 * replayed from another session's history, or minted for another user, is
 * never repeated as live.
 */
function verifiedOfferIds(
  envelopes: unknown,
  context: ArchestraContext,
): string[] {
  const session = callOpenAppaSession(context);
  if (!Array.isArray(envelopes) || !session || !context.userId) {
    return [];
  }
  const spender = `user:${context.userId}`;
  const secret = config.openappa.offerSigningSecret;
  const ids = new Set<string>();
  for (const envelope of envelopes) {
    const claims = verifyOfferClaims(envelope, secret);
    if (
      claims &&
      claims.organization_id === session.organization_id &&
      claims.session_id === session.session_id &&
      offerOwnerIsSpender(claims.caller_id, spender)
    ) {
      ids.add(claims.offer_id);
    }
  }
  return [...ids];
}

/**
 * This call's OpenAPPA session, resolved the way the other OpenAPPA tools
 * resolve it: the gateway's header-named session, else Chat's conversation.
 */
function callOpenAppaSession(
  context: ArchestraContext,
): OpenAppaSession | undefined {
  if (context.openappaSession) {
    return context.openappaSession;
  }
  const sessionId = context.sessionId ?? context.conversationId;
  return context.organizationId && context.userId && sessionId
    ? chatOpenAppaSession(context.organizationId, context.userId, sessionId)
    : undefined;
}

/**
 * Whether `spender` may act on an offer minted by `owner`, as the runtime
 * decides it when execute_remedy_plan spends one: a user's offer belongs to
 * that user alone; an app's or key's offer is organization-scoped; an offer
 * with no owner belongs to no one.
 */
function offerOwnerIsSpender(owner: string | null, spender: string): boolean {
  if (!owner) {
    return false;
  }
  if (owner.startsWith("user:")) {
    return owner.length > "user:".length && owner === spender;
  }
  return !owner.startsWith("app:") && !owner.startsWith("virtual-key:");
}

function buildMultiChoiceSchema(
  options: Array<{ label: string; description?: string }>,
) {
  return {
    type: "object" as const,
    properties: Object.fromEntries(
      options.map((option, index) => [
        optionKey(index),
        {
          type: "boolean" as const,
          title: option.label,
          description: option.description,
          default: false,
        },
      ]),
    ),
  };
}

function selectedLabels(params: {
  content: unknown;
  options: Array<{ label: string }>;
  allowMultiple: boolean;
}): string[] {
  const { content, options, allowMultiple } = params;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return [];
  }
  const record = content as Record<string, unknown>;
  const allowed = new Set(options.map((option) => option.label));

  if (!allowMultiple) {
    const choice = record.choice;
    return typeof choice === "string" && allowed.has(choice) ? [choice] : [];
  }

  return options.flatMap((option, index) =>
    record[optionKey(index)] === true && allowed.has(option.label)
      ? [option.label]
      : [],
  );
}
