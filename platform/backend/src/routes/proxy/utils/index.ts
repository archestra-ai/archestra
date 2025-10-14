import type OpenAI from "openai";
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
  tools: OpenAI.Chat.ChatCompletionTool[] | undefined,
  agentId: string,
) => {
  for (const tool of tools || []) {
    if (tool.type === "function") {
      await ToolModel.createToolIfNotExists({
        agentId,
        name: tool.function.name,
        parameters: tool.function.parameters,
        description: tool.function.description,
      });
    }
  }
};

export * as streaming from "./streaming";
export * as toolInvocation from "./tool-invocation";
export * as trustedData from "./trusted-data";
