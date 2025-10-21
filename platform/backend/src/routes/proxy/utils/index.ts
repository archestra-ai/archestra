import { AgentModel, ToolModel } from "@/models";

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
    await ToolModel.createToolIfNotExists({
      agentId,
      name: toolName,
      parameters: toolParameters,
      description: toolDescription,
      toolResultTreatment: "untrusted", // Default to untrusted for new tools
    });
  }
};

export * as adapters from "./adapters";
export * as streaming from "./streaming";
export * as toolInvocation from "./tool-invocation";
export * as trustedData from "./trusted-data";
