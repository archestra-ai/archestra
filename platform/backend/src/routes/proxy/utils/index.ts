import { AgentModel, AgentToolModel, ToolModel } from "@/models";

/**
 * Get or create the default agent based on the user-agent header
 */
export const getAgentIdFromRequest = async (
  userAgentHeader?: string,
): Promise<string> =>
  (await AgentModel.getAgentOrCreateDefault(userAgentHeader)).id;

/**
 * Persist tools if present in the request
 */
export const persistTools = async (
  tools: Array<{
    toolName: string;
    toolParameters?: Record<string, unknown>;
    toolDescription?: string;
  }>,
  agentId: string,
) => {
  for (const { toolName, toolParameters, toolDescription } of tools) {
    // Create or get the tool
    const tool = await ToolModel.createToolIfNotExists({
      name: toolName,
      parameters: toolParameters,
      description: toolDescription,
    });

    // Create the agent-tool relationship
    await AgentToolModel.createIfNotExists(agentId, tool.id);
  }
};

export * as adapters from "./adapters";
export * as toolInvocation from "./tool-invocation";
export * as trustedData from "./trusted-data";
