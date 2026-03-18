import { z } from "zod";
import {
  getAgentTypePermissionChecker,
  isAgentTypeAdmin,
  requireAgentModifyPermission,
} from "@/auth/agent-type-permissions";
import config from "@/config";
import logger from "@/logging";
import {
  AgentModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  TeamModel,
} from "@/models";
import type { Agent, AgentScope } from "@/types";
import {
  AgentLabelWithDetailsSchema,
  AgentScopeSchema,
  AgentToolAssignmentInputSchema,
  InsertAgentSchemaBase,
  SuggestedPromptInputSchema,
  UuidIdSchema,
} from "@/types";
import {
  assignMcpServerTools,
  assignSubAgentDelegations,
  assignToolAssignments,
  catchError,
  deduplicateLabels,
  errorResult,
  formatAssignmentSummary,
  structuredSuccessResult,
  successResult,
  type ToolAssignmentInput,
} from "./helpers";
import type { ArchestraContext } from "./types";

// === Shared schemas ===

export const LabelInputSchema = AgentLabelWithDetailsSchema.pick({
  key: true,
  value: true,
})
  .strict()
  .describe("Key-value labels for organization/categorization.");

export const SuggestedPromptToolInputSchema = SuggestedPromptInputSchema.extend(
  {
    summaryTitle: SuggestedPromptInputSchema.shape.summaryTitle.describe(
      "Short title shown to users for this suggested prompt.",
    ),
    prompt: SuggestedPromptInputSchema.shape.prompt.describe(
      "Suggested prompt text users can click to start a conversation.",
    ),
  },
).strict();

export const ToolAssignmentToolInputSchema =
  AgentToolAssignmentInputSchema.extend({
    toolId: AgentToolAssignmentInputSchema.shape.toolId.describe(
      "The ID of the tool to assign to the agent.",
    ),
    credentialSourceMcpServerId:
      AgentToolAssignmentInputSchema.shape.credentialSourceMcpServerId.describe(
        "For remote MCP tools, the deployed MCP server ID that should supply credentials.",
      ),
    executionSourceMcpServerId:
      AgentToolAssignmentInputSchema.shape.executionSourceMcpServerId.describe(
        "For local MCP tools, the deployed MCP server ID that should execute the tool.",
      ),
    useDynamicTeamCredential:
      AgentToolAssignmentInputSchema.shape.useDynamicTeamCredential.describe(
        "When true, resolve credentials dynamically from the invoking team instead of pinning a deployment.",
      ),
  }).strict();

export const KnowledgeBaseIdsToolInputSchema =
  InsertAgentSchemaBase.shape.knowledgeBaseIds.describe(
    "Knowledge base IDs to assign to the agent. Use get_knowledge_bases first when you need to look up IDs by name.",
  );

export const ConnectorIdsToolInputSchema =
  InsertAgentSchemaBase.shape.connectorIds.describe(
    "Knowledge connector IDs to assign directly to the agent. Use get_knowledge_connectors first when you need to look up IDs by name.",
  );

export const CreateBaseToolArgsSchema = z
  .object({
    name: InsertAgentSchemaBase.shape.name.describe(
      "Name for the new resource.",
    ),
    scope: AgentScopeSchema.optional().describe(
      "Visibility scope. Defaults to personal for agents and org for LLM proxies/MCP gateways unless teams are provided.",
    ),
    labels: z
      .array(LabelInputSchema)
      .optional()
      .describe(
        "Optional key-value labels for organization and categorization.",
      ),
    teams: z
      .array(UuidIdSchema)
      .optional()
      .describe("Team IDs to attach when creating a team-scoped resource."),
  })
  .strict();

export const GetResourceToolArgsSchema = z
  .object({
    id: UuidIdSchema.optional(),
    name: z.string().trim().min(1).optional(),
  })
  .strict();

export const AgentToolOutputSchema = z.object({
  id: z.string().describe("The assigned tool ID."),
  name: z.string().describe("The tool name."),
  description: z.string().nullable().describe("The tool description, if any."),
  catalogId: z
    .string()
    .nullable()
    .describe("The MCP catalog ID the tool comes from, if any."),
});

export const AgentTeamOutputSchema = z.object({
  id: z.string().describe("The team ID."),
  name: z.string().describe("The team name."),
});

export const AgentLabelOutputSchema = z.object({
  key: z.string().describe("The label key."),
  value: z.string().describe("The label value."),
});

export const AgentSuggestedPromptOutputSchema = z.object({
  summaryTitle: z.string().describe("The short title shown in the chat UI."),
  prompt: z.string().describe("The suggested prompt text."),
});

export const AgentDetailOutputSchema = z.object({
  id: z.string().describe("The resource ID."),
  name: z.string().describe("The resource name."),
  description: z
    .string()
    .nullable()
    .describe("The resource description, if any."),
  icon: z.string().nullable().describe("The emoji icon, if configured."),
  scope: AgentScopeSchema.describe("The visibility scope."),
  agentType: z
    .enum(["agent", "llm_proxy", "mcp_gateway", "profile"])
    .describe("The resource type."),
  systemPrompt: z.string().nullable().optional(),
  teams: z.array(AgentTeamOutputSchema).describe("The teams attached to it."),
  labels: z.array(AgentLabelOutputSchema).describe("Assigned labels."),
  tools: z.array(AgentToolOutputSchema).describe("Assigned tools."),
  knowledgeBaseIds: z
    .array(z.string())
    .describe("Assigned knowledge base IDs."),
  connectorIds: z
    .array(z.string())
    .describe("Assigned knowledge connector IDs."),
  suggestedPrompts: z
    .array(AgentSuggestedPromptOutputSchema)
    .describe("Configured suggested prompts."),
});

export const KnowledgeSourceOutputSchema = z.object({
  name: z.string().describe("The knowledge source name."),
  description: z
    .string()
    .nullable()
    .describe("The knowledge source description, if any."),
  type: z
    .enum(["knowledge_base", "knowledge_connector"])
    .describe("Whether this source is a knowledge base or connector."),
});

// === Exports ===

export async function handleCreateResource<
  TArgs extends {
    name: string;
    scope?: AgentScope;
    labels?: Array<{ key: string; value: string }>;
    teams?: string[];
    description?: string | null;
    icon?: string | null;
    knowledgeBaseIds?: string[];
    connectorIds?: string[];
    systemPrompt?: string | null;
    suggestedPrompts?: Array<{ summaryTitle: string; prompt: string }>;
    mcpServerIds?: string[];
    subAgentIds?: string[];
    toolAssignments?: ToolAssignmentInput[];
  },
>(params: {
  args: TArgs;
  context: ArchestraContext;
  targetAgentType: "agent" | "llm_proxy" | "mcp_gateway";
}) {
  const { args, context, targetAgentType } = params;
  const toolLabel = targetAgentType.replace("_", " ");

  logger.info(
    {
      agentId: context.agent.id,
      createArgs: args,
      agentType: targetAgentType,
    },
    `create_${targetAgentType} tool called`,
  );

  try {
    const teams = args.teams ?? [];
    const labels = args.labels ? deduplicateLabels(args.labels) : undefined;

    if (!args.name || args.name.trim() === "") {
      return errorResult(`${toolLabel} name is required and cannot be empty.`);
    }

    const scope =
      args.scope ??
      (teams.length > 0
        ? "team"
        : targetAgentType === "agent"
          ? "personal"
          : "org");

    // Scope-based authorization — mirrors the REST endpoint (routes/agent.ts)
    if (context.userId && context.organizationId) {
      const checker = await getAgentTypePermissionChecker({
        userId: context.userId,
        organizationId: context.organizationId,
      });

      if (!checker.isAdmin(targetAgentType)) {
        if (scope === "org") {
          return errorResult(
            `Only admins can create org-scoped ${toolLabel}s.`,
          );
        }
        if (scope === "team" || teams.length > 0) {
          if (!checker.isTeamAdmin(targetAgentType)) {
            return errorResult(
              `You need team-admin permission to create team-scoped ${toolLabel}s.`,
            );
          }

          const userTeamIds = await TeamModel.getUserTeamIds(context.userId);
          const userTeamIdSet = new Set(userTeamIds);
          const invalidTeams = teams.filter((id) => !userTeamIdSet.has(id));
          if (invalidTeams.length > 0) {
            return errorResult(
              "You can only assign teams you are a member of.",
            );
          }
        }
      }
    }

    const createParams: Parameters<typeof AgentModel.create>[0] = {
      name: args.name,
      scope,
      teams,
      labels,
      agentType: targetAgentType,
    };

    if (targetAgentType === "agent" || targetAgentType === "mcp_gateway") {
      if (targetAgentType === "agent" && args.systemPrompt) {
        createParams.systemPrompt = args.systemPrompt;
      }
      if (args.description) createParams.description = args.description;
      if (args.icon) createParams.icon = args.icon;
      if (targetAgentType === "agent" && args.suggestedPrompts) {
        createParams.suggestedPrompts = args.suggestedPrompts;
      }
      if (
        args.knowledgeBaseIds !== undefined ||
        args.connectorIds !== undefined
      ) {
        await validateKnowledgeAssignments({
          organizationId: context.organizationId,
          knowledgeBaseIds: args.knowledgeBaseIds,
          connectorIds: args.connectorIds,
          targetAgentType,
        });
      }
      if (args.knowledgeBaseIds) {
        createParams.knowledgeBaseIds = args.knowledgeBaseIds;
      }
      if (args.connectorIds) {
        createParams.connectorIds = args.connectorIds;
      }
    } else {
      if (args.description) createParams.description = args.description;
      if (args.icon) createParams.icon = args.icon;
    }

    const created = await AgentModel.create(
      createParams,
      scope === "personal" ? context.userId : undefined,
    );

    const mcpServerResults =
      targetAgentType === "agent" && (args.mcpServerIds?.length ?? 0) > 0
        ? await assignMcpServerTools(created.id, args.mcpServerIds ?? [])
        : [];
    const toolAssignmentResults =
      targetAgentType === "agent" && (args.toolAssignments?.length ?? 0) > 0
        ? await assignToolAssignments(created.id, args.toolAssignments ?? [])
        : [];
    const subAgentResults =
      targetAgentType === "agent" && (args.subAgentIds?.length ?? 0) > 0
        ? await assignSubAgentDelegations(created.id, args.subAgentIds ?? [])
        : [];

    const editLink = `${config.frontendBaseUrl}/agents?edit=${created.id}`;
    const lines = [
      `Successfully created ${toolLabel}.`,
      "",
      `Name: ${created.name}`,
      `ID: ${created.id}`,
      `Type: ${targetAgentType}`,
      `Edit: ${editLink}`,
      `Teams: ${created.teams.length > 0 ? created.teams.map((team) => team.name).join(", ") : "None"}`,
      `Labels: ${created.labels.length > 0 ? created.labels.map((label) => `${label.key}: ${label.value}`).join(", ") : "None"}`,
    ];
    formatAssignmentSummary(
      lines,
      mcpServerResults,
      subAgentResults,
      toolAssignmentResults,
    );

    return successResult(lines.join("\n"));
  } catch (error) {
    return catchError(error, `creating ${toolLabel}`);
  }
}

export async function handleGetResource<
  TArgs extends { id?: string; name?: string },
>(params: {
  args: TArgs;
  context: ArchestraContext;
  expectedType: "agent" | "llm_proxy" | "mcp_gateway";
  getLabel: string;
}) {
  const { args, context, expectedType, getLabel } = params;

  logger.info(
    {
      agentId: context.agent.id,
      requestedId: args.id,
      requestedName: args.name,
      type: expectedType,
    },
    `get_${expectedType} tool called`,
  );

  try {
    if (!args.id && !args.name) {
      return errorResult("either id or name parameter is required");
    }

    let record: Agent | null | undefined;

    const isAdmin =
      context.userId && context.organizationId
        ? await isAgentTypeAdmin({
            userId: context.userId,
            organizationId: context.organizationId,
            agentType: expectedType,
          })
        : false;

    if (args.id) {
      record = await AgentModel.findById(args.id, context.userId, isAdmin);
      // findById doesn't support excludeOtherPersonalAgents, so we guard here.
      // swap_agent is the primary Archestra MCP use-case and requires only the
      // caller's own personal agents to be visible, even though admins can see
      // all personal agents in the UI.
      if (
        record &&
        record.scope === "personal" &&
        context.userId &&
        record.authorId !== context.userId
      ) {
        record = null;
      }
    } else if (args.name) {
      const results = await AgentModel.findAllPaginated(
        { limit: 1, offset: 0 },
        undefined,
        {
          name: args.name,
          agentType: expectedType,
          // Hide other users' personal agents from MCP tools. swap_agent is
          // the primary Archestra MCP use-case and requires only the caller's
          // own personal agents to be visible, even though admins can see all
          // personal agents in the UI.
          excludeOtherPersonalAgents: true,
        },
        context.userId,
        isAdmin,
      );

      if (results.data.length > 0) {
        record = results.data[0];
      }
    }

    if (!record) {
      return errorResult(`${getLabel} not found`);
    }

    if (record.agentType !== expectedType) {
      return errorResult(
        `The requested entity is a ${record.agentType}, not a ${expectedType}.`,
      );
    }

    return structuredSuccessResult(record, JSON.stringify(record, null, 2));
  } catch (error) {
    return catchError(error, `getting ${getLabel}`);
  }
}

export async function handleEditResource<
  TArgs extends {
    id: string;
    name?: string;
    description?: string | null;
    icon?: string | null;
    scope?: AgentScope;
    teams?: string[];
    labels?: Array<{ key: string; value: string }>;
    knowledgeBaseIds?: string[];
    connectorIds?: string[];
    systemPrompt?: string | null;
    suggestedPrompts?: Array<{ summaryTitle: string; prompt: string }>;
    mcpServerIds?: string[];
    subAgentIds?: string[];
    toolAssignments?: ToolAssignmentInput[];
  },
>(params: {
  args: TArgs;
  context: ArchestraContext;
  expectedType: "agent" | "llm_proxy" | "mcp_gateway";
}) {
  const { args, context, expectedType } = params;
  const toolLabel = expectedType.replace("_", " ");

  logger.info(
    { agentId: context.agent.id, editArgs: args, agentType: expectedType },
    `edit_${expectedType} tool called`,
  );

  try {
    if (!context.userId || !context.organizationId) {
      return errorResult("user/organization context not available.");
    }

    const existingAgent = await AgentModel.findById(args.id);
    if (!existingAgent) {
      return errorResult(`${toolLabel} not found.`);
    }

    if (existingAgent.agentType !== expectedType) {
      return errorResult(
        `this tool only edits ${toolLabel}s, not ${existingAgent.agentType}.`,
      );
    }

    const checker = await getAgentTypePermissionChecker({
      userId: context.userId,
      organizationId: context.organizationId,
    });
    checker.require(existingAgent.agentType, "update");

    const userTeamIds = await TeamModel.getUserTeamIds(context.userId);
    requireAgentModifyPermission({
      checker,
      agentType: existingAgent.agentType,
      agentScope: existingAgent.scope,
      agentAuthorId: existingAgent.authorId,
      agentTeamIds: existingAgent.teams.map((team) => team.id),
      userTeamIds,
      userId: context.userId,
    });

    const updateData: Record<string, unknown> = {};
    if (args.name !== undefined) updateData.name = args.name;
    if (args.description !== undefined)
      updateData.description = args.description;
    if (args.icon !== undefined) updateData.icon = args.icon;
    if (args.scope !== undefined) updateData.scope = args.scope;
    if (args.teams !== undefined) updateData.teams = args.teams;
    if (args.labels !== undefined) {
      updateData.labels = deduplicateLabels(args.labels);
    }

    if (expectedType === "agent" || expectedType === "mcp_gateway") {
      if (expectedType === "agent" && args.systemPrompt !== undefined) {
        updateData.systemPrompt = args.systemPrompt;
      }
      if (expectedType === "agent" && args.suggestedPrompts !== undefined) {
        updateData.suggestedPrompts = args.suggestedPrompts;
      }
      if (
        args.knowledgeBaseIds !== undefined ||
        args.connectorIds !== undefined
      ) {
        await validateKnowledgeAssignments({
          organizationId: context.organizationId,
          knowledgeBaseIds: args.knowledgeBaseIds,
          connectorIds: args.connectorIds,
          targetAgentType: expectedType,
        });
      }
      if (args.knowledgeBaseIds !== undefined) {
        updateData.knowledgeBaseIds = args.knowledgeBaseIds;
      }
      if (args.connectorIds !== undefined) {
        updateData.connectorIds = args.connectorIds;
      }
    }

    const updated = await AgentModel.update(
      args.id,
      updateData as Parameters<typeof AgentModel.update>[1],
    );

    if (!updated) {
      return errorResult(`failed to update ${toolLabel}.`);
    }

    const mcpServerResults =
      expectedType === "agent" && (args.mcpServerIds?.length ?? 0) > 0
        ? await assignMcpServerTools(args.id, args.mcpServerIds ?? [])
        : [];
    const toolAssignmentResults =
      expectedType === "agent" && (args.toolAssignments?.length ?? 0) > 0
        ? await assignToolAssignments(args.id, args.toolAssignments ?? [])
        : [];
    const subAgentResults =
      expectedType === "agent" && (args.subAgentIds?.length ?? 0) > 0
        ? await assignSubAgentDelegations(args.id, args.subAgentIds ?? [])
        : [];

    const editLink = `${config.frontendBaseUrl}/agents?edit=${updated.id}`;
    const lines = [
      `Successfully updated ${toolLabel}.`,
      "",
      `Name: ${updated.name}`,
      `ID: ${updated.id}`,
      `Edit: ${editLink}`,
      `Scope: ${updated.scope}`,
      `Teams: ${updated.teams.length > 0 ? updated.teams.map((team) => team.name).join(", ") : "None"}`,
      `Labels: ${updated.labels.length > 0 ? updated.labels.map((label) => `${label.key}: ${label.value}`).join(", ") : "None"}`,
    ];
    formatAssignmentSummary(
      lines,
      mcpServerResults,
      subAgentResults,
      toolAssignmentResults,
    );

    return successResult(lines.join("\n"));
  } catch (error) {
    return catchError(error, `editing ${toolLabel}`);
  }
}

export async function validateKnowledgeAssignments(params: {
  organizationId?: string;
  knowledgeBaseIds?: string[];
  connectorIds?: string[];
  targetAgentType: "agent" | "llm_proxy" | "mcp_gateway";
}) {
  const { organizationId, knowledgeBaseIds, connectorIds, targetAgentType } =
    params;

  if (!organizationId) {
    throw new Error(
      "organization context not available for knowledge validation",
    );
  }

  if (targetAgentType === "llm_proxy") {
    if ((knowledgeBaseIds?.length ?? 0) > 0) {
      throw createValidationError(
        ["knowledgeBaseIds"],
        "Knowledge bases cannot be assigned to LLM proxy resources.",
      );
    }
    if ((connectorIds?.length ?? 0) > 0) {
      throw createValidationError(
        ["connectorIds"],
        "Knowledge connectors cannot be assigned to LLM proxy resources.",
      );
    }
  }

  if (knowledgeBaseIds) {
    for (const kbId of knowledgeBaseIds) {
      const knowledgeBase = await KnowledgeBaseModel.findById(kbId);
      if (!knowledgeBase || knowledgeBase.organizationId !== organizationId) {
        throw createValidationError(
          ["knowledgeBaseIds"],
          `Knowledge base not found for this organization: ${kbId}`,
        );
      }
    }
  }

  if (connectorIds) {
    for (const connectorId of connectorIds) {
      const connector = await KnowledgeBaseConnectorModel.findById(connectorId);
      if (!connector || connector.organizationId !== organizationId) {
        throw createValidationError(
          ["connectorIds"],
          `Knowledge connector not found for this organization: ${connectorId}`,
        );
      }
    }
  }
}

function createValidationError(path: PropertyKey[], message: string) {
  return new z.ZodError([
    {
      code: "custom",
      path,
      message,
      input: undefined,
    },
  ]);
}
