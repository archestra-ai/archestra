import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AGENT_TOOL_PREFIX } from "@shared";
// Import all groups
import {
  toolShortNames as agentToolNames,
  tools as agentTools,
  handleTool as handleAgents,
} from "./agents";
import {
  toolShortNames as chatToolNames,
  tools as chatTools,
  handleTool as handleChat,
} from "./chat";
import { handleDelegation } from "./delegation";
import {
  handleTool as handleIdentity,
  toolShortNames as identityToolNames,
  tools as identityTools,
} from "./identity";
import {
  handleTool as handleKnowledgeManagement,
  toolShortNames as knowledgeManagementToolNames,
  tools as knowledgeManagementTools,
} from "./knowledge-management";
import {
  handleTool as handleLimits,
  toolShortNames as limitToolNames,
  tools as limitTools,
} from "./limits";
import {
  handleTool as handleMcpServers,
  toolShortNames as mcpServerToolNames,
  tools as mcpServerTools,
} from "./mcp-servers";
import {
  handleTool as handlePolicies,
  toolShortNames as policyToolNames,
  tools as policyTools,
} from "./policies";
import { checkToolPermission } from "./rbac";
import {
  handleTool as handleToolAssignment,
  toolShortNames as toolAssignmentToolNames,
  tools as toolAssignmentTools,
} from "./tool-assignment";
import type { ArchestraContext } from "./types";

export { getAgentTools } from "./delegation";
export { filterToolNamesByPermission, TOOL_PERMISSIONS } from "./rbac";
export type { ArchestraContext } from "./types";

export const ALL_TOOL_SHORT_NAMES = [
  ...identityToolNames,
  ...agentToolNames,
  ...mcpServerToolNames,
  ...limitToolNames,
  ...policyToolNames,
  ...toolAssignmentToolNames,
  ...knowledgeManagementToolNames,
  ...chatToolNames,
] as const;

export type ArchestraToolShortName = (typeof ALL_TOOL_SHORT_NAMES)[number];

const handlers = [
  handleIdentity,
  handleAgents,
  handleMcpServers,
  handleLimits,
  handlePolicies,
  handleToolAssignment,
  handleKnowledgeManagement,
  handleChat,
];

export function getArchestraMcpTools() {
  return [
    ...identityTools,
    ...agentTools,
    ...mcpServerTools,
    ...limitTools,
    ...policyTools,
    ...toolAssignmentTools,
    ...knowledgeManagementTools,
    ...chatTools,
  ];
}

export async function executeArchestraTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  context: ArchestraContext,
): Promise<CallToolResult> {
  // Agent delegation tools are dynamic (one per agent) and not in TOOL_PERMISSIONS,
  // so they bypass centralized RBAC. They enforce team-based access checks internally.
  if (toolName.startsWith(AGENT_TOOL_PREFIX)) {
    return handleDelegation(toolName, args, context);
  }

  // Centralized RBAC check — ensures the user has the required permission
  const rbacDenied = await checkToolPermission(toolName, context);
  if (rbacDenied) return rbacDenied;

  // Try each group handler
  for (const handler of handlers) {
    const result = await handler(toolName, args, context);
    if (result !== null) return result;
  }

  // If no handler matched
  throw {
    code: -32601,
    message: `Tool '${toolName}' not found`,
  };
}
