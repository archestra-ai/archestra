import { AgentModel } from "@/models";

/**
 * Get or create the default agent based on the user-agent header
 */
export const getAgentIdFromRequest = async (
  userAgentHeader?: string,
): Promise<string> =>
  (await AgentModel.getAgentOrCreateDefault(userAgentHeader)).id;

export * as tokenizers from "@/tokenizers";
export * as adapters from "./adapters";
export * as costOptimization from "./cost-optimization";
export * as externalAgentId from "./external-agent-id";
export * as toolInvocation from "./tool-invocation";
export * as tools from "./tools";
export * as toonConversion from "./toon-conversion";
export * as tracing from "./tracing";
export * as trustedData from "./trusted-data";
export * as userId from "./user-id";
