import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import logger from "@/logging";
import { assignToolToAgent } from "@/routes/agent-tool";
import { catchError, errorResult, successResult } from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

const TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_NAME = "bulk_assign_tools_to_agents";
const TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_NAME =
  "bulk_assign_tools_to_mcp_gateways";

const TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_NAME}`;
const TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_NAME}`;

export const toolShortNames = [
  "bulk_assign_tools_to_agents",
  "bulk_assign_tools_to_mcp_gateways",
] as const;

// === Exports ===

export const tools: Tool[] = [
  {
    name: TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_FULL_NAME,
    title: "Bulk Assign Tools to Agents",
    description:
      "Assign multiple tools to multiple agents in bulk with validation and error handling",
    inputSchema: {
      type: "object",
      properties: {
        assignments: {
          type: "array",
          description: "Array of tool assignments to create",
          items: {
            type: "object",
            properties: {
              agentId: {
                type: "string",
                description: "The ID of the agent to assign the tool to",
              },
              toolId: {
                type: "string",
                description: "The ID of the tool to assign",
              },
              credentialSourceMcpServerId: {
                type: "string",
                description:
                  "Optional ID of the MCP server to use as credential source",
              },
              executionSourceMcpServerId: {
                type: "string",
                description:
                  "Optional ID of the MCP server to use as execution source",
              },
              useDynamicTeamCredential: {
                type: "boolean",
                description:
                  "When true, credentials are resolved at call time based on the caller's identity instead of using a fixed credential source. Resolution order: (1) the calling user's own personal credential, (2) a credential owned by a team member on the same team. Use this as an alternative to credentialSourceMcpServerId or executionSourceMcpServerId.",
              },
            },
            required: ["agentId", "toolId"],
          },
        },
      },
      required: ["assignments"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_FULL_NAME,
    title: "Bulk Assign Tools to MCP Gateways",
    description:
      "Assign multiple tools to multiple MCP gateways in bulk with validation and error handling",
    inputSchema: {
      type: "object",
      properties: {
        assignments: {
          type: "array",
          description: "Array of tool assignments to create",
          items: {
            type: "object",
            properties: {
              mcpGatewayId: {
                type: "string",
                description: "The ID of the MCP gateway to assign the tool to",
              },
              toolId: {
                type: "string",
                description: "The ID of the tool to assign",
              },
              credentialSourceMcpServerId: {
                type: "string",
                description:
                  "Optional ID of the MCP server to use as credential source",
              },
              executionSourceMcpServerId: {
                type: "string",
                description:
                  "Optional ID of the MCP server to use as execution source",
              },
              useDynamicTeamCredential: {
                type: "boolean",
                description:
                  "When true, credentials are resolved at call time based on the caller's identity instead of using a fixed credential source. Resolution order: (1) the calling user's own personal credential, (2) a credential owned by a team member on the same team. Use this as an alternative to credentialSourceMcpServerId or executionSourceMcpServerId.",
              },
            },
            required: ["mcpGatewayId", "toolId"],
          },
        },
      },
      required: ["assignments"],
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
  if (
    toolName !== TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_FULL_NAME &&
    toolName !== TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_FULL_NAME
  ) {
    return null;
  }

  const { agent: contextAgent } = context;

  const bulkAssignTypeMap: Record<string, string> = {
    [TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_FULL_NAME]: "agent",
    [TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_FULL_NAME]: "mcp_gateway",
  };
  const bulkAssignType = bulkAssignTypeMap[toolName];
  const idField = bulkAssignType === "agent" ? "agentId" : "mcpGatewayId";
  const bulkAssignLabel =
    bulkAssignType === "agent" ? "agents" : "MCP gateways";

  logger.info(
    {
      agentId: contextAgent.id,
      assignments: args?.assignments,
      type: bulkAssignType,
    },
    `bulk_assign_tools_to_${bulkAssignType === "agent" ? "agents" : "mcp_gateways"} tool called`,
  );

  try {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic property access by idField
    const assignments = args?.assignments as Array<Record<string, any>>;

    if (!assignments || !Array.isArray(assignments)) {
      return errorResult(
        "assignments parameter is required and must be an array",
      );
    }

    const results = await Promise.allSettled(
      assignments.map((assignment) =>
        assignToolToAgent(
          assignment[idField],
          assignment.toolId,
          assignment.credentialSourceMcpServerId,
          assignment.executionSourceMcpServerId,
          undefined,
          assignment.useDynamicTeamCredential,
        ),
      ),
    );

    const succeeded: { [key: string]: string }[] = [];
    const failed: { [key: string]: string }[] = [];
    const duplicates: { [key: string]: string }[] = [];

    results.forEach((result, index) => {
      const entityId = assignments[index][idField];
      const { toolId } = assignments[index];
      if (result.status === "fulfilled") {
        if (result.value === null || result.value === "updated") {
          succeeded.push({ [idField]: entityId, toolId });
        } else if (result.value === "duplicate") {
          duplicates.push({ [idField]: entityId, toolId });
        } else {
          const error = result.value.error.message || "Unknown error";
          failed.push({ [idField]: entityId, toolId, error });
        }
      } else if (result.status === "rejected") {
        const error =
          result.reason instanceof Error
            ? result.reason.message
            : "Unknown error";
        failed.push({ [idField]: entityId, toolId, error });
      }
    });

    return successResult(
      JSON.stringify({ succeeded, failed, duplicates }, null, 2),
    );
  } catch (error) {
    return catchError(error, `bulk assigning tools to ${bulkAssignLabel}`);
  }
}
