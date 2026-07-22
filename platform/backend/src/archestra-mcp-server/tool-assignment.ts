import {
  TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_SHORT_NAME,
  TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_SHORT_NAME,
  TOOL_BULK_REMOVE_TOOLS_FROM_AGENTS_SHORT_NAME,
} from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  getAgentTypePermissionChecker,
  requireAgentModifyPermission,
} from "@/auth/agent-type-permissions";
import logger from "@/logging";
import { AgentModel, AgentToolModel, TeamModel } from "@/models";
import { assignToolToAgent } from "@/services/agent-tool-assignment";
import { agentToolExclusionsService } from "@/services/agent-tool-exclusions";
import { AgentToolAssignmentInputSchema, UuidIdSchema } from "@/types";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

const AgentAssignmentSchema = AgentToolAssignmentInputSchema.extend({
  toolId: AgentToolAssignmentInputSchema.shape.toolId.describe(
    "The ID of the tool to assign.",
  ),
  resolveAtCallTime:
    AgentToolAssignmentInputSchema.shape.resolveAtCallTime.describe(
      "When true, resolve credentials and execution target at tool call time. Prefer this for builder flows.",
    ),
  mcpServerId: AgentToolAssignmentInputSchema.shape.mcpServerId.describe(
    "Optional MCP server installation to pin the tool to when using static credential resolution.",
  ),
  agentId: UuidIdSchema.describe("The agent ID to assign the tool to."),
}).strict();

const McpGatewayAssignmentSchema = AgentToolAssignmentInputSchema.extend({
  toolId: AgentToolAssignmentInputSchema.shape.toolId.describe(
    "The ID of the tool to assign.",
  ),
  resolveAtCallTime:
    AgentToolAssignmentInputSchema.shape.resolveAtCallTime.describe(
      "When true, resolve credentials and execution target at tool call time. Prefer this for builder flows.",
    ),
  mcpServerId: AgentToolAssignmentInputSchema.shape.mcpServerId.describe(
    "Optional MCP server installation to pin the tool to when using static credential resolution.",
  ),
  mcpGatewayId: UuidIdSchema.describe(
    "The MCP gateway ID to assign the tool to.",
  ),
}).strict();

const AgentRemovalSchema = z
  .object({
    agentId: UuidIdSchema.describe("The agent ID to remove the tool from."),
    toolId: UuidIdSchema.describe("The ID of the tool to remove."),
  })
  .strict();

type AgentAssignmentInput = z.infer<typeof AgentAssignmentSchema>;
type McpGatewayAssignmentInput = z.infer<typeof McpGatewayAssignmentSchema>;
type BulkAssignmentInput = AgentAssignmentInput | McpGatewayAssignmentInput;
type AgentRemovalInput = z.infer<typeof AgentRemovalSchema>;

const BulkAgentAssignmentResultSchema = z
  .object({
    agentId: UuidIdSchema.describe("The target agent ID."),
    toolId: UuidIdSchema.describe("The tool ID."),
    error: z.string().optional().describe("Validation or assignment error."),
    errorCode: z
      .enum(["not_found", "validation_error"])
      .optional()
      .describe("Structured assignment error code."),
    errorType: z
      .string()
      .optional()
      .describe("Structured assignment error type."),
  })
  .strict();

const BulkMcpGatewayAssignmentResultSchema = z
  .object({
    mcpGatewayId: UuidIdSchema.describe("The target MCP gateway ID."),
    toolId: UuidIdSchema.describe("The tool ID."),
    error: z.string().optional().describe("Validation or assignment error."),
    errorCode: z
      .enum(["not_found", "validation_error"])
      .optional()
      .describe("Structured assignment error code."),
    errorType: z
      .string()
      .optional()
      .describe("Structured assignment error type."),
  })
  .strict();

const BulkAssignAgentsOutputSchema = z.object({
  succeeded: z
    .array(BulkAgentAssignmentResultSchema)
    .describe("Assignments that succeeded."),
  failed: z
    .array(BulkAgentAssignmentResultSchema)
    .describe("Assignments that failed."),
  duplicates: z
    .array(BulkAgentAssignmentResultSchema)
    .describe("Assignments skipped because they already existed."),
});

const BulkAgentRemovalResultSchema = z
  .object({
    agentId: UuidIdSchema.describe("The target agent ID."),
    toolId: UuidIdSchema.describe("The tool ID."),
    error: z.string().optional().describe("Permission or removal error."),
  })
  .strict();

const BulkRemoveAgentsOutputSchema = z.object({
  succeeded: z
    .array(BulkAgentRemovalResultSchema)
    .describe("Removals that took effect."),
  notAssigned: z
    .array(BulkAgentRemovalResultSchema)
    .describe(
      "Removals skipped because the tool was not assigned to the agent (Custom mode).",
    ),
  failed: z
    .array(BulkAgentRemovalResultSchema)
    .describe(
      "Removals that failed (e.g. no permission, agent not found, or a tool that cannot be excluded).",
    ),
});

const BulkAssignMcpGatewaysOutputSchema = z.object({
  succeeded: z
    .array(BulkMcpGatewayAssignmentResultSchema)
    .describe("Assignments that succeeded."),
  failed: z
    .array(BulkMcpGatewayAssignmentResultSchema)
    .describe("Assignments that failed."),
  duplicates: z
    .array(BulkMcpGatewayAssignmentResultSchema)
    .describe("Assignments skipped because they already existed."),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_SHORT_NAME,
    title: "Bulk Assign Tools to Agents",
    description:
      "Assign multiple tools to multiple agents in bulk with validation and error handling",
    schema: z
      .object({
        assignments: z
          .array(AgentAssignmentSchema)
          .describe("Assignments to create or update for agents."),
      })
      .strict(),
    outputSchema: BulkAssignAgentsOutputSchema,
    async handler({ args, context }) {
      return handleBulkAssignTool({
        assignments: args.assignments,
        context,
        bulkAssignType: "agent",
      });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_BULK_REMOVE_TOOLS_FROM_AGENTS_SHORT_NAME,
    title: "Bulk Remove Tools from Agents",
    description:
      'Remove multiple tools from multiple agents in bulk. For Custom-mode agents this deletes the tool assignment; for agents in Auto-tool ("access all tools") mode it adds the tool to the agent\'s exclusions, since those agents reach unassigned tools dynamically.',
    schema: z
      .object({
        removals: z
          .array(AgentRemovalSchema)
          .describe("Tool removals to apply to agents."),
      })
      .strict(),
    outputSchema: BulkRemoveAgentsOutputSchema,
    async handler({ args, context }) {
      return handleBulkRemoveTool({ removals: args.removals, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_SHORT_NAME,
    title: "Bulk Assign Tools to MCP Gateways",
    description:
      "Assign multiple tools to multiple MCP gateways in bulk with validation and error handling",
    schema: z
      .object({
        assignments: z
          .array(McpGatewayAssignmentSchema)
          .describe("Assignments to create or update for MCP gateways."),
      })
      .strict(),
    outputSchema: BulkAssignMcpGatewaysOutputSchema,
    async handler({ args, context }) {
      return handleBulkAssignTool({
        assignments: args.assignments,
        context,
        bulkAssignType: "mcp_gateway",
      });
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;

// === Exports ===

export const tools = registry.tools;

async function handleBulkAssignTool(params: {
  assignments: BulkAssignmentInput[];
  context: ArchestraContext;
  bulkAssignType: "agent" | "mcp_gateway";
}): Promise<CallToolResult> {
  const { assignments, context, bulkAssignType } = params;
  const { agent: contextAgent } = context;
  const idField = bulkAssignType === "agent" ? "agentId" : "mcpGatewayId";
  const bulkAssignLabel =
    bulkAssignType === "agent" ? "agents" : "MCP gateways";

  logger.info(
    {
      agentId: contextAgent.id,
      assignments,
      type: bulkAssignType,
    },
    `bulk_assign_tools_to_${bulkAssignType === "agent" ? "agents" : "mcp_gateways"} tool called`,
  );

  try {
    if (!context.userId || !context.organizationId) {
      return errorResult("user/organization context not available.");
    }
    const { organizationId, userId } = context;

    const uniqueTargetIds = [
      ...new Set(
        assignments.map((assignment) => getBulkAssignmentTargetId(assignment)),
      ),
    ];
    const [targetAgents, checker] = await Promise.all([
      AgentModel.findByIdsForPermissionCheck(uniqueTargetIds),
      getAgentTypePermissionChecker({
        userId,
        organizationId,
      }),
    ]);

    const requiresTeamIds = [...targetAgents.values()].some(
      (target) => target && !checker.isAdmin(target.agentType),
    );
    const userTeamIds = requiresTeamIds
      ? await TeamModel.getUserTeamIds(userId)
      : [];
    const results = await Promise.allSettled(
      assignments.map(async (assignment) => {
        const targetId = getBulkAssignmentTargetId(assignment);
        const target = targetAgents.get(targetId);
        if (target) {
          checker.require(target.agentType, "update");
          requireAgentModifyPermission({
            checker,
            agentType: target.agentType,
            agentScope: target.scope,
            agentAuthorId: target.authorId,
            agentTeamIds: target.teamIds,
            userTeamIds,
            userId,
          });
        }

        return assignToolToAgent({
          agentId: targetId,
          toolId: assignment.toolId,
          resolveAtCallTime: assignment.resolveAtCallTime,
          mcpServerId: assignment.mcpServerId ?? undefined,
        });
      }),
    );

    const succeeded: { [key: string]: string }[] = [];
    const failed: { [key: string]: string }[] = [];
    const duplicates: { [key: string]: string }[] = [];

    results.forEach((result, index) => {
      const entityId = getBulkAssignmentTargetId(assignments[index]);
      const toolId = assignments[index].toolId;
      if (result.status === "fulfilled") {
        if (result.value === null || result.value === "updated") {
          succeeded.push({ [idField]: entityId, toolId });
        } else if (result.value === "duplicate") {
          duplicates.push({ [idField]: entityId, toolId });
        } else {
          failed.push({
            [idField]: entityId,
            toolId,
            error: result.value.error.message || "Unknown error",
            errorCode: result.value.code,
            errorType: result.value.error.type,
          });
        }
      } else if (result.status === "rejected") {
        const error =
          result.reason instanceof Error
            ? result.reason.message
            : "Unknown error";
        failed.push({ [idField]: entityId, toolId, error });
      }
    });

    const output = { succeeded, failed, duplicates };
    return structuredSuccessResult(output, JSON.stringify(output, null, 2));
  } catch (error) {
    return catchError(error, `bulk assigning tools to ${bulkAssignLabel}`);
  }
}

async function handleBulkRemoveTool(params: {
  removals: AgentRemovalInput[];
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const { removals, context } = params;
  const { agent: contextAgent } = context;

  logger.info(
    { agentId: contextAgent.id, removals },
    "bulk_remove_tools_from_agents tool called",
  );

  try {
    if (!context.userId || !context.organizationId) {
      return errorResult("user/organization context not available.");
    }
    const { organizationId, userId } = context;

    const uniqueAgentIds = [...new Set(removals.map((r) => r.agentId))];
    const [targetAgents, checker] = await Promise.all([
      AgentModel.findByIdsForPermissionCheck(uniqueAgentIds),
      getAgentTypePermissionChecker({ userId, organizationId }),
    ]);

    // Prefetch Auto-tool mode once per agent so the per-removal loop doesn't
    // re-query it. Only for agents that exist.
    const accessAllByAgent = new Map<string, boolean>();
    await Promise.all(
      uniqueAgentIds
        .filter((id) => targetAgents.has(id))
        .map(async (id) =>
          accessAllByAgent.set(id, await AgentModel.getAccessAllTools(id)),
        ),
    );

    const requiresTeamIds = [...targetAgents.values()].some(
      (target) => target && !checker.isAdmin(target.agentType),
    );
    const userTeamIds = requiresTeamIds
      ? await TeamModel.getUserTeamIds(userId)
      : [];

    const results = await Promise.allSettled(
      removals.map(async (removal) => {
        const target = targetAgents.get(removal.agentId);
        if (!target) {
          throw new Error(`Agent with ID ${removal.agentId} not found`);
        }
        checker.require(target.agentType, "update");
        requireAgentModifyPermission({
          checker,
          agentType: target.agentType,
          agentScope: target.scope,
          agentAuthorId: target.authorId,
          agentTeamIds: target.teamIds,
          userTeamIds,
          userId,
        });

        // Auto-tool mode: deleting an assignment row is a no-op (dynamic access
        // re-permits), so removal means adding an exclusion. Custom mode: delete
        // the assignment row; a missing row means the tool was not assigned.
        if (accessAllByAgent.get(removal.agentId)) {
          await agentToolExclusionsService.addExclusions({
            agentId: removal.agentId,
            organizationId,
            toolIds: [removal.toolId],
          });
          return "removed" as const;
        }
        // Check existence rather than trusting delete's affected-row count,
        // which some drivers do not report reliably.
        const wasAssigned = await AgentToolModel.exists(
          removal.agentId,
          removal.toolId,
        );
        if (!wasAssigned) {
          return "not_assigned" as const;
        }
        await AgentToolModel.delete(removal.agentId, removal.toolId);
        return "removed" as const;
      }),
    );

    const succeeded: AgentRemovalInput[] = [];
    const notAssigned: AgentRemovalInput[] = [];
    const failed: (AgentRemovalInput & { error: string })[] = [];

    results.forEach((result, index) => {
      const { agentId, toolId } = removals[index];
      if (result.status === "fulfilled") {
        if (result.value === "removed") {
          succeeded.push({ agentId, toolId });
        } else {
          notAssigned.push({ agentId, toolId });
        }
      } else {
        const error =
          result.reason instanceof Error
            ? result.reason.message
            : "Unknown error";
        failed.push({ agentId, toolId, error });
      }
    });

    const output = { succeeded, notAssigned, failed };
    return structuredSuccessResult(output, JSON.stringify(output, null, 2));
  } catch (error) {
    return catchError(error, "removing tools from agents");
  }
}

function getBulkAssignmentTargetId(assignment: BulkAssignmentInput) {
  return "agentId" in assignment ? assignment.agentId : assignment.mcpGatewayId;
}
