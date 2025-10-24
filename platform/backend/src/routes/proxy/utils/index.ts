import { AgentModel } from "@/models";

/**
 * Get or create the default agent with the standard default name
 */
export const getAgentIdFromRequest = async (): Promise<string> =>
  (await AgentModel.getAgentOrCreateDefault(undefined)).id;

export * as adapters from "./adapters";
export * as toolInvocation from "./tool-invocation";
export * as tools from "./tools";
export * as trustedData from "./trusted-data";
