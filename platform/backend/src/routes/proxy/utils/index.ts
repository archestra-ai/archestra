import { AgentModel } from "@/models";

/**
 * Get or create the default agent based on the user-agent header
 */
export const getAgentIdFromRequest = async (
  userAgentHeader?: string,
): Promise<string> =>
  (await AgentModel.getAgentOrCreateDefault(userAgentHeader)).id;

export * as adapters from "./adapters";
export * as toolInvocation from "./tool-invocation";
export * as tools from "./tools";
export * as tracing from "./tracing";
export * as trustedData from "./trusted-data";
