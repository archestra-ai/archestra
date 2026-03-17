import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AGENT_TOOL_PREFIX,
  type ARCHESTRA_MCP_SERVER_NAME,
  type MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { ZodError, type ZodType } from "zod";
// Import all groups
import {
  toolEntries as agentToolEntries,
  toolShortNames as agentToolNames,
  tools as agentTools,
} from "./agents";
import {
  toolEntries as chatToolEntries,
  toolShortNames as chatToolNames,
  tools as chatTools,
} from "./chat";
import { delegationToolArgsSchema, handleDelegation } from "./delegation";
import {
  type ArchestraRuntimeToolEntry,
  errorResult,
  formatZodError,
} from "./helpers";
import {
  toolEntries as identityToolEntries,
  toolShortNames as identityToolNames,
  tools as identityTools,
} from "./identity";
import {
  toolEntries as knowledgeManagementToolEntries,
  toolShortNames as knowledgeManagementToolNames,
  tools as knowledgeManagementTools,
} from "./knowledge-management";
import {
  toolEntries as limitToolEntries,
  toolShortNames as limitToolNames,
  tools as limitTools,
} from "./limits";
import {
  toolEntries as llmProxyToolEntries,
  toolShortNames as llmProxyToolNames,
  tools as llmProxyTools,
} from "./llm-proxies";
import {
  toolEntries as mcpGatewayToolEntries,
  toolShortNames as mcpGatewayToolNames,
  tools as mcpGatewayTools,
} from "./mcp-gateways";
import {
  toolEntries as mcpServerToolEntries,
  toolShortNames as mcpServerToolNames,
  tools as mcpServerTools,
} from "./mcp-servers";
import {
  toolEntries as policyToolEntries,
  toolShortNames as policyToolNames,
  tools as policyTools,
} from "./policies";
import { checkToolPermission } from "./rbac";
import {
  toolEntries as toolAssignmentToolEntries,
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

const toolEntries: Partial<
  Record<ArchestraToolFullName, ArchestraRuntimeToolEntry>
> = {
  ...identityToolEntries,
  ...agentToolEntries,
  ...llmProxyToolEntries,
  ...mcpGatewayToolEntries,
  ...mcpServerToolEntries,
  ...limitToolEntries,
  ...policyToolEntries,
  ...toolAssignmentToolEntries,
  ...knowledgeManagementToolEntries,
  ...chatToolEntries,
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

  const toolEntry = toolEntries[toolName as ArchestraToolFullName];
  if (!toolEntry) {
    throw {
      code: -32601,
      message: `Tool '${toolName}' not found`,
    };
  }

  const parsedArgs = validateToolArgs(toolEntry.schema, args, toolName);
  if ("error" in parsedArgs) {
    return parsedArgs.error;
  }

  try {
    const result = await toolEntry.invoke({
      args: parsedArgs.value,
      context,
      toolName,
    });

    if (toolEntry.outputSchema) {
      const validatedResult = validateToolResult(
        toolEntry.outputSchema,
        result,
        toolName,
      );
      if ("error" in validatedResult) {
        return validatedResult.error;
      }
      return validatedResult.value;
    }

    return result;
  } catch (error) {
    if (error instanceof ZodError) {
      return errorResult(
        `Validation error in ${toolName}: ${formatZodError(error)}`,
      );
    }
    throw error;
  }
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
