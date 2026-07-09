import {
  ARCHESTRA_TOOL_PREFIX,
  type ArchestraToolFullName,
  type ArchestraToolShortName,
  getArchestraToolFullName,
  getArchestraToolShortName,
  isAgentTool,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError, type ZodType, z } from "zod";
import config from "@/config";
import { ToolModel } from "@/models";
import {
  type AgentToolExclusionSets,
  agentToolExclusionsService,
  isToolRowExcluded,
} from "@/services/agent-tool-exclusions";
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
import {
  toolEntries as projectToolEntries,
  tools as projectTools,
} from "./projects";
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
import { toolEntries as teamToolEntries, tools as teamTools } from "./teams";
import { toolParamsSkeleton } from "./tool-args-skeleton";
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

/**
 * Machine-readable descriptor of a tool-args validation failure, attached to
 * the error result as `_meta.archestraValidation`. Consumed by run_tool's
 * repair-note gate (run-tool.ts `reachedArgValidation`) to distinguish a
 * post-gate validation failure from an access denial. Like
 * `_meta.archestraError` (shared/mcp-tool-error.ts), it is result metadata
 * and reaches MCP gateway clients; it names only the tool and the issue
 * code/path set — a subset of the error text beside it.
 */
interface ArchestraValidationMeta {
  /** Resolved target tool (full/branded name), never the run_tool wrapper. */
  toolName: string;
  issues: Array<{ code: string; path: string }>;
}

const toolEntries: Partial<
  Record<ArchestraToolFullName, ArchestraRuntimeToolEntry>
> = {
  ...identityToolEntries,
  ...agentToolEntries,
  ...llmProxyToolEntries,
  ...mcpGatewayToolEntries,
  ...mcpServerToolEntries,
  ...teamToolEntries,
  ...limitToolEntries,
  ...policyToolEntries,
  ...toolAssignmentToolEntries,
  ...knowledgeManagementToolEntries,
  ...chatToolEntries,
  ...projectToolEntries,
  ...searchToolEntries,
  ...runToolEntries,
  ...skillToolEntries,
  ...sandboxToolEntries,
  ...appToolEntries,
  ...appDataToolEntries,
  ...appLlmToolEntries,
};

export function getArchestraMcpTools() {
  const tools = [
    ...identityTools,
    ...agentTools,
    ...llmProxyTools,
    ...mcpGatewayTools,
    ...mcpServerTools,
    ...teamTools,
    ...limitTools,
    ...policyTools,
    ...toolAssignmentTools,
    ...knowledgeManagementTools,
    ...chatTools,
    ...projectTools,
    ...searchToolTools,
    ...runToolTools,
    ...skillTools,
    ...(config.skillsSandbox.enabled ? sandboxTools : []),
    ...appTools,
    ...appDataTools,
    ...appLlmTools,
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

/**
 * JSON input schema of a built-in Archestra tool, resolved by its published
 * (branding-aware) full name or canonical `archestra__` name — derived from the
 * same zod schema `tools/list` advertises. Returns undefined for names that are
 * not built-ins (agent delegations, third-party names). Consumed by run_tool's
 * schema-aware envelope repair.
 */
export function getArchestraToolInputSchema(
  toolName: string,
): Record<string, unknown> | undefined {
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  if (!shortName) {
    return undefined;
  }
  const entry = toolEntries[getArchestraToolFullName(shortName)];
  if (!entry) {
    return undefined;
  }
  return z.toJSONSchema(entry.schema, { io: "input" }) as Record<
    string,
    unknown
  >;
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
  // Archestra tool the user has RBAC for, regardless of assignment. Under
  // dynamic tool access ("access all tools") unassigned built-ins are exempt
  // (see below).
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
      return zodValidationErrorResult({ toolName, error });
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
  exclusionSets: AgentToolExclusionSets,
): Promise<CallToolResult | null> {
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  // Assignment is agent-scoped; org/team-token sessions rely on RBAC alone.
  if (!context.agentId || !shortName) return null;
  if (ASSIGNMENT_EXEMPT_SHORT_NAMES.has(shortName)) return null;

  const assignedTools = await ToolModel.getMcpToolsByAgent(context.agentId);
  // Per-agent exclusions (Auto-tool mode): an assigned-but-excluded built-in
  // is treated as unavailable — the sets are empty unless the agent's
  // accessAllTools setting is on, so Custom mode is unchanged.
  const isAssigned = assignedTools.some(
    (tool) =>
      archestraMcpBranding.getToolShortName(tool.name) === shortName &&
      !isToolRowExcluded(tool, exclusionSets),
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

// Assignment gate with the dynamic-access relaxation: an unassigned built-in
// executes anyway when the agent's "access all tools" setting allows it and
// isDynamicallyAvailableArchestraTool passes (feature gates, per-agent
// exclusions, and the query_knowledge_sources connector check) — nothing is
// assigned. RBAC already ran before this gate, so e.g. the sandbox tools
// still require sandbox:execute.
async function resolveToolAssignment(
  toolName: string,
  context: ArchestraContext,
): Promise<CallToolResult | null> {
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  // Assignment is agent-scoped; org/team-token sessions rely on RBAC alone.
  if (!context.agentId || !shortName) return null;
  // The dispatch-surface tools are exempt from the assignment gate —
  // short-circuit BEFORE loading exclusion sets so every run_tool /
  // search_tools invocation skips the extra queries (excluding these tools is
  // also rejected at write time).
  if (ASSIGNMENT_EXEMPT_SHORT_NAMES.has(shortName)) return null;

  // Loaded once per invocation and threaded through both gates. Empty (no-op)
  // unless the agent has accessAllTools on and exclusions configured.
  const exclusionSets = await agentToolExclusionsService.getActiveExclusionSets(
    context.agentId,
  );
  const notAssigned = await checkToolAssignedToAgent(
    toolName,
    context,
    exclusionSets,
  );
  if (!notAssigned) return null;

  const dynamicallyAvailable = await isDynamicallyAvailableArchestraTool({
    toolName,
    agentId: context.agentId,
    userId: context.userId,
    organizationId: context.organizationId,
    exclusionSets,
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
  zodValidationErrorResult,
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
    error: zodValidationErrorResult({ toolName, error: parsed.error, schema }),
  };
}

/**
 * Shared error-result builder for a tool-args ZodError: the per-issue error
 * text, a schema-derived parameter skeleton so the model can restructure the
 * call on its first failure (the built-in counterpart of run_tool's
 * third-party "Send instead:" pre-check), and machine-readable
 * `_meta.archestraValidation`, which gates run_tool's repair-note disclosure
 * (run-tool.ts). `toolName` is the resolved dispatch target, so
 * run_tool-wrapped failures carry the target's name, not the wrapper's.
 *
 * `schema` is absent only on the handler-thrown ZodError path: such an error
 * may come from an internal parse of a different shape, so a skeleton of the
 * tool's input schema would mislead — those results carry the error text only.
 */
function zodValidationErrorResult(params: {
  toolName: string;
  error: ZodError;
  schema?: ZodType;
}): CallToolResult {
  const { toolName, error, schema } = params;
  const details = schema
    ? formatZodErrorWithSchema(error, schema)
    : formatZodError(error);
  const meta: ArchestraValidationMeta = {
    toolName,
    issues: error.issues.map((issue) => ({
      code: issue.code ?? "custom",
      path: issue.path.map((segment) => String(segment)).join("."),
    })),
  };
  const lines = [`Validation error in ${toolName}: ${details}`];
  const skeleton = schema ? inputSchemaSkeleton(schema) : null;
  if (skeleton) {
    const requiredNote =
      skeleton.required.length > 0
        ? `; required: ${skeleton.required.map((key) => JSON.stringify(key)).join(", ")}`
        : "";
    lines.push(
      `The tool's parameters are shaped like ${skeleton.skeleton} (replace each <…> with a real value${requiredNote}).`,
    );
  }
  return {
    ...errorResult(lines.join("\n")),
    _meta: { archestraValidation: meta },
  };
}

/**
 * Top-level parameter skeleton of a tool's Zod input schema, via its published
 * JSON form. Best-effort: null when the schema cannot be converted or declares
 * no readable properties — the error text still stands alone.
 */
function inputSchemaSkeleton(
  schema: ZodType,
): { skeleton: string; required: string[] } | null {
  try {
    return toolParamsSkeleton(z.toJSONSchema(schema, { io: "input" }));
  } catch {
    return null;
  }
}
