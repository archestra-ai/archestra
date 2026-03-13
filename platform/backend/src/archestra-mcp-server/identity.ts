import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import logger from "@/logging";
import type { ArchestraContext } from "./types";

const TOOL_WHOAMI_NAME = "whoami";
const TOOL_WHOAMI_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_WHOAMI_NAME}`;

export const toolShortNames = ["whoami"] as const;

export const tools: Tool[] = [
  {
    name: TOOL_WHOAMI_FULL_NAME,
    title: "Who Am I",
    description: "Returns the name and ID of the current agent",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: {},
    _meta: {},
  },
];

export async function handleTool(
  toolName: string,
  _args: Record<string, unknown> | undefined,
  context: ArchestraContext,
): Promise<CallToolResult | null> {
  if (toolName === TOOL_WHOAMI_FULL_NAME) {
    const { agent: contextAgent } = context;

    logger.info(
      { agentId: contextAgent.id, agentName: contextAgent.name },
      "whoami tool called",
    );

    return {
      content: [
        {
          type: "text",
          text: `Agent Name: ${contextAgent.name}\nAgent ID: ${contextAgent.id}`,
        },
      ],
      isError: false,
    };
  }

  return null;
}
