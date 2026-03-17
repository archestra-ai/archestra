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
  toolOutputSchemas as agentToolOutputSchemas,
  tools as agentTools,
  handleTool as handleAgents,
} from "./agents";
import {
  toolArgsSchemas as chatToolArgsSchemas,
  toolShortNames as chatToolNames,
  toolOutputSchemas as chatToolOutputSchemas,
  tools as chatTools,
  handleTool as handleChat,
} from "./chat";
import { delegationToolArgsSchema, handleDelegation } from "./delegation";
import { errorResult, formatZodError } from "./helpers";
import {
  handleTool as handleIdentity,
  toolArgsSchemas as identityToolArgsSchemas,
  toolShortNames as identityToolNames,
  toolOutputSchemas as identityToolOutputSchemas,
  tools as identityTools,
} from "./identity";
import {
  handleTool as handleKnowledgeManagement,
  toolArgsSchemas as knowledgeManagementToolArgsSchemas,
  toolShortNames as knowledgeManagementToolNames,
  toolOutputSchemas as knowledgeManagementToolOutputSchemas,
  tools as knowledgeManagementTools,
} from "./knowledge-management";
import {
  handleTool as handleLimits,
  toolArgsSchemas as limitToolArgsSchemas,
  toolShortNames as limitToolNames,
  toolOutputSchemas as limitToolOutputSchemas,
  tools as limitTools,
} from "./limits";
import {
  handleTool as handleLlmProxies,
  toolArgsSchemas as llmProxyToolArgsSchemas,
  toolShortNames as llmProxyToolNames,
  toolOutputSchemas as llmProxyToolOutputSchemas,
  tools as llmProxyTools,
} from "./llm-proxies";
import {
  handleTool as handleMcpGateways,
  toolArgsSchemas as mcpGatewayToolArgsSchemas,
  toolShortNames as mcpGatewayToolNames,
  toolOutputSchemas as mcpGatewayToolOutputSchemas,
  tools as mcpGatewayTools,
} from "./mcp-gateways";
import {
  handleTool as handleMcpServers,
  toolArgsSchemas as mcpServerToolArgsSchemas,
  toolShortNames as mcpServerToolNames,
  toolOutputSchemas as mcpServerToolOutputSchemas,
  tools as mcpServerTools,
} from "./mcp-servers";
import {
  handleTool as handlePolicies,
  toolArgsSchemas as policyToolArgsSchemas,
  toolShortNames as policyToolNames,
  toolOutputSchemas as policyToolOutputSchemas,
  tools as policyTools,
} from "./policies";
import { checkToolPermission } from "./rbac";
import {
  handleTool as handleToolAssignment,
  toolArgsSchemas as toolAssignmentArgsSchemas,
  toolOutputSchemas as toolAssignmentOutputSchemas,
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
  ...llmProxyToolNames,
  ...mcpGatewayToolNames,
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
  handleLlmProxies,
  handleMcpGateways,
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
  ...llmProxyToolArgsSchemas,
  ...mcpGatewayToolArgsSchemas,
  ...mcpServerToolArgsSchemas,
  ...limitToolArgsSchemas,
  ...policyToolArgsSchemas,
  ...toolAssignmentArgsSchemas,
  ...knowledgeManagementToolArgsSchemas,
  ...chatToolArgsSchemas,
};

const toolOutputSchemas: Partial<Record<ArchestraToolFullName, ZodType>> = {
  ...identityToolOutputSchemas,
  ...agentToolOutputSchemas,
  ...llmProxyToolOutputSchemas,
  ...mcpGatewayToolOutputSchemas,
  ...mcpServerToolOutputSchemas,
  ...limitToolOutputSchemas,
  ...policyToolOutputSchemas,
  ...toolAssignmentOutputSchemas,
  ...knowledgeManagementToolOutputSchemas,
  ...chatToolOutputSchemas,
};

export function getArchestraMcpTools() {
  return [
    ...identityTools,
    ...agentTools,
    ...llmProxyTools,
    ...mcpGatewayTools,
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
      if (result !== null) {
        const outputSchema =
          toolOutputSchemas[toolName as ArchestraToolFullName];
        if (outputSchema) {
          const validatedResult = validateToolResult(
            outputSchema,
            result,
            toolName,
          );
          if ("error" in validatedResult) {
            return validatedResult.error;
          }
          return validatedResult.value;
        }

        return result;
      }
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

function validateToolResult(
  schema: ZodType,
  result: CallToolResult,
  toolName: string,
): { value: CallToolResult } | { error: CallToolResult } {
  if (result.isError) {
    return { value: result };
  }

  const parsed = schema.safeParse(result.structuredContent);

  if (parsed.success) {
    return {
      value: {
        ...result,
        structuredContent: parsed.data as Record<string, unknown>,
      },
    };
  }

  return {
    error: errorResult(
      `Internal output validation error in ${toolName}: ${formatZodError(parsed.error)}`,
    ),
  };
}

export const __test = {
  validateToolResult,
};

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
