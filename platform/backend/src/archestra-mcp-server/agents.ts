import { z } from "zod";
import {
  getAgentTypePermissionChecker,
  isAgentTypeAdmin,
  requireAgentModifyPermission,
} from "@/auth/agent-type-permissions";
import config from "@/config";
import logger from "@/logging";
import { AgentModel, KnowledgeBaseModel, TeamModel } from "@/models";
import type { Agent, AgentScope } from "@/types";
import {
  AgentLabelWithDetailsSchema,
  AgentScopeSchema,
  AgentToolAssignmentInputSchema,
  InsertAgentSchemaBase,
  SuggestedPromptInputSchema,
  UpdateAgentSchemaBase,
  UuidIdSchema,
} from "@/types";
import {
  assignMcpServerTools,
  assignSubAgentDelegations,
  assignToolAssignments,
  catchError,
  deduplicateLabels,
  defineArchestraTools,
  errorResult,
  formatAssignmentSummary,
  successResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

const LabelInputSchema = AgentLabelWithDetailsSchema.pick({
  key: true,
  value: true,
})
  .strict()
  .describe("Key-value labels for organization/categorization.");

const SuggestedPromptToolInputSchema = SuggestedPromptInputSchema.extend({
  summaryTitle: SuggestedPromptInputSchema.shape.summaryTitle.describe(
    "Short title shown to users for this suggested prompt.",
  ),
  prompt: SuggestedPromptInputSchema.shape.prompt.describe(
    "Suggested prompt text users can click to start a conversation.",
  ),
}).strict();

const ToolAssignmentToolInputSchema = AgentToolAssignmentInputSchema.extend({
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

const CreateBaseToolArgsSchema = z
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

const AgentCreateToolArgsSchema = CreateBaseToolArgsSchema.extend({
  description: InsertAgentSchemaBase.shape.description
    .optional()
    .describe("Optional human-readable description of the agent."),
  icon: InsertAgentSchemaBase.shape.icon
    .optional()
    .describe("Optional emoji icon for the agent."),
  mcpServerIds: z
    .array(UuidIdSchema)
    .optional()
    .describe(
      "Catalog item IDs from get_mcp_servers whose tools should be assigned to the agent.",
    ),
  subAgentIds: z
    .array(UuidIdSchema)
    .optional()
    .describe("Agent IDs to delegate to from this newly created agent."),
  suggestedPrompts: z
    .array(SuggestedPromptToolInputSchema)
    .optional()
    .describe("Optional suggested prompts that appear in the chat UI."),
  systemPrompt: InsertAgentSchemaBase.shape.systemPrompt
    .optional()
    .describe("The system prompt that defines the agent's behavior."),
  toolAssignments: z
    .array(ToolAssignmentToolInputSchema)
    .optional()
    .describe(
      "Explicit tool assignments to create immediately after the agent is created.",
    ),
}).strict();

const NonAgentCreateToolArgsSchema = CreateBaseToolArgsSchema;

const GetAgentToolArgsSchema = z
  .object({
    id: UuidIdSchema.optional().describe(
      "The ID of the agent, LLM proxy, or MCP gateway to fetch.",
    ),
    name: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("The name of the resource to fetch."),
  })
  .strict()
  .refine((data) => data.id || data.name, {
    message: "either id or name parameter is required",
  });

const ListAgentsToolArgsSchema = z
  .object({
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe("Maximum number of agents to return."),
    name: z.string().trim().min(1).optional().describe("Optional name filter."),
    scope: AgentScopeSchema.optional().describe(
      "Optional scope filter: personal, team, or org.",
    ),
  })
  .strict();

const EditAgentToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe(
      "The ID of the agent to edit. Use get_agent or list_agents to look it up by name.",
    ),
    mcpServerIds: z
      .array(UuidIdSchema)
      .optional()
      .describe(
        "Catalog item IDs from get_mcp_servers whose tools should be added to the agent.",
      ),
    subAgentIds: z
      .array(UuidIdSchema)
      .optional()
      .describe("Agent IDs to add as delegation targets."),
    toolAssignments: z
      .array(ToolAssignmentToolInputSchema)
      .optional()
      .describe("Explicit tool assignments to add or update on the agent."),
  })
  .merge(
    z
      .object({
        description: UpdateAgentSchemaBase.shape.description
          .optional()
          .describe("New description for the agent."),
        icon: UpdateAgentSchemaBase.shape.icon
          .optional()
          .describe("New emoji icon for the agent."),
        labels: z
          .array(LabelInputSchema)
          .optional()
          .describe("Replace the agent's labels with this set."),
        name: UpdateAgentSchemaBase.shape.name
          .optional()
          .describe("New name for the agent."),
        scope: AgentScopeSchema.optional().describe(
          "Updated visibility scope for the agent.",
        ),
        suggestedPrompts: z
          .array(SuggestedPromptToolInputSchema)
          .optional()
          .describe("Replace the agent's suggested prompts."),
        systemPrompt: UpdateAgentSchemaBase.shape.systemPrompt
          .optional()
          .describe("New system prompt for the agent."),
        teams: z
          .array(UuidIdSchema)
          .optional()
          .describe("Replace the teams attached to a team-scoped agent."),
      })
      .strict(),
  )
  .strict();

const registry = defineArchestraTools([
  {
    shortName: "create_agent",
    title: "Create Agent",
    description:
      "Create a new agent with the specified name, optional description, labels, prompts, icon emoji, MCP server tool assignments, and sub-agent delegations. Defaults to personal scope. IMPORTANT: When the user mentions MCP servers or sub-agents by name, you MUST first look up their IDs using get_mcp_servers / list_agents / get_agent, then pass the IDs via mcpServerIds / subAgentIds.",
    schema: AgentCreateToolArgsSchema,
  },
  {
    shortName: "create_llm_proxy",
    title: "Create LLM Proxy",
    description:
      "Create a new LLM proxy with the specified name and optional labels.",
    schema: NonAgentCreateToolArgsSchema,
  },
  {
    shortName: "create_mcp_gateway",
    title: "Create MCP Gateway",
    description:
      "Create a new MCP gateway with the specified name and optional labels.",
    schema: NonAgentCreateToolArgsSchema,
  },
  {
    shortName: "get_agent",
    title: "Get Agent",
    description: "Get a specific agent by ID or name.",
    schema: GetAgentToolArgsSchema,
  },
  {
    shortName: "get_llm_proxy",
    title: "Get LLM Proxy",
    description:
      "Get a specific LLM proxy by ID or name. When searching by name, only your personal proxies are matched.",
    schema: GetAgentToolArgsSchema,
  },
  {
    shortName: "get_mcp_gateway",
    title: "Get MCP Gateway",
    description:
      "Get a specific MCP gateway by ID or name. When searching by name, only your personal gateways are matched.",
    schema: GetAgentToolArgsSchema,
  },
  {
    shortName: "list_agents",
    title: "List Agents",
    description:
      "List agents with optional filtering by name and scope. Returns each agent's assigned tools and knowledge sources for discoverability.",
    schema: ListAgentsToolArgsSchema,
  },
  {
    shortName: "edit_agent",
    title: "Edit Agent",
    description:
      "Edit an existing agent. All fields are optional except id. Only provided fields are updated. MCP server and sub-agent assignments are additive. Respects the calling user's access level. IMPORTANT: When the user mentions MCP servers or sub-agents by name, you MUST first look up their IDs using get_mcp_servers / list_agents / get_agent, then pass the IDs via mcpServerIds / subAgentIds.",
    schema: EditAgentToolArgsSchema,
  },
] as const);

const {
  create_agent: TOOL_CREATE_AGENT_FULL_NAME,
  create_llm_proxy: TOOL_CREATE_LLM_PROXY_FULL_NAME,
  create_mcp_gateway: TOOL_CREATE_MCP_GATEWAY_FULL_NAME,
  get_agent: TOOL_GET_AGENT_FULL_NAME,
  get_llm_proxy: TOOL_GET_LLM_PROXY_FULL_NAME,
  get_mcp_gateway: TOOL_GET_MCP_GATEWAY_FULL_NAME,
  list_agents: TOOL_LIST_AGENTS_FULL_NAME,
  edit_agent: TOOL_EDIT_AGENT_FULL_NAME,
} = registry.toolFullNames;

export const toolShortNames = registry.toolShortNames;
export const toolArgsSchemas = registry.toolArgsSchemas;

// === Exports ===

export const tools = registry.tools;

export async function handleTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  context: ArchestraContext,
): Promise<ReturnType<typeof successResult> | null> {
  const { agent: contextAgent, organizationId } = context;

  if (
    toolName === TOOL_CREATE_AGENT_FULL_NAME ||
    toolName === TOOL_CREATE_LLM_PROXY_FULL_NAME ||
    toolName === TOOL_CREATE_MCP_GATEWAY_FULL_NAME
  ) {
    const agentTypeMap: Record<string, string> = {
      [TOOL_CREATE_AGENT_FULL_NAME]: "agent",
      [TOOL_CREATE_LLM_PROXY_FULL_NAME]: "llm_proxy",
      [TOOL_CREATE_MCP_GATEWAY_FULL_NAME]: "mcp_gateway",
    };
    const targetAgentType = agentTypeMap[toolName];
    const toolLabel = targetAgentType.replace("_", " ");

    logger.info(
      {
        agentId: contextAgent.id,
        createArgs: args,
        agentType: targetAgentType,
      },
      `create_${targetAgentType} tool called`,
    );

    try {
      const name = args?.name as string;
      const teams = (args?.teams as string[]) ?? [];
      const rawLabels = args?.labels as
        | Array<{ key: string; value: string }>
        | undefined;
      const labels = rawLabels ? deduplicateLabels(rawLabels) : undefined;

      // Validate required fields
      if (!name || name.trim() === "") {
        return errorResult(
          `${toolLabel} name is required and cannot be empty.`,
        );
      }

      // Build create params - only agents get prompt fields
      const scope =
        (args?.scope as AgentScope) ??
        (teams.length > 0
          ? "team"
          : targetAgentType === "agent"
            ? "personal"
            : "org");
      const createParams: Parameters<typeof AgentModel.create>[0] = {
        name,
        scope,
        teams,
        labels,
        agentType: targetAgentType as "agent" | "llm_proxy" | "mcp_gateway",
      };

      if (targetAgentType === "agent") {
        const systemPrompt = args?.systemPrompt as string | undefined;
        const description = args?.description as string | undefined;
        const icon = args?.icon as string | undefined;
        const suggestedPrompts = args?.suggestedPrompts as
          | Array<{ summaryTitle: string; prompt: string }>
          | undefined;
        if (systemPrompt) createParams.systemPrompt = systemPrompt;
        if (description) createParams.description = description;
        if (icon) createParams.icon = icon;
        if (suggestedPrompts && suggestedPrompts.length > 0) {
          createParams.suggestedPrompts = suggestedPrompts;
        }
      }

      const created = await AgentModel.create(
        createParams,
        scope === "personal" ? context.userId : undefined,
      );

      // Assign MCP server tools and sub-agents (agent-only)
      const mcpServerIds = (args?.mcpServerIds as string[]) ?? [];
      const subAgentIds = (args?.subAgentIds as string[]) ?? [];
      const toolAssignments =
        (args?.toolAssignments as
          | Array<{
              toolId: string;
              credentialSourceMcpServerId?: string | null;
              executionSourceMcpServerId?: string | null;
              useDynamicTeamCredential?: boolean;
            }>
          | undefined) ?? [];
      const mcpServerResults =
        targetAgentType === "agent" && mcpServerIds.length > 0
          ? await assignMcpServerTools(created.id, mcpServerIds)
          : [];
      const toolAssignmentResults =
        targetAgentType === "agent" && toolAssignments.length > 0
          ? await assignToolAssignments(created.id, toolAssignments)
          : [];
      const subAgentResults =
        targetAgentType === "agent" && subAgentIds.length > 0
          ? await assignSubAgentDelegations(created.id, subAgentIds)
          : [];

      const editLink = `${config.frontendBaseUrl}/agents?edit=${created.id}`;
      const lines = [
        `Successfully created ${toolLabel}.`,
        "",
        `Name: ${created.name}`,
        `ID: ${created.id}`,
        `Type: ${targetAgentType}`,
        `Edit: ${editLink}`,
        `Teams: ${created.teams.length > 0 ? created.teams.map((t) => t.name).join(", ") : "None"}`,
        `Labels: ${created.labels.length > 0 ? created.labels.map((l) => `${l.key}: ${l.value}`).join(", ") : "None"}`,
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

  if (
    toolName === TOOL_GET_AGENT_FULL_NAME ||
    toolName === TOOL_GET_LLM_PROXY_FULL_NAME ||
    toolName === TOOL_GET_MCP_GATEWAY_FULL_NAME
  ) {
    const getTypeMap: Record<string, "agent" | "llm_proxy" | "mcp_gateway"> = {
      [TOOL_GET_AGENT_FULL_NAME]: "agent",
      [TOOL_GET_LLM_PROXY_FULL_NAME]: "llm_proxy",
      [TOOL_GET_MCP_GATEWAY_FULL_NAME]: "mcp_gateway",
    };
    const expectedType = getTypeMap[toolName];
    const getLabel = expectedType.replace("_", " ");

    logger.info(
      {
        agentId: contextAgent.id,
        requestedId: args?.id,
        requestedName: args?.name,
        type: expectedType,
      },
      `get_${expectedType} tool called`,
    );

    try {
      const id = args?.id as string | undefined;
      const name = args?.name as string | undefined;

      if (!id && !name) {
        return errorResult("either id or name parameter is required");
      }

      let record: Agent | null | undefined;

      const isAdmin =
        context.userId && organizationId
          ? await isAgentTypeAdmin({
              userId: context.userId,
              organizationId,
              agentType: expectedType,
            })
          : false;

      if (id) {
        record = await AgentModel.findById(id, context.userId, isAdmin);
      } else if (name) {
        const results = await AgentModel.findAllPaginated(
          { limit: 1, offset: 0 },
          undefined,
          {
            name,
            agentType: expectedType,
          },
          context.userId,
          true,
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

      return successResult(JSON.stringify(record, null, 2));
    } catch (error) {
      return catchError(error, `getting ${getLabel}`);
    }
  }

  if (toolName === TOOL_LIST_AGENTS_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, listArgs: args },
      "list_agents tool called",
    );

    try {
      const name = args?.name as string | undefined;
      const scope = args?.scope as AgentScope | undefined;
      const limit = Math.min((args?.limit as number) ?? 20, 100);

      const results = await AgentModel.findAllPaginated(
        { limit, offset: 0 },
        undefined,
        {
          agentType: "agent",
          ...(name ? { name } : {}),
          ...(scope ? { scope } : {}),
        },
        context.userId,
        true,
      );

      // Batch fetch knowledge base details for all agents
      const allKbIds = [
        ...new Set(results.data.flatMap((a) => a.knowledgeBaseIds)),
      ];
      const knowledgeBases =
        allKbIds.length > 0 ? await KnowledgeBaseModel.findByIds(allKbIds) : [];
      const kbMap = new Map(knowledgeBases.map((kb) => [kb.id, kb]));

      const agents = results.data.map((a) => ({
        id: a.id,
        name: a.name,
        scope: a.scope,
        description: a.description,
        teams: a.teams.map((t) => ({ id: t.id, name: t.name })),
        labels: a.labels.map((l) => ({ key: l.key, value: l.value })),
        tools: a.tools.map((t) => ({
          name: t.name,
          description: t.description,
        })),
        knowledgeSources: a.knowledgeBaseIds
          .map((kbId) => {
            const kb = kbMap.get(kbId);
            if (!kb) return null;
            return {
              name: kb.name,
              description: kb.description,
              type: "knowledge_base" as const,
            };
          })
          .filter(
            (
              kb,
            ): kb is {
              name: string;
              description: string | null;
              type: "knowledge_base";
            } => kb !== null,
          ),
      }));

      return successResult(
        JSON.stringify({ total: results.pagination.total, agents }, null, 2),
      );
    } catch (error) {
      return catchError(error, "listing agents");
    }
  }

  if (toolName === TOOL_EDIT_AGENT_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, editArgs: args },
      "edit_agent tool called",
    );

    try {
      const id = args?.id as string | undefined;
      if (!id) {
        return errorResult("agent id is required.");
      }

      if (!context.userId || !organizationId) {
        return errorResult("user/organization context not available.");
      }

      // Fetch existing agent
      const existingAgent = await AgentModel.findById(id);
      if (!existingAgent) {
        return errorResult("agent not found.");
      }

      if (existingAgent.agentType !== "agent") {
        return errorResult(
          `this tool only edits agents, not ${existingAgent.agentType}.`,
        );
      }

      // Check permissions
      const checker = await getAgentTypePermissionChecker({
        userId: context.userId,
        organizationId,
      });
      checker.require(existingAgent.agentType, "update");

      const userTeamIds = await TeamModel.getUserTeamIds(context.userId);
      requireAgentModifyPermission({
        checker,
        agentType: existingAgent.agentType,
        agentScope: existingAgent.scope,
        agentAuthorId: existingAgent.authorId,
        agentTeamIds: existingAgent.teams.map((t) => t.id),
        userTeamIds,
        userId: context.userId,
      });

      // Build update payload (only include provided fields)
      const updateData: Record<string, unknown> = {};
      if (args?.name !== undefined) updateData.name = args.name;
      if (args?.description !== undefined)
        updateData.description = args.description;
      if (args?.systemPrompt !== undefined)
        updateData.systemPrompt = args.systemPrompt;
      if (args?.icon !== undefined) updateData.icon = args.icon;
      if (args?.scope !== undefined) updateData.scope = args.scope;
      if (args?.teams !== undefined) updateData.teams = args.teams;

      if (args?.labels !== undefined) {
        updateData.labels = deduplicateLabels(
          args.labels as Array<{ key: string; value: string }>,
        );
      }

      if (args?.suggestedPrompts !== undefined) {
        updateData.suggestedPrompts = args.suggestedPrompts as Array<{
          summaryTitle: string;
          prompt: string;
        }>;
      }

      // Update agent
      const updated = await AgentModel.update(
        id,
        updateData as Parameters<typeof AgentModel.update>[1],
      );

      if (!updated) {
        return errorResult("failed to update agent.");
      }

      // Assign MCP server tools and sub-agents (additive)
      const mcpServerIds = (args?.mcpServerIds as string[]) ?? [];
      const subAgentIds = (args?.subAgentIds as string[]) ?? [];
      const toolAssignments =
        (args?.toolAssignments as
          | Array<{
              toolId: string;
              credentialSourceMcpServerId?: string | null;
              executionSourceMcpServerId?: string | null;
              useDynamicTeamCredential?: boolean;
            }>
          | undefined) ?? [];
      const mcpServerResults =
        mcpServerIds.length > 0
          ? await assignMcpServerTools(id, mcpServerIds)
          : [];
      const toolAssignmentResults =
        toolAssignments.length > 0
          ? await assignToolAssignments(id, toolAssignments)
          : [];
      const subAgentResults =
        subAgentIds.length > 0
          ? await assignSubAgentDelegations(id, subAgentIds)
          : [];

      const editLink = `${config.frontendBaseUrl}/agents?edit=${updated.id}`;
      const lines = [
        "Successfully updated agent.",
        "",
        `Name: ${updated.name}`,
        `ID: ${updated.id}`,
        `Edit: ${editLink}`,
        `Scope: ${updated.scope}`,
        `Teams: ${updated.teams.length > 0 ? updated.teams.map((t) => t.name).join(", ") : "None"}`,
        `Labels: ${updated.labels.length > 0 ? updated.labels.map((l) => `${l.key}: ${l.value}`).join(", ") : "None"}`,
      ];
      formatAssignmentSummary(
        lines,
        mcpServerResults,
        subAgentResults,
        toolAssignmentResults,
      );

      return successResult(lines.join("\n"));
    } catch (error) {
      return catchError(error, "editing agent");
    }
  }

  return null;
}
