import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type ScheduleTriggerReplyChannel,
  ScheduleTriggerReplyChannelSchema,
  TOOL_ARTIFACT_WRITE_SHORT_NAME,
  TOOL_CONVERT_CONVERSATION_TO_SCHEDULED_TASK_SHORT_NAME,
  TOOL_SWAP_AGENT_SHORT_NAME,
  TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME,
  TOOL_TODO_WRITE_SHORT_NAME,
  type ToolStateMcpToolError,
  ToolStateMcpToolErrorSchema,
} from "@shared";
import { z } from "zod";
import { isAgentTypeAdmin } from "@/auth/agent-type-permissions";
import logger from "@/logging";
import {
  AgentModel,
  ChatOpsChannelBindingModel,
  ChatOpsThreadAgentOverrideModel,
  ConversationModel,
  OrganizationModel,
  ScheduleTriggerRunModel,
} from "@/models";
import { scheduleTriggerConverterService } from "@/schedule-triggers/converter";
import {
  createCron,
  FORM_SHAPE_CRON_ERROR_MESSAGE,
  isFormShapeCron,
  isValidTimezone,
} from "@/schedule-triggers/utils";
import { ApiError } from "@/types";
import { resolveConversationLlmSelectionForAgent } from "@/utils/llm-resolution";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  EmptyToolArgsSchema,
  errorResult,
  structuredSuccessResult,
  structuredToolErrorResult,
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

const SwapAgentStateCodeSchema = z.enum([
  "no_agent_found",
  "already_using_agent",
  "no_default_agent",
  "default_agent_not_found",
  "already_using_default_agent",
]);

const SwapAgentOutputSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true).describe("Whether the swap succeeded."),
    agent_id: z.string().describe("The agent ID the conversation now uses."),
    agent_name: z
      .string()
      .describe("The agent name the conversation now uses."),
  }),
  z.object({
    success: z.literal(false).describe("Whether the swap succeeded."),
    code: SwapAgentStateCodeSchema.describe("Why the swap was not applied."),
    message: z.string().describe("Human-readable explanation."),
    archestraError: ToolStateMcpToolErrorSchema,
  }),
]);

type SwapAgentStateCode = z.infer<typeof SwapAgentStateCodeSchema>;

const ArtifactWriteOutputSchema = z.object({
  success: z.literal(true).describe("Whether the artifact write succeeded."),
  characterCount: z
    .number()
    .int()
    .nonnegative()
    .describe("The number of characters written to the artifact."),
});

const ConvertConversationToScheduledTaskOutputSchema = z.object({
  success: z.literal(true).describe("Whether the conversion succeeded."),
  trigger_id: z
    .string()
    .describe("The ID of the created scheduled task (trigger)."),
  agent_id: z
    .string()
    .describe("The ID of the agent that was selected for the scheduled task."),
  name: z.string().describe("The name of the created scheduled task."),
  cron_expression: z
    .string()
    .describe("The cron expression stored for the scheduled task."),
  timezone: z.string().describe("The IANA timezone for the schedule."),
});

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
    shortName: TOOL_SWAP_AGENT_SHORT_NAME,
    title: "Swap Agent",
    description:
      "Switch the current conversation to a different agent. The new agent will automatically continue the conversation. Use this when the user asks to switch to or talk to a different agent.",
    schema: z
      .object({
        agent_name: z
          .string()
          .trim()
          .min(1)
          .describe("The name of the agent to switch to."),
      })
      .strict(),
    outputSchema: SwapAgentOutputSchema,
    async handler({ args, context }) {
      return handleSwapAgent({
        agentName: args.agent_name,
        context,
      });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME,
    title: "Swap to Default Agent",
    description:
      "Return to the default agent. You MUST call this — without asking the user — when you don't have the right tools to fulfill a request, when you are stuck and cannot help further, when you are done with your task, or when the user wants to go back. Always write a brief message before calling this tool summarizing why you are switching back (e.g. what you accomplished, what tool is missing, or why you cannot continue).",
    schema: EmptyToolArgsSchema,
    outputSchema: SwapAgentOutputSchema,
    async handler({ context }) {
      return handleSwapToDefaultAgent({ context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_ARTIFACT_WRITE_SHORT_NAME,
    title: "Write Artifact",
    description:
      "Write or update a markdown artifact for the current conversation. Use this tool to maintain a persistent document that evolves throughout the conversation. The artifact should contain well-structured markdown content that can be referenced and updated as the conversation progresses. Each call to this tool completely replaces the existing artifact content. " +
      "Mermaid diagrams: Use ```mermaid blocks. " +
      "Supports: Headers, emphasis, lists, links, images, code blocks, tables, blockquotes, task lists, mermaid diagrams.",
    schema: z
      .object({
        content: z
          .string()
          .min(1)
          .describe(
            "The markdown content to write to the conversation artifact. This completely replaces any existing artifact content.",
          ),
      })
      .strict(),
    outputSchema: ArtifactWriteOutputSchema,
    async handler({ args, context }) {
      const { agent: contextAgent } = context;

      logger.info(
        {
          agentId: contextAgent.id,
          contentLength: args.content.length,
          scheduleTriggerRunId: context.scheduleTriggerRunId ?? null,
          conversationId: context.conversationId ?? null,
          userId: context.userId ?? null,
          organizationId: context.organizationId ?? null,
        },
        "artifact_write tool called",
      );

      try {
        // Scheduled run context — write to the run (conversationId is a
        // synthetic isolation key, not a real DB conversation)
        if (context.scheduleTriggerRunId) {
          const updated = await ScheduleTriggerRunModel.setArtifact(
            context.scheduleTriggerRunId,
            args.content,
          );

          if (!updated) {
            return errorResult(
              "Failed to update scheduled run artifact. The run may no longer exist.",
            );
          }
        } else if (
          context.conversationId &&
          context.userId &&
          context.organizationId
        ) {
          const updated = await ConversationModel.update(
            context.conversationId,
            context.userId,
            context.organizationId,
            { artifact: args.content },
          );

          if (!updated) {
            return errorResult(
              "Failed to update conversation artifact. The conversation may not exist or you may not have permission to update it.",
            );
          }
        } else {
          return errorResult(
            "This tool requires conversation context. It can only be used within an active chat conversation or scheduled run.",
          );
        }

        return structuredSuccessResult(
          { success: true, characterCount: args.content.length },
          `Successfully updated artifact (${args.content.length} characters)`,
        );
      } catch (error) {
        return catchError(error, "writing artifact");
      }
    },
  }),

  defineArchestraTool({
    shortName: TOOL_CONVERT_CONVERSATION_TO_SCHEDULED_TASK_SHORT_NAME,
    title: "Convert Conversation to Scheduled Task",
    description:
      "Create a recurring scheduled task from the current conversation. The task will replay a standalone prompt (summarized from this chat unless one is provided) on the supplied cron schedule using an agent selected from this conversation's history. " +
      "Use this when the user explicitly asks to save, schedule, or re-run the current task periodically (e.g. 'do this every Monday at 9am', 'turn this into a recurring task'). " +
      "Prefer omitting agent_name and message_template to reuse the current conversation's context. Provide message_template only when the user wants to rewrite the prompt, and provide agent_name only when they pick a different agent. " +
      "Timezone must be a valid IANA identifier (e.g. 'UTC', 'Europe/London'). " +
      "Cron expression must match one of the two forms supported by the in-app schedule form: " +
      "(1) hourly 'M * * * *' (every hour at minute M, M=0-59), e.g. '0 * * * *'; " +
      "(2) daily 'M H * * D' (every day at H:M), where D is '*' for every day or a comma-separated list of weekdays 0-6 (Sun=0, Mon=1, ..., Sat=6), e.g. '0 9 * * 1,2,3,4,5' for weekdays at 09:00. " +
      "Bi-weekly, monthly, day-of-month, ranges (1-5), and step expressions (*/15) are NOT supported. If the user asks for a cadence that does not fit, pick the closest weekly equivalent or ask the user to clarify.",
    schema: z
      .object({
        cron_expression: z
          .string()
          .trim()
          .min(1)
          .describe(
            "5-field cron expression matching the in-app schedule form. Allowed forms: 'M * * * *' (hourly, M=0-59) or 'M H * * D' (daily, H=0-23, D='*' or comma-separated weekdays 0-6 with Sun=0). Examples: '0 * * * *', '0 9 * * *', '30 14 * * 1,2,3,4,5'. Day-of-month, month, ranges (1-5), and steps (*/15) are not supported.",
          ),
        timezone: z
          .string()
          .trim()
          .min(1)
          .describe(
            "IANA timezone identifier for the schedule, e.g. 'UTC' or 'Europe/London'.",
          ),
        name: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Optional human-readable name for the scheduled task. Defaults to the conversation title or a snippet of the first user message.",
          ),
        message_template: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Optional standalone prompt to run on every schedule tick. When omitted, the conversation is summarized into a prompt automatically.",
          ),
        agent_name: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Optional exact agent name to run the scheduled task. When omitted, the most recently used agent in this conversation is selected. When reply_in_same_conversation is true, this must be the current chat agent or one that has previously participated in the conversation.",
          ),
        enabled: z
          .boolean()
          .optional()
          .describe(
            "Whether the scheduled task should start enabled. Defaults to true.",
          ),
        reply_channel: ScheduleTriggerReplyChannelSchema.optional().describe(
          "Where the scheduled task result should be delivered. Defaults to 'chat'. 'slack_dm' delivers to your connected DM when available; otherwise the task falls back to chat.",
        ),
        reply_in_same_conversation: z
          .boolean()
          .optional()
          .describe(
            "When true, each successful run appends the prompt and assistant reply to this conversation instead of an isolated run thread. If the conversation's agent later changes (e.g. swap_agent) and the scheduled task's agent is no longer valid for the chat, the task auto-unlinks from the conversation and continues as standalone runs.",
          ),
      })
      .strict()
      .superRefine((data, ctx) => {
        if (!isValidTimezone(data.timezone)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Timezone must be a valid IANA timezone",
            path: ["timezone"],
          });
          return;
        }
        try {
          createCron({
            cronExpression: data.cron_expression,
            timezone: data.timezone,
          });
        } catch (error) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              error instanceof Error
                ? error.message
                : "Invalid cron expression",
            path: ["cron_expression"],
          });
          return;
        }
        if (!isFormShapeCron(data.cron_expression)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: FORM_SHAPE_CRON_ERROR_MESSAGE,
            path: ["cron_expression"],
          });
        }
      }),
    outputSchema: ConvertConversationToScheduledTaskOutputSchema,
    async handler({ args, context }) {
      return handleConvertConversationToScheduledTask({ args, context });
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;

// === Exports ===

export const tools = registry.tools;

function swapAgentStateResult(params: {
  code: SwapAgentStateCode;
  message: string;
  toolName: string;
}): CallToolResult {
  const archestraError: ToolStateMcpToolError = {
    type: "tool_state",
    code: params.code,
    message: params.message,
    toolName: params.toolName,
  };

  return structuredToolErrorResult({
    error: archestraError,
    text: JSON.stringify({
      success: false,
      code: params.code,
      message: params.message,
      archestraError,
    }),
    structuredContent: {
      success: false,
      code: params.code,
      message: params.message,
    },
    // These are expected chat-routing states, not MCP transport failures. Keep
    // isError false so the agent can respond normally instead of surfacing a
    // global chat error.
    isError: false,
  });
}

async function handleSwapAgent(params: {
  agentName: string;
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const { agentName, context } = params;
  const { agent: contextAgent } = context;
  logger.info(
    {
      agentId: contextAgent.id,
      agentName,
      chatOpsBindingId: context.chatOpsBindingId ?? null,
      conversationId: context.conversationId ?? null,
    },
    "swap_agent tool called",
  );

  try {
    if (!context.userId || !context.organizationId) {
      return errorResult(
        "This tool requires user and organization context. It can only be used within an authenticated chat session.",
      );
    }

    const hasConversationContext = Boolean(context.conversationId);
    const hasChatOpsContext = Boolean(context.chatOpsBindingId);
    if (!hasConversationContext && !hasChatOpsContext) {
      return errorResult(
        "This tool requires conversation context. It can only be used within an active chat conversation or chatops channel.",
      );
    }

    // Look up agent by name
    const isAdmin =
      context.userId && context.organizationId
        ? await isAgentTypeAdmin({
            userId: context.userId,
            organizationId: context.organizationId,
            agentType: "agent",
          })
        : false;

    const results = await AgentModel.findAllPaginated(
      { limit: 5, offset: 0 },
      undefined,
      {
        name: agentName,
        agentType: "agent",
        // Hide other users' personal agents. swap_agent is the primary
        // Archestra MCP use-case and requires only the caller's own personal
        // agents to be visible, even though admins can see all personal
        // agents in the UI.
        excludeOtherPersonalAgents: true,
      },
      context.userId,
      isAdmin,
    );

    if (results.data.length === 0) {
      return swapAgentStateResult({
        code: "no_agent_found",
        message: `No agent found matching "${agentName}".`,
        toolName: TOOL_SWAP_AGENT_SHORT_NAME,
      });
    }

    // Pick exact name match if available, otherwise first result
    const targetAgent =
      results.data.find(
        (a) => a.name.toLowerCase() === agentName.toLowerCase(),
      ) ?? results.data[0];

    // Prevent swapping to the same agent
    if (targetAgent.id === contextAgent.id) {
      return swapAgentStateResult({
        code: "already_using_agent",
        message: `Already using agent "${targetAgent.name}". Choose a different agent.`,
        toolName: TOOL_SWAP_AGENT_SHORT_NAME,
      });
    }

    // In chatops-triggered A2A runs we can have both:
    // - chatOpsBindingId: real channel binding context
    // - conversationId: synthetic isolation key for tool/session caching
    // Prefer the chatops binding whenever available.
    if (context.chatOpsBindingId) {
      if (!context.chatOpsThreadId) {
        return errorResult(
          "This tool requires thread context in chatops. Cannot determine which thread to swap.",
        );
      }

      // Validate binding exists and user has permission
      const binding = await ChatOpsChannelBindingModel.findById(
        context.chatOpsBindingId,
      );
      if (!binding || binding.organizationId !== context.organizationId) {
        return errorResult("Failed to update chatops channel agent.");
      }

      // Personal agent scope check
      if (targetAgent.scope === "personal") {
        if (!binding.isDm) {
          return errorResult(
            "Personal agents cannot be assigned to channels. Use an org-scoped or team-scoped agent instead.",
          );
        }
        if (targetAgent.authorId !== context.userId) {
          return errorResult(
            "You can only assign your own personal agents to your DM.",
          );
        }
      }

      // Write thread-scoped override instead of mutating channel binding
      const override = await ChatOpsThreadAgentOverrideModel.upsert(
        context.chatOpsBindingId,
        context.chatOpsThreadId,
        targetAgent.id,
      );
      if (!override) {
        return errorResult("Failed to update chatops thread agent.");
      }
    } else if (context.conversationId) {
      const llmSelection = await resolveConversationLlmSelectionForAgent({
        agent: {
          llmApiKeyId: targetAgent.llmApiKeyId ?? null,
          llmModel: targetAgent.llmModel ?? null,
        },
        organizationId: context.organizationId,
        userId: context.userId,
      });

      // Update the conversation's agent and LLM selection together so the
      // follow-up response uses the new agent's model/key immediately.
      const updated = await ConversationModel.update(
        context.conversationId,
        context.userId,
        context.organizationId,
        {
          agentId: targetAgent.id,
          chatApiKeyId: llmSelection.chatApiKeyId,
          selectedModel: llmSelection.selectedModel,
          selectedProvider: llmSelection.selectedProvider,
        },
      );
      if (!updated) {
        logger.warn(
          {
            conversationId: context.conversationId,
            userId: context.userId,
            organizationId: context.organizationId,
            chatOpsBindingId: context.chatOpsBindingId ?? null,
          },
          "swap_agent: conversation update failed, possible missing chatOpsBindingId",
        );
        return errorResult("Failed to update conversation agent.");
      }
    }

    return structuredSuccessResult(
      {
        success: true,
        agent_id: targetAgent.id,
        agent_name: targetAgent.name,
      },
      `Successfully swapped to agent "${targetAgent.name}" (ID: ${targetAgent.id}).`,
    );
  } catch (error) {
    return catchError(error, "swapping agent");
  }
}

async function handleSwapToDefaultAgent(params: {
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const { context } = params;
  const { agent: contextAgent } = context;

  logger.info(
    {
      agentId: contextAgent.id,
      chatOpsBindingId: context.chatOpsBindingId ?? null,
      conversationId: context.conversationId ?? null,
    },
    "swap_to_default_agent tool called",
  );

  try {
    if (!context.userId || !context.organizationId) {
      return errorResult(
        "This tool requires user and organization context. It can only be used within an authenticated chat session.",
      );
    }

    const hasConversationContext = Boolean(context.conversationId);
    const hasChatOpsContext = Boolean(context.chatOpsBindingId);
    if (!hasConversationContext && !hasChatOpsContext) {
      return errorResult(
        "This tool requires conversation context. It can only be used within an active chat conversation or chatops channel.",
      );
    }

    const org = await OrganizationModel.getById(context.organizationId);
    const defaultAgentId = org?.defaultAgentId ?? null;

    if (!defaultAgentId) {
      return swapAgentStateResult({
        code: "no_default_agent",
        message: "No default agent is configured for this organization.",
        toolName: TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME,
      });
    }

    const targetAgent = await AgentModel.findById(defaultAgentId);
    if (!targetAgent) {
      return swapAgentStateResult({
        code: "default_agent_not_found",
        message: "Default agent not found.",
        toolName: TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME,
      });
    }

    if (targetAgent.id === contextAgent.id) {
      return swapAgentStateResult({
        code: "already_using_default_agent",
        message: `Already using the default agent "${targetAgent.name}".`,
        toolName: TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME,
      });
    }

    // In chatops-triggered A2A runs we can have both:
    // - chatOpsBindingId: real channel binding context
    // - conversationId: synthetic isolation key for tool/session caching
    // Prefer the chatops binding whenever available.
    if (context.chatOpsBindingId) {
      if (!context.chatOpsThreadId) {
        return errorResult(
          "This tool requires thread context in chatops. Cannot determine which thread to swap.",
        );
      }

      // Validate binding exists and user has permission
      const binding = await ChatOpsChannelBindingModel.findById(
        context.chatOpsBindingId,
      );
      if (!binding || binding.organizationId !== context.organizationId) {
        return errorResult("Failed to update chatops channel agent.");
      }

      // Personal agent scope check
      if (targetAgent.scope === "personal") {
        if (!binding.isDm) {
          return errorResult(
            "Personal agents cannot be assigned to channels. Use an org-scoped or team-scoped agent instead.",
          );
        }
        if (targetAgent.authorId !== context.userId) {
          return errorResult(
            "You can only assign your own personal agents to your DM.",
          );
        }
      }

      // Write thread-scoped override instead of mutating channel binding
      const override = await ChatOpsThreadAgentOverrideModel.upsert(
        context.chatOpsBindingId,
        context.chatOpsThreadId,
        targetAgent.id,
      );
      if (!override) {
        return errorResult("Failed to update chatops thread agent.");
      }
    } else if (context.conversationId) {
      const llmSelection = await resolveConversationLlmSelectionForAgent({
        agent: {
          llmApiKeyId: targetAgent.llmApiKeyId ?? null,
          llmModel: targetAgent.llmModel ?? null,
        },
        organizationId: context.organizationId,
        userId: context.userId,
      });

      const updated = await ConversationModel.update(
        context.conversationId,
        context.userId,
        context.organizationId,
        {
          agentId: defaultAgentId,
          chatApiKeyId: llmSelection.chatApiKeyId,
          selectedModel: llmSelection.selectedModel,
          selectedProvider: llmSelection.selectedProvider,
        },
      );
      if (!updated) {
        logger.warn(
          {
            conversationId: context.conversationId,
            userId: context.userId,
            organizationId: context.organizationId,
            chatOpsBindingId: context.chatOpsBindingId ?? null,
          },
          "swap_to_default_agent: conversation update failed, possible missing chatOpsBindingId",
        );
        return errorResult("Failed to update conversation agent.");
      }
    }

    return structuredSuccessResult(
      {
        success: true,
        agent_id: targetAgent.id,
        agent_name: targetAgent.name,
      },
      `Successfully swapped to default agent "${targetAgent.name}" (ID: ${targetAgent.id}).`,
    );
  } catch (error) {
    return catchError(error, "swapping to default agent");
  }
}

async function handleConvertConversationToScheduledTask(params: {
  args: {
    cron_expression: string;
    timezone: string;
    name?: string;
    message_template?: string;
    agent_name?: string;
    enabled?: boolean;
    reply_channel?: ScheduleTriggerReplyChannel;
    reply_in_same_conversation?: boolean;
  };
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const { args, context } = params;

  try {
    if (!context.conversationId || !context.userId || !context.organizationId) {
      return errorResult(
        "This tool requires conversation context. It can only be used within an active chat conversation.",
      );
    }

    if (context.scheduleTriggerRunId) {
      return errorResult(
        "Scheduled task runs cannot be converted into new scheduled tasks.",
      );
    }

    let resolvedAgentId: string | undefined;
    if (args.agent_name) {
      const agentName = args.agent_name;
      const isAdmin = await isAgentTypeAdmin({
        userId: context.userId,
        organizationId: context.organizationId,
        agentType: "agent",
      });

      const results = await AgentModel.findAllPaginated(
        { limit: 5, offset: 0 },
        undefined,
        {
          name: args.agent_name,
          agentType: "agent",
          excludeOtherPersonalAgents: true,
        },
        context.userId,
        isAdmin,
      );

      if (results.data.length === 0) {
        return errorResult(`No agent found matching "${args.agent_name}".`);
      }

      const targetAgent =
        results.data.find(
          (a) => a.name.toLowerCase() === agentName.toLowerCase(),
        ) ?? results.data[0];

      resolvedAgentId = targetAgent.id;
    }

    const trigger =
      await scheduleTriggerConverterService.createFromConversation({
        conversationId: context.conversationId,
        userId: context.userId,
        organizationId: context.organizationId,
        cronExpression: args.cron_expression,
        timezone: args.timezone,
        name: args.name,
        messageTemplate: args.message_template,
        agentId: resolvedAgentId,
        enabled: args.enabled,
        replyChannel: args.reply_channel,
        replyInSameConversation: args.reply_in_same_conversation,
      });

    return structuredSuccessResult(
      {
        success: true,
        trigger_id: trigger.id,
        agent_id: trigger.agentId,
        name: trigger.name,
        cron_expression: trigger.cronExpression,
        timezone: trigger.timezone,
      },
      `Created scheduled task "${trigger.name}" (${trigger.cronExpression} ${trigger.timezone}, agent ${trigger.agentId}).`,
    );
  } catch (error) {
    if (error instanceof ApiError) {
      return errorResult(error.message);
    }
    return catchError(error, "converting conversation to scheduled task");
  }
}
