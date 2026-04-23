import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ARCHESTRA_TOOL_PREFIX,
  type ArchestraToolFullName,
  getArchestraToolFullName,
  getArchestraToolShortName,
  isAgentTool,
} from "@shared";
import { ZodError, type ZodType } from "zod";
// Import all groups
import { toolEntries as agentToolEntries, tools as agentTools } from "./agents";
import { archestraMcpBranding } from "./branding";
import { toolEntries as chatToolEntries, tools as chatTools } from "./chat";
import { delegationToolArgsSchema, handleDelegation } from "./delegation";
import {
  type ArchestraRuntimeToolEntry,
  errorResult,
  formatZodError,
} from "./helpers";
import {
  toolEntries as identityToolEntries,
  tools as identityTools,
} from "./identity";
import {
  toolEntries as knowledgeManagementToolEntries,
  tools as knowledgeManagementTools,
} from "./knowledge-management";
import { toolEntries as limitToolEntries, tools as limitTools } from "./limits";
import {
  toolEntries as llmProxyToolEntries,
  tools as llmProxyTools,
} from "./llm-proxies";
import {
  toolEntries as mcpGatewayToolEntries,
  tools as mcpGatewayTools,
} from "./mcp-gateways";
import {
  toolEntries as mcpServerToolEntries,
  tools as mcpServerTools,
} from "./mcp-servers";
import {
  toolEntries as policyToolEntries,
  tools as policyTools,
} from "./policies";
import { checkToolPermission } from "./rbac";
import {
  toolEntries as runToolEntries,
  tools as runToolTools,
} from "./run-tool";
import {
  toolEntries as searchToolEntries,
  tools as searchToolTools,
} from "./search-tools";
import {
  toolEntries as toolAssignmentToolEntries,
  tools as toolAssignmentTools,
} from "./tool-assignment";
import type { ArchestraContext } from "./types";

export { archestraMcpBranding } from "./branding";
export { getAgentTools } from "./delegation";
export { filterToolNamesByPermission, TOOL_PERMISSIONS } from "./rbac";
export type { ArchestraContext } from "./types";

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
  ...searchToolEntries,
  ...runToolEntries,
};

export function getArchestraMcpTools() {
  const tools = [
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
    ...searchToolTools,
    ...runToolTools,
  ];

  if (archestraMcpBranding.toolPrefix === ARCHESTRA_TOOL_PREFIX) {
    return tools;
  }

  return tools.map((tool) => {
    const shortName = getArchestraToolShortName(tool.name);
    if (!shortName) {
      return tool;
    }

    return {
      ...tool,
      name: archestraMcpBranding.getToolName(shortName),
    };
  });
}

export async function executeArchestraTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  context: ArchestraContext,
): Promise<CallToolResult> {
  // Agent delegation tools are dynamic (one per agent) and not in TOOL_PERMISSIONS,
  // so they bypass centralized RBAC. They enforce team-based access checks internally.
  if (isAgentTool(toolName)) {
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

  const resolvedToolName =
    toolEntries[toolName as ArchestraToolFullName] != null
      ? toolName
      : resolveArchestraToolName(toolName);
  const toolEntry = resolvedToolName
    ? toolEntries[resolvedToolName as ArchestraToolFullName]
    : undefined;
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

function resolveArchestraToolName(toolName: string): string | null {
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  if (!shortName) {
    return null;
  }

  return getArchestraToolFullName(shortName);
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
