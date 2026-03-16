import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { z } from "zod";
import {
  getAgentTypePermissionChecker,
  requireAgentModifyPermission,
} from "@/auth/agent-type-permissions";
import logger from "@/logging";
import { AgentModel, TeamModel } from "@/models";
import { assignToolToAgent } from "@/routes/agent-tool";
import { AgentToolAssignmentInputSchema, UuidIdSchema } from "@/types";
import {
  catchError,
  createToolDefinition,
  errorResult,
  successResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

const TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_NAME = "bulk_assign_tools_to_agents";
const TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_NAME =
  "bulk_assign_tools_to_mcp_gateways";

const TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_NAME}`;
const TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_NAME}`;

export const toolShortNames = [
  "bulk_assign_tools_to_agents",
  "bulk_assign_tools_to_mcp_gateways",
] as const;

const AgentAssignmentSchema = AgentToolAssignmentInputSchema.extend({
  agentId: UuidIdSchema,
});

const McpGatewayAssignmentSchema = AgentToolAssignmentInputSchema.extend({
  mcpGatewayId: UuidIdSchema,
});

export const toolArgsSchemas = {
  [TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_FULL_NAME]: z.object({
    assignments: z.array(AgentAssignmentSchema),
  }),
  [TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_FULL_NAME]: z.object({
    assignments: z.array(McpGatewayAssignmentSchema),
  }),
} as const;

// === Exports ===

export const tools: Tool[] = [
  createToolDefinition({
    name: TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_FULL_NAME,
    title: "Bulk Assign Tools to Agents",
    description:
      "Assign multiple tools to multiple agents in bulk with validation and error handling",
    schema: toolArgsSchemas[TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_FULL_NAME],
  }),
  createToolDefinition({
    name: TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_FULL_NAME,
    title: "Bulk Assign Tools to MCP Gateways",
    description:
      "Assign multiple tools to multiple MCP gateways in bulk with validation and error handling",
    schema: toolArgsSchemas[TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_FULL_NAME],
  }),
];

export async function handleTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  context: ArchestraContext,
): Promise<CallToolResult | null> {
  if (
    toolName !== TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_FULL_NAME &&
    toolName !== TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_FULL_NAME
  ) {
    return null;
  }

  const { agent: contextAgent } = context;

  const bulkAssignTypeMap: Record<string, string> = {
    [TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_FULL_NAME]: "agent",
    [TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_FULL_NAME]: "mcp_gateway",
  };
  const bulkAssignType = bulkAssignTypeMap[toolName];
  const idField = bulkAssignType === "agent" ? "agentId" : "mcpGatewayId";
  const bulkAssignLabel =
    bulkAssignType === "agent" ? "agents" : "MCP gateways";

  logger.info(
    {
      agentId: contextAgent.id,
      assignments: args?.assignments,
      type: bulkAssignType,
    },
    `bulk_assign_tools_to_${bulkAssignType === "agent" ? "agents" : "mcp_gateways"} tool called`,
  );

  try {
    if (!context.userId || !context.organizationId) {
      return errorResult("user/organization context not available.");
    }

    // biome-ignore lint/suspicious/noExplicitAny: dynamic property access by idField
    const assignments = args?.assignments as Array<Record<string, any>>;

    const uniqueTargetIds = [...new Set(assignments.map((a) => a[idField]))];
    const [targetAgents, checker] = await Promise.all([
      AgentModel.findByIdsForPermissionCheck(uniqueTargetIds),
      getAgentTypePermissionChecker({
        userId: context.userId,
        organizationId: context.organizationId,
      }),
    ]);

    let userTeamIds: string[] | null = null;
    const results = await Promise.allSettled(
      assignments.map(async (assignment) => {
        const target = targetAgents.get(assignment[idField]);
        if (target) {
          checker.require(target.agentType, "update");
          if (!checker.isAdmin(target.agentType) && userTeamIds === null) {
            userTeamIds = await TeamModel.getUserTeamIds(context.userId);
          }
          requireAgentModifyPermission({
            checker,
            agentType: target.agentType,
            agentScope: target.scope,
            agentAuthorId: target.authorId,
            agentTeamIds: target.teamIds,
            userTeamIds: userTeamIds ?? [],
            userId: context.userId,
          });
        }

        return assignToolToAgent(
          assignment[idField],
          assignment.toolId,
          assignment.credentialSourceMcpServerId,
          assignment.executionSourceMcpServerId,
          undefined,
          assignment.useDynamicTeamCredential,
        );
      }),
    );

    const succeeded: { [key: string]: string }[] = [];
    const failed: { [key: string]: string }[] = [];
    const duplicates: { [key: string]: string }[] = [];

    results.forEach((result, index) => {
      const entityId = assignments[index][idField];
      const { toolId } = assignments[index];
      if (result.status === "fulfilled") {
        if (result.value === null || result.value === "updated") {
          succeeded.push({ [idField]: entityId, toolId });
        } else if (result.value === "duplicate") {
          duplicates.push({ [idField]: entityId, toolId });
        } else {
          const error = result.value.error.message || "Unknown error";
          failed.push({ [idField]: entityId, toolId, error });
        }
      } else if (result.status === "rejected") {
        const error =
          result.reason instanceof Error
            ? result.reason.message
            : "Unknown error";
        failed.push({ [idField]: entityId, toolId, error });
      }
    });

    return successResult(
      JSON.stringify({ succeeded, failed, duplicates }, null, 2),
    );
  } catch (error) {
    return catchError(error, `bulk assigning tools to ${bulkAssignLabel}`);
  }
}
