import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isAgentTypeAdmin } from "@/auth/agent-type-permissions";
import logger from "@/logging";
import { AgentModel, ConversationModel, OrganizationModel } from "@/models";
import { resolveConversationLlmSelectionForAgent } from "@/services/conversation-llm-selection";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  EmptyToolArgsSchema,
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

const SwapAgentOutputSchema = z.object({
  success: z.literal(true).describe("Whether the swap succeeded."),
  agent_id: z.string().describe("The agent ID the conversation now uses."),
  agent_name: z.string().describe("The agent name the conversation now uses."),
});

const ArtifactWriteOutputSchema = z.object({
  success: z.literal(true).describe("Whether the artifact write succeeded."),
  characterCount: z
    .number()
    .int()
    .nonnegative()
    .describe("The number of characters written to the artifact."),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: "todo_write",
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
    shortName: "swap_agent",
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
    shortName: "swap_to_default_agent",
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
    shortName: "artifact_write",
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
        },
        "artifact_write tool called",
      );

      try {
        if (
          !context.conversationId ||
          !context.userId ||
          !context.organizationId
        ) {
          return errorResult(
            "This tool requires conversation context. It can only be used within an active chat conversation.",
          );
        }

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

        return structuredSuccessResult(
          { success: true, characterCount: args.content.length },
          `Successfully updated conversation artifact (${args.content.length} characters)`,
        );
      } catch (error) {
        return catchError(error, "writing artifact");
      }
    },
  }),
] as const);

export const toolShortNames = registry.toolShortNames;
export const toolArgsSchemas = registry.toolArgsSchemas;
export const toolOutputSchemas = registry.toolOutputSchemas;
export const toolEntries = registry.toolEntries;

// === Exports ===

export const tools = registry.tools;

async function handleSwapAgent(params: {
  agentName: string;
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const { agentName, context } = params;
  const { agent: contextAgent } = context;
  logger.info(
    { agentId: contextAgent.id, agentName },
    "swap_agent tool called",
  );

  try {
    if (!context.conversationId || !context.userId || !context.organizationId) {
      return errorResult(
        "This tool requires conversation context. It can only be used within an active chat conversation.",
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
      return errorResult(`No agent found matching "${agentName}".`);
    }

    // Pick exact name match if available, otherwise first result
    const targetAgent =
      results.data.find(
        (a) => a.name.toLowerCase() === agentName.toLowerCase(),
      ) ?? results.data[0];

    // Prevent swapping to the same agent
    if (targetAgent.id === contextAgent.id) {
      return errorResult(
        `Already using agent "${targetAgent.name}". Choose a different agent.`,
      );
    }

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
      return errorResult("Failed to update conversation agent.");
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
    { agentId: contextAgent.id },
    "swap_to_default_agent tool called",
  );

  try {
    if (!context.conversationId || !context.userId || !context.organizationId) {
      return errorResult(
        "This tool requires conversation context. It can only be used within an active chat conversation.",
      );
    }

    const org = await OrganizationModel.getById(context.organizationId);
    const defaultAgentId = org?.defaultAgentId ?? null;

    if (!defaultAgentId) {
      return errorResult(
        "No default agent is configured for this organization.",
      );
    }

    const targetAgent = await AgentModel.findById(defaultAgentId);
    if (!targetAgent) {
      return errorResult("Default agent not found.");
    }

    if (targetAgent.id === contextAgent.id) {
      return errorResult(
        `Already using the default agent "${targetAgent.name}".`,
      );
    }

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
      return errorResult("Failed to update conversation agent.");
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
