import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AGENT_TOOL_PREFIX,
  type ARCHESTRA_MCP_SERVER_NAME,
  type MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { ZodError, type ZodType } from "zod";
// Import all groups
import {
  toolArgsSchemas as agentToolArgsSchemas,
  toolShortNames as agentToolNames,
  tools as agentTools,
  handleTool as handleAgents,
} from "./agents";
import {
  toolArgsSchemas as chatToolArgsSchemas,
  toolShortNames as chatToolNames,
  tools as chatTools,
  handleTool as handleChat,
} from "./chat";
import { delegationToolArgsSchema, handleDelegation } from "./delegation";
import { errorResult, formatZodError } from "./helpers";
import {
  handleTool as handleIdentity,
  toolArgsSchemas as identityToolArgsSchemas,
  toolShortNames as identityToolNames,
  tools as identityTools,
} from "./identity";
import {
  handleTool as handleKnowledgeManagement,
  toolArgsSchemas as knowledgeManagementToolArgsSchemas,
  toolShortNames as knowledgeManagementToolNames,
  tools as knowledgeManagementTools,
} from "./knowledge-management";
import {
  handleTool as handleLimits,
  toolArgsSchemas as limitToolArgsSchemas,
  toolShortNames as limitToolNames,
  tools as limitTools,
} from "./limits";
import {
  handleTool as handleMcpServers,
  toolArgsSchemas as mcpServerToolArgsSchemas,
  toolShortNames as mcpServerToolNames,
  tools as mcpServerTools,
} from "./mcp-servers";
import {
  handleTool as handlePolicies,
  toolArgsSchemas as policyToolArgsSchemas,
  toolShortNames as policyToolNames,
  tools as policyTools,
} from "./policies";
import { checkToolPermission } from "./rbac";
import {
  handleTool as handleToolAssignment,
  toolArgsSchemas as toolAssignmentArgsSchemas,
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
export type ArchestraToolFullName =
  `${typeof ARCHESTRA_MCP_SERVER_NAME}${typeof MCP_SERVER_TOOL_NAME_SEPARATOR}${ArchestraToolShortName}`;

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

const toolArgsSchemas: Partial<Record<ArchestraToolFullName, ZodType>> = {
  ...identityToolArgsSchemas,
  ...agentToolArgsSchemas,
  ...mcpServerToolArgsSchemas,
  ...limitToolArgsSchemas,
  ...policyToolArgsSchemas,
  ...toolAssignmentArgsSchemas,
  ...knowledgeManagementToolArgsSchemas,
  ...chatToolArgsSchemas,
};

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
    const parsedArgs = validateToolArgs(
      delegationToolArgsSchema,
      args,
      toolName,
    );
    if ("error" in parsedArgs) {
      return parsedArgs.error;
    }
    return handleDelegation(toolName, parsedArgs.value, context);
  }

  // Centralized RBAC check — ensures the user has the required permission
  const rbacDenied = await checkToolPermission(toolName, context);
  if (rbacDenied) return rbacDenied;

  const schema = toolArgsSchemas[toolName as ArchestraToolFullName];
  if (schema) {
    const parsedArgs = validateToolArgs(schema, args, toolName);
    if ("error" in parsedArgs) {
      return parsedArgs.error;
    }
    args = parsedArgs.value;
  }

  try {
    for (const handler of handlers) {
      const result = await handler(toolName, args, context);
      if (result !== null) return result;
    }
  } catch (error) {
    if (error instanceof ZodError) {
      return errorResult(
        `Validation error in ${toolName}: ${formatZodError(error)}`,
      );
    }
    throw error;
  }

  // If no handler matched
  throw {
    code: -32601,
    message: `Tool '${toolName}' not found`,
  };
}

function validateToolArgs(
  schema: ZodType,
  args: Record<string, unknown> | undefined,
  toolName: string,
): { value: Record<string, unknown> } | { error: CallToolResult } {
  const parsed = schema.safeParse(args ?? {});

  if (parsed.success) {
    return { value: parsed.data as Record<string, unknown> };
  }

  return {
    error: errorResult(
      `Validation error in ${toolName}: ${formatZodError(parsed.error)}`,
    ),
  };
}
