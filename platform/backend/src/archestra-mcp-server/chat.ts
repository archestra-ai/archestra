import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_ARTIFACT_WRITE_FULL_NAME,
  TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME,
  TOOL_TODO_WRITE_FULL_NAME,
} from "@shared";
import { userHasPermission } from "@/auth/utils";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  ConversationModel,
  OrganizationModel,
} from "@/models";
import { catchError, errorResult, successResult } from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

const TOOL_SWAP_AGENT_NAME = "swap_agent";
const TOOL_SWAP_AGENT_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_SWAP_AGENT_NAME}`;

export const toolShortNames = [
  "todo_write",
  "swap_agent",
  "swap_to_default_agent",
  "artifact_write",
] as const;

// === Exports ===

export const tools: Tool[] = [
  {
    name: TOOL_TODO_WRITE_FULL_NAME,
    title: "Write Todos",
    description:
      "Write todos to the current conversation. You have access to this tool to help you manage and plan tasks. Use it VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress. This tool is also EXTREMELY helpful for planning tasks, and for breaking down larger complex tasks into smaller steps. If you do not use this tool when planning, you may forget to do important tasks - and that is unacceptable. It is critical that you mark todos as completed as soon as you are done with a task. Do not batch up multiple tasks before marking them as completed.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "Array of todo items to write to the conversation",
          items: {
            type: "object",
            properties: {
              id: {
                type: "integer",
                description: "Unique identifier for the todo item",
              },
              content: {
                type: "string",
                description: "The content/description of the todo item",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "The current status of the todo item",
              },
            },
            required: ["id", "content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_SWAP_AGENT_FULL_NAME,
    title: "Swap Agent",
    description:
      "Switch the current conversation to a different agent. The new agent will automatically continue the conversation. Use this when the user asks to switch to or talk to a different agent.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description: "The name of the agent to switch to.",
        },
      },
      required: ["agent_name"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME,
    title: "Swap to Default Agent",
    description:
      "Return to the default agent. You MUST call this — without asking the user — when you don't have the right tools to fulfill a request, when you are stuck and cannot help further, when you are done with your task, or when the user wants to go back. Always write a brief message before calling this tool summarizing why you are switching back (e.g. what you accomplished, what tool is missing, or why you cannot continue).",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_ARTIFACT_WRITE_FULL_NAME,
    title: "Write Artifact",
    description:
      "Write or update a markdown artifact for the current conversation. Use this tool to maintain a persistent document that evolves throughout the conversation. The artifact should contain well-structured markdown content that can be referenced and updated as the conversation progresses. Each call to this tool completely replaces the existing artifact content. " +
      "Mermaid diagrams: Use ```mermaid blocks. " +
      "Supports: Headers, emphasis, lists, links, images, code blocks, tables, blockquotes, task lists, mermaid diagrams.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description:
            "The markdown content to write to the conversation artifact. This will completely replace any existing artifact content.",
        },
      },
      required: ["content"],
    },
    annotations: {},
    _meta: {},
  },
];

export async function handleTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  context: ArchestraContext,
): Promise<CallToolResult | null> {
  const { agent: contextAgent } = context;

  if (toolName === TOOL_TODO_WRITE_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, todoArgs: args },
      "todo_write tool called",
    );

    try {
      const todos = args?.todos as
        | Array<{
            id: number;
            content: string;
            status: string;
          }>
        | undefined;

      if (!todos || !Array.isArray(todos)) {
        return errorResult("todos parameter is required and must be an array");
      }

      // For now, just return a success message
      // In the future, this could persist todos to database
      return successResult(
        `Successfully wrote ${todos.length} todo item(s) to the conversation`,
      );
    } catch (error) {
      return catchError(error, "writing todos");
    }
  }

  if (toolName === TOOL_SWAP_AGENT_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, swapArgs: args },
      "swap_agent tool called",
    );

    try {
      const agentName = args?.agent_name as string | undefined;

      if (!agentName) {
        return errorResult("agent_name parameter is required.");
      }

      if (
        !context.conversationId ||
        !context.userId ||
        !context.organizationId
      ) {
        return errorResult(
          "This tool requires conversation context. It can only be used within an active chat conversation.",
        );
      }

      // Look up agent by name (search across all accessible agents)
      const results = await AgentModel.findAllPaginated(
        { limit: 5, offset: 0 },
        undefined,
        { name: agentName, agentType: "agent" },
        context.userId,
        true,
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

      // Verify user has access via team-based authorization
      const isAdmin = await userHasPermission(
        context.userId,
        context.organizationId,
        "agent",
        "admin",
      );
      const accessibleIds = await AgentTeamModel.getUserAccessibleAgentIds(
        context.userId,
        isAdmin,
      );

      if (!accessibleIds.includes(targetAgent.id)) {
        return errorResult(
          `You do not have access to agent "${targetAgent.name}".`,
        );
      }

      // Update the conversation's agent
      const updated = await ConversationModel.update(
        context.conversationId,
        context.userId,
        context.organizationId,
        { agentId: targetAgent.id },
      );

      if (!updated) {
        return errorResult("Failed to update conversation agent.");
      }

      return successResult(
        JSON.stringify({
          success: true,
          agent_id: targetAgent.id,
          agent_name: targetAgent.name,
        }),
      );
    } catch (error) {
      return catchError(error, "swapping agent");
    }
  }

  if (toolName === TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id },
      "swap_to_default_agent tool called",
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

      // Look up org's default agent
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

      // Prevent no-op swap to the same agent
      if (targetAgent.id === contextAgent.id) {
        return errorResult(
          `Already using the default agent "${targetAgent.name}".`,
        );
      }

      // Update the conversation's agent
      const updated = await ConversationModel.update(
        context.conversationId,
        context.userId,
        context.organizationId,
        { agentId: defaultAgentId },
      );

      if (!updated) {
        return errorResult("Failed to update conversation agent.");
      }

      return successResult(
        JSON.stringify({
          success: true,
          agent_id: targetAgent.id,
          agent_name: targetAgent.name,
        }),
      );
    } catch (error) {
      return catchError(error, "swapping to default agent");
    }
  }

  if (toolName === TOOL_ARTIFACT_WRITE_FULL_NAME) {
    logger.info(
      {
        agentId: contextAgent.id,
        contentLength: (args?.content as string)?.length,
      },
      "artifact_write tool called",
    );

    try {
      const content = args?.content as string | undefined;

      if (!content || typeof content !== "string") {
        return errorResult(
          "content parameter is required and must be a string",
        );
      }

      // Check if we have conversation context
      if (
        !context.conversationId ||
        !context.userId ||
        !context.organizationId
      ) {
        return errorResult(
          "This tool requires conversation context. It can only be used within an active chat conversation.",
        );
      }

      // Update the conversation's artifact
      const updated = await ConversationModel.update(
        context.conversationId,
        context.userId,
        context.organizationId,
        { artifact: content },
      );

      if (!updated) {
        return errorResult(
          "Failed to update conversation artifact. The conversation may not exist or you may not have permission to update it.",
        );
      }

      return successResult(
        `Successfully updated conversation artifact (${content.length} characters)`,
      );
    } catch (error) {
      return catchError(error, "writing artifact");
    }
  }

  return null;
}
