import {
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_TODO_WRITE_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import logger from "@/logging";
import { pendingRulings } from "@/openappa/pending-rulings";
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
});

const NO_CHOICE_FORM_MESSAGE =
  "This client did not answer the choice form. If it has its own question tool (AskUserQuestion, Codex, OpenCode), use that instead. Do not ask this as a plain-text chat question.";

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
    description: `Ask the user to pick from a short list of options. Use the client's own question tool when it has one (Claude Code AskUserQuestion, Codex, OpenCode). If it has none, you must call this tool: ${archestraMcpBranding.appName} chat shows the options as a form, and MCP clients get them with elicitation/create. Never ask a multiple-choice question in plain text, including yes or no. Do not use this for open questions.`,
    schema: z
      .object({
        question: z
          .string()
          .min(1)
          .max(2000)
          .describe("The question shown above the options."),
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
      })
      .strict(),
    outputSchema: AskUserOutputSchema,
    async handler({ args, context, toolName }) {
      const labels = args.options.map((option) => option.label);
      if (new Set(labels).size !== labels.length) {
        return errorResult("Give each option a different label.");
      }

      const elicitation = context.elicitation;
      if (!elicitation) {
        return errorResult(NO_CHOICE_FORM_MESSAGE);
      }

      const outcome = await elicitation.elicit({
        toolName,
        message: args.question,
        requestedSchema: args.allowMultiple
          ? buildMultiChoiceSchema(args.options)
          : buildSingleChoiceSchema(args.options),
      });

      if (outcome.status === "no_viewer") {
        return errorResult(NO_CHOICE_FORM_MESSAGE);
      }

      const { result } = outcome;
      const pendingRuling = consumePendingRuling(context);
      if (result.action !== "accept") {
        const action = result.action === "decline" ? "decline" : "cancel";
        return structuredSuccessResult(
          { action, selected: [] },
          [
            action === "decline"
              ? "The user declined to pick."
              : "The user dismissed the question.",
            pendingRuling
              ? "The user did not accept the remedy. Do not retry the blocked call and do not ask again. Tell the user the action stays blocked."
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
          pendingRuling
            ? `A remedy ruling is still pending. If the pick accepts it, continue now exactly as the ruling says — call ${archestraMcpBranding.getToolName(
                "execute_remedy_plan",
              )} with the offer_id and plan from the ruling, then retry the blocked call. If the pick rejects it, stop. Do not ask the user again.\n\n${pendingRuling}`
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
 * Take the remedy ruling pending for this session, if any. Consume-once: the
 * user has now answered, so the ruling must not leak into a later question.
 */
function consumePendingRuling(context: ArchestraContext): string | undefined {
  const session = context.openappaSession;
  if (!session) {
    return undefined;
  }
  return pendingRulings.consume({
    organizationId: session.organization_id,
    sessionId: session.session_id,
  });
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
