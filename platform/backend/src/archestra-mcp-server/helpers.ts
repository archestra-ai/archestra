import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { ZodError, type ZodType, z } from "zod";
import logger from "@/logging";
import { AgentModel, AgentToolModel, ToolModel } from "@/models";
import { assignToolToAgent } from "@/routes/agent-tool";

/**
 * Convert a name to a URL-safe slug for tool naming
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "AbortError") {
    return true;
  }

  // Match "aborted" as a whole word to avoid false positives
  // (e.g., "aborting transaction due to constraint violation")
  return /\baborted?\b/i.test(error.message);
}

export type McpServerResult = {
  id: string;
  status: string;
  toolCount?: number;
  error?: string;
};
export type SubAgentResult = { id: string; status: string };
export type ToolAssignmentInput = {
  toolId: string;
  credentialSourceMcpServerId?: string | null;
  executionSourceMcpServerId?: string | null;
  useDynamicTeamCredential?: boolean;
};
export type ToolAssignmentResult = {
  toolId: string;
  status: string;
  error?: string;
};
export type ArchestraToolDefinition<ShortName extends string = string> = {
  shortName: ShortName;
  title: string;
  description: string;
  schema: ZodType;
};

export const EmptyToolArgsSchema = z.strictObject({});

export async function assignMcpServerTools(
  agentId: string,
  mcpServerIds: string[],
): Promise<McpServerResult[]> {
  const results: McpServerResult[] = [];
  for (const mcpServerId of mcpServerIds) {
    try {
      const tools = await ToolModel.findByCatalogId(mcpServerId);
      if (tools.length === 0) {
        results.push({ id: mcpServerId, status: "no_tools" });
        continue;
      }

      const assignmentResults = await Promise.all(
        tools.map((tool) =>
          assignToolToAgent(agentId, tool.id, undefined, undefined),
        ),
      );
      const failed = assignmentResults.filter(
        (result) =>
          result !== null && result !== "duplicate" && result !== "updated",
      );

      if (failed.length > 0) {
        const errors = [
          ...new Set(failed.map((result) => result.error.message)),
        ];
        results.push({
          id: mcpServerId,
          status:
            failed.length === assignmentResults.length
              ? "validation_failed"
              : "partial_success",
          toolCount: assignmentResults.length - failed.length,
          error: errors.join("; "),
        });
        continue;
      }

      results.push({
        id: mcpServerId,
        status: "success",
        toolCount: tools.length,
      });
    } catch (error) {
      logger.error(
        { err: error, mcpServerId },
        "Error assigning MCP server tools",
      );
      results.push({ id: mcpServerId, status: "error" });
    }
  }
  return results;
}

export async function assignToolAssignments(
  agentId: string,
  assignments: ToolAssignmentInput[],
): Promise<ToolAssignmentResult[]> {
  const results: ToolAssignmentResult[] = [];

  for (const assignment of assignments) {
    try {
      const result = await assignToolToAgent(
        agentId,
        assignment.toolId,
        assignment.credentialSourceMcpServerId,
        assignment.executionSourceMcpServerId,
        undefined,
        assignment.useDynamicTeamCredential,
      );

      if (result === null || result === "updated") {
        results.push({ toolId: assignment.toolId, status: "success" });
        continue;
      }

      if (result === "duplicate") {
        results.push({ toolId: assignment.toolId, status: "duplicate" });
        continue;
      }

      results.push({
        toolId: assignment.toolId,
        status: "error",
        error: result.error.message,
      });
    } catch (error) {
      logger.error(
        { err: error, toolId: assignment.toolId },
        "Error assigning tool to agent",
      );
      results.push({
        toolId: assignment.toolId,
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return results;
}

export async function assignSubAgentDelegations(
  agentId: string,
  subAgentIds: string[],
): Promise<SubAgentResult[]> {
  const results: SubAgentResult[] = [];
  for (const subAgentId of subAgentIds) {
    try {
      const targetAgent = await AgentModel.findById(subAgentId);
      if (!targetAgent) {
        results.push({ id: subAgentId, status: "not_found" });
        continue;
      }
      if (targetAgent.agentType !== "agent") {
        results.push({ id: subAgentId, status: "invalid_target" });
        continue;
      }
      if (subAgentId === agentId) {
        results.push({ id: subAgentId, status: "self_delegation_blocked" });
        continue;
      }
      await AgentToolModel.assignDelegation(agentId, subAgentId);
      results.push({ id: subAgentId, status: "success" });
    } catch (error) {
      logger.error(
        { err: error, subAgentId },
        "Error assigning sub-agent delegation",
      );
      results.push({ id: subAgentId, status: "error" });
    }
  }
  return results;
}

export function formatAssignmentSummary(
  lines: string[],
  mcpServerResults: McpServerResult[],
  subAgentResults: SubAgentResult[],
  toolAssignmentResults: ToolAssignmentResult[] = [],
): void {
  if (mcpServerResults.length > 0) {
    lines.push(
      "",
      "MCP Server Tool Assignments:",
      ...mcpServerResults.map(
        (r) =>
          `  - ${r.id}: ${r.status}${r.toolCount ? ` (${r.toolCount} tools)` : ""}${r.error ? ` - ${r.error}` : ""}`,
      ),
    );
  }
  if (subAgentResults.length > 0) {
    lines.push(
      "",
      "Sub-Agent Delegations:",
      ...subAgentResults.map((r) => `  - ${r.id}: ${r.status}`),
    );
  }
  if (toolAssignmentResults.length > 0) {
    lines.push(
      "",
      "Tool Assignments:",
      ...toolAssignmentResults.map(
        (r) => `  - ${r.toolId}: ${r.status}${r.error ? ` - ${r.error}` : ""}`,
      ),
    );
  }
}

export function deduplicateLabels(
  rawLabels: Array<{ key: string; value: string }>,
): Array<{ key: string; value: string }> {
  return Array.from(new Map(rawLabels.map((l) => [l.key, l])).values());
}

export function successResult(text: string): CallToolResult {
  return {
    content: [{ type: "text" as const, text }],
    isError: false,
  };
}

export function createToolDefinition(params: {
  name: string;
  title: string;
  description: string;
  schema: ZodType;
}): Tool {
  return {
    name: params.name,
    title: params.title,
    description: params.description,
    inputSchema: z.toJSONSchema(params.schema, {
      io: "input",
    }) as Tool["inputSchema"],
    annotations: {},
    _meta: {},
  };
}

export function defineArchestraTools<
  const Definitions extends readonly ArchestraToolDefinition[],
>(definitions: Definitions) {
  type ShortName = Definitions[number]["shortName"];
  type FullName<Name extends string> =
    `${typeof ARCHESTRA_MCP_SERVER_NAME}${typeof MCP_SERVER_TOOL_NAME_SEPARATOR}${Name}`;

  const toolShortNames = definitions.map(
    (definition) => definition.shortName,
  ) as {
    [Index in keyof Definitions]: Definitions[Index]["shortName"];
  };

  const toolFullNames: Record<string, string> = {};
  const toolArgsSchemas: Record<string, ZodType> = {};

  for (const definition of definitions) {
    const shortName = definition.shortName as ShortName;
    const fullName =
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${definition.shortName}` as FullName<ShortName>;

    toolFullNames[shortName] = fullName;
    toolArgsSchemas[fullName] = definition.schema;
  }

  const tools = definitions.map((definition) =>
    createToolDefinition({
      name: toolFullNames[definition.shortName as ShortName],
      title: definition.title,
      description: definition.description,
      schema: definition.schema,
    }),
  );

  return {
    toolShortNames,
    toolFullNames: toolFullNames as {
      [Definition in Definitions[number] as Definition["shortName"]]: FullName<
        Definition["shortName"]
      >;
    },
    toolArgsSchemas: toolArgsSchemas as {
      [Definition in Definitions[number] as FullName<
        Definition["shortName"]
      >]: Definition["schema"];
    },
    tools,
  };
}

export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

export function catchError(error: unknown, action: string): CallToolResult {
  logger.error({ err: error }, `Error ${action}`);
  // Zod validation errors are safe to surface — they describe user input issues.
  if (error instanceof ZodError) {
    return errorResult(
      `Validation error while ${action}: ${formatZodError(error)}`,
    );
  }
  // Unique constraint violations are user-actionable (e.g., duplicate name).
  if (isUniqueConstraintError(error)) {
    return errorResult(
      `A record with the same value already exists (${action})`,
    );
  }
  // All other errors get a generic message to avoid leaking internal details.
  return errorResult(`An internal error occurred while ${action}`);
}

// === Internal helpers ===

export function formatZodError(error: ZodError): string {
  return error.issues.map(formatZodIssue).join("; ");
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // PostgreSQL unique_violation code
  return "code" in error && (error as { code: string }).code === "23505";
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
  const path = formatIssuePath(issue.path);
  return path ? `${path}: ${issue.message}` : issue.message;
}

function formatIssuePath(path: PropertyKey[] | undefined): string {
  if (!path || path.length === 0) {
    return "";
  }

  return path
    .map((segment, index) => {
      if (typeof segment === "number") {
        return `[${segment}]`;
      }

      const key = String(segment);
      return index === 0 ? key : `.${key}`;
    })
    .join("");
}
