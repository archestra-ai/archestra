import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import logger from "@/logging";
import {
  defineArchestraTools,
  EmptyToolArgsSchema,
  successResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

const registry = defineArchestraTools([
  {
    shortName: "whoami",
    title: "Who Am I",
    description: "Returns the name and ID of the current agent.",
    schema: EmptyToolArgsSchema,
  },
] as const);

const { whoami: TOOL_WHOAMI_FULL_NAME } = registry.toolFullNames;

export const toolShortNames = registry.toolShortNames;
export const toolArgsSchemas = registry.toolArgsSchemas;
export const tools = registry.tools;

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

    return successResult(
      `Agent Name: ${contextAgent.name}\nAgent ID: ${contextAgent.id}`,
    );
  }

  return null;
}
