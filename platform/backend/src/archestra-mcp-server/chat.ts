import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_ARTIFACT_WRITE_FULL_NAME,
  TOOL_TODO_WRITE_FULL_NAME,
} from "@shared";
import { userHasPermission } from "@/auth/utils";
import logger from "@/logging";
import { AgentModel, AgentTeamModel, ConversationModel } from "@/models";
import type { ArchestraContext } from "./types";

// === Constants ===

const TOOL_SWAP_AGENT_NAME = "swap_agent";
const TOOL_SWAP_AGENT_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_SWAP_AGENT_NAME}`;

export const toolShortNames = [
  "todo_write",
  "swap_agent",
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
      "Switch the current conversation to a different agent. This replaces YOUR system prompt and available tools with those of the target agent. CRITICAL RULES: (1) This tool MUST be the ONLY tool call in the response — never batch it with other tool calls. (2) After calling this tool, you MUST stop responding immediately — do not add any further text, tool calls, or commentary. The new agent (with its own identity, instructions, and tools) will automatically continue the conversation in a new turn.",
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
        return {
          content: [
            {
              type: "text",
              text: "Error: todos parameter is required and must be an array",
            },
          ],
          isError: true,
        };
      }

      // For now, just return a success message
      // In the future, this could persist todos to database
      return {
        content: [
          {
            type: "text",
            text: `Successfully wrote ${todos.length} todo item(s) to the conversation`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error writing todos");
      return {
        content: [
          {
            type: "text",
            text: `Error writing todos: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
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
        return {
          content: [
            { type: "text", text: "Error: agent_name parameter is required." },
          ],
          isError: true,
        };
      }

      if (
        !context.conversationId ||
        !context.userId ||
        !context.organizationId
      ) {
        return {
          content: [
            {
              type: "text",
              text: "Error: This tool requires conversation context. It can only be used within an active chat conversation.",
            },
          ],
          isError: true,
        };
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
        return {
          content: [
            {
              type: "text",
              text: `Error: No agent found matching "${agentName}".`,
            },
          ],
          isError: true,
        };
      }

      // Pick exact name match if available, otherwise first result
      const targetAgent =
        results.data.find(
          (a) => a.name.toLowerCase() === agentName.toLowerCase(),
        ) ?? results.data[0];

      // Prevent swapping to the same agent
      if (targetAgent.id === contextAgent.id) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Already using agent "${targetAgent.name}". Choose a different agent.`,
            },
          ],
          isError: true,
        };
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
        return {
          content: [
            {
              type: "text",
              text: `Error: You do not have access to agent "${targetAgent.name}".`,
            },
          ],
          isError: true,
        };
      }

      // Update the conversation's agent
      const updated = await ConversationModel.update(
        context.conversationId,
        context.userId,
        context.organizationId,
        { agentId: targetAgent.id },
      );

      if (!updated) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Failed to update conversation agent.",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              agent_id: targetAgent.id,
              agent_name: targetAgent.name,
              instruction:
                "Agent swap complete. Your system prompt and tools have been replaced. STOP responding now — do not emit any further text or tool calls. The new agent will continue in the next turn.",
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error swapping agent");
      return {
        content: [
          {
            type: "text",
            text: `Error swapping agent: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
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
        return {
          content: [
            {
              type: "text",
              text: "Error: content parameter is required and must be a string",
            },
          ],
          isError: true,
        };
      }

      // Check if we have conversation context
      if (
        !context.conversationId ||
        !context.userId ||
        !context.organizationId
      ) {
        return {
          content: [
            {
              type: "text",
              text: "Error: This tool requires conversation context. It can only be used within an active chat conversation.",
            },
          ],
          isError: true,
        };
      }

      // Update the conversation's artifact
      const updated = await ConversationModel.update(
        context.conversationId,
        context.userId,
        context.organizationId,
        { artifact: content },
      );

      if (!updated) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Failed to update conversation artifact. The conversation may not exist or you may not have permission to update it.",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Successfully updated conversation artifact (${content.length} characters)`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error writing artifact");
      return {
        content: [
          {
            type: "text",
            text: `Error writing artifact: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  return null;
}
