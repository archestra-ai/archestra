import type { VercelTools } from "@shared/vercel-ai/openai/conversion";
import { AgentModel, ToolModel } from "@/models";
import type { MagicalType } from "@/types";

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
  tools: MagicalType["tools"],
  agentId: string,
) => {
  for (const [name, tool] of Object.entries(tools) || []) {
    await ToolModel.createToolIfNotExists({
      agentId,
      name,
      parameters: tool.inputSchema,
      description: tool.description,
    });
  }
};

/**
 * Persist tools if present in the request
 */
export const persistToolsVercel = async (
  tools: VercelTools,
  agentId: string,
) => {
  for (const tool of tools || []) {
    await ToolModel.createToolIfNotExists({
      agentId,
      name: tool.name,
      parameters: "inputSchema" in tool ? tool.inputSchema : undefined,
      description: "description" in tool ? tool.description : undefined,
    });
  }
};

export * as streaming from "./streaming";
export * as toolInvocation from "./tool-invocation";
export * as trustedData from "./trusted-data";
