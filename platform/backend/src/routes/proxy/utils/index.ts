import { AgentModel, ToolModel } from "@/models";
import type { OpenAiProxy } from "../types";

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
  tools: OpenAiProxy.ChatCompletionRequestTools,
  agentId: string,
) => {
  for (const tool of tools || []) {
    let toolName = "";
    let toolParameters: Record<string, unknown> | undefined;
    let toolDescription: string | undefined;

    if (tool.type === "function") {
      toolName = tool.function.name;
      toolParameters = tool.function.parameters;
      toolDescription = tool.function.description;
    } else {
      toolName = tool.custom.name;
      toolParameters = tool.custom.format;
      toolDescription = tool.custom.description;
    }

    await ToolModel.createToolIfNotExists({
      agentId,
      name: toolName,
      parameters: toolParameters,
      description: toolDescription,
    });
  }
};

export * as streaming from "./streaming";
export * as toolInvocation from "./tool-invocation";
export * as trustedData from "./trusted-data";
