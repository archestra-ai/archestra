import {
  ARCHESTRA_TOOL_PREFIX,
  type ArchestraToolFullName,
  type ArchestraToolShortName,
  getArchestraToolFullName,
  getArchestraToolShortName,
  isAgentTool,
  TOOL_DELETE_FILE_FULL_NAME,
  TOOL_EDIT_FILE_FULL_NAME,
  TOOL_READ_FILE_FULL_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SAVE_RESULT_FULL_NAME,
  TOOL_SEARCH_FILES_FULL_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError, type ZodType } from "zod";
import config from "@/config";
import { ToolModel } from "@/models";
// Import all groups
import { toolEntries as agentToolEntries, tools as agentTools } from "./agents";
import {
  toolEntries as appDataToolEntries,
  tools as appDataTools,
} from "./app-data";
import {
  toolEntries as appLlmToolEntries,
  tools as appLlmTools,
} from "./app-llm";
import { toolEntries as appToolEntries, tools as appTools } from "./apps";
import { archestraMcpBranding } from "./branding";
import { toolEntries as chatToolEntries, tools as chatTools } from "./chat";
import { delegationToolArgsSchema, handleDelegation } from "./delegation";
import { isDynamicallyAvailableArchestraTool } from "./dynamic-tools";
import {
  type ArchestraRuntimeToolEntry,
  errorResult,
  formatZodError,
  formatZodErrorWithSchema,
  structuredToolErrorResult,
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
  toolEntries as sandboxToolEntries,
  tools as sandboxTools,
} from "./sandbox";
import {
  toolEntries as searchToolEntries,
  tools as searchToolTools,
} from "./search-tools";
import { toolEntries as skillToolEntries, tools as skillTools } from "./skills";
import {
  toolEntries as toolAssignmentToolEntries,
  tools as toolAssignmentTools,
} from "./tool-assignment";
import { toolDiscoverySteer } from "./tool-recovery-messages";
import type { ArchestraContext } from "./types";

export { archestraMcpBranding } from "./branding";
export { getAgentTools } from "./delegation";
export { filterToolNamesByPermission } from "./rbac";
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
  ...skillToolEntries,
  ...sandboxToolEntries,
  ...appToolEntries,
  ...appDataToolEntries,
  ...appLlmToolEntries,
};

// App tools are registered above so they remain unit-testable, but when the
// feature is dark they must not be dispatchable even by exact name.
const appToolFullNames = new Set<string>([
  ...Object.keys(appToolEntries),
  ...Object.keys(appDataToolEntries),
  ...Object.keys(appLlmToolEntries),
]);

// search_files / read_file / save_result / edit_file / delete_file are the
// persistent-files (Projects) surface of the sandbox tool group. Registered above
// for unit tests, but hidden and non-dispatchable when the projects feature is dark.
const projectGatedSandboxFullNames = new Set<string>([
  TOOL_SEARCH_FILES_FULL_NAME,
  TOOL_READ_FILE_FULL_NAME,
  TOOL_SAVE_RESULT_FULL_NAME,
  TOOL_EDIT_FILE_FULL_NAME,
  TOOL_DELETE_FILE_FULL_NAME,
]);

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
    ...skillTools,
    ...(config.skillsSandbox.enabled
      ? config.projects.enabled
        ? sandboxTools
        : sandboxTools.filter((t) => !projectGatedSandboxFullNames.has(t.name))
      : []),
    ...(config.apps.enabled
      ? [...appTools, ...appDataTools, ...appLlmTools]
      : []),
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

  // Centralized assignment check — an agent may only execute Archestra tools
  // that are actually assigned to it (the same set advertised by tools/list and
  // search_tools). Without this, run_tool or a raw tools/call could invoke any
  // Archestra tool the user has RBAC for, regardless of assignment. A narrow
  // set of built-ins is exempt under dynamic tool access (see below).
  const assignmentDenied = await resolveToolAssignment(toolName, context);
  if (assignmentDenied) return assignmentDenied;

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
      message: `No tool named "${toolName}" exists. ${toolDiscoverySteer()}`,
    };
  }

  if (
    !config.apps.enabled &&
    resolvedToolName &&
    appToolFullNames.has(resolvedToolName)
  ) {
    throw {
      code: -32601,
      message: `No tool named "${toolName}" exists. ${toolDiscoverySteer()}`,
    };
  }

  if (
    !config.projects.enabled &&
    resolvedToolName &&
    projectGatedSandboxFullNames.has(resolvedToolName)
  ) {
    throw {
      code: -32601,
      message: `No tool named "${toolName}" exists. ${toolDiscoverySteer()}`,
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

// run_tool / search_tools are the dispatch surface (advertised implicitly in
// search_and_run_only mode), so they bypass the assignment check.
const ASSIGNMENT_EXEMPT_SHORT_NAMES = new Set<ArchestraToolShortName>([
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
]);

async function checkToolAssignedToAgent(
  toolName: string,
  context: ArchestraContext,
): Promise<CallToolResult | null> {
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  // Assignment is agent-scoped; org/team-token sessions rely on RBAC alone.
  if (!context.agentId || !shortName) return null;
  if (ASSIGNMENT_EXEMPT_SHORT_NAMES.has(shortName)) return null;

  const assignedTools = await ToolModel.getMcpToolsByAgent(context.agentId);
  const isAssigned = assignedTools.some(
    (tool) => archestraMcpBranding.getToolShortName(tool.name) === shortName,
  );
  if (isAssigned) return null;
  return structuredToolErrorResult({
    error: {
      type: "tool_state",
      code: "tool_not_assigned",
      message: `Tool "${toolName}" is not assigned to this agent. ${toolDiscoverySteer()}`,
      toolName,
    },
  });
}

// Assignment gate with the dynamic-access relaxation: an unassigned sandbox
// built-in (feature on) or query_knowledge_sources (user can access a knowledge
// connector) executes anyway when the agent's "access all tools" setting and
// the org kill-switch allow it — nothing is assigned. RBAC already ran before
// this gate, so e.g. the sandbox tools still require sandbox:execute.
async function resolveToolAssignment(
  toolName: string,
  context: ArchestraContext,
): Promise<CallToolResult | null> {
  const notAssigned = await checkToolAssignedToAgent(toolName, context);
  if (!notAssigned) return null;
  if (!context.agentId) return notAssigned;

  const dynamicallyAvailable = await isDynamicallyAvailableArchestraTool({
    toolName,
    agentId: context.agentId,
    userId: context.userId,
    organizationId: context.organizationId,
  });
  return dynamicallyAvailable ? null : notAssigned;
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

/** @public — exported for testability */
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
      `Validation error in ${toolName}: ${formatZodErrorWithSchema(
        parsed.error,
        schema,
      )}`,
    ),
  };
}
