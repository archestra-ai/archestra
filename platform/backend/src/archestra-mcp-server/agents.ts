import { z } from "zod";
import logger from "@/logging";
import {
  AgentModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
} from "@/models";
import type { AgentScope } from "@/types";
import {
  AgentScopeSchema,
  InsertAgentSchemaBase,
  UpdateAgentSchemaBase,
  UuidIdSchema,
} from "@/types";
import {
  AgentDetailOutputSchema,
  AgentLabelOutputSchema,
  AgentTeamOutputSchema,
  ConnectorIdsToolInputSchema,
  CreateBaseToolArgsSchema,
  GetResourceToolArgsSchema,
  handleCreateResource,
  handleEditResource,
  handleGetResource,
  KnowledgeBaseIdsToolInputSchema,
  KnowledgeSourceOutputSchema,
  LabelInputSchema,
  SuggestedPromptToolInputSchema,
  ToolAssignmentToolInputSchema,
} from "./agent-resources";
import {
  catchError,
  defineArchestraTools,
  structuredSuccessResult,
  type successResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

const AgentCreateToolArgsSchema = CreateBaseToolArgsSchema.extend({
  description: InsertAgentSchemaBase.shape.description
    .optional()
    .describe("Optional human-readable description of the agent."),
  icon: InsertAgentSchemaBase.shape.icon
    .optional()
    .describe("Optional emoji icon for the agent."),
  knowledgeBaseIds: KnowledgeBaseIdsToolInputSchema.optional(),
  connectorIds: ConnectorIdsToolInputSchema.optional(),
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

const GetAgentToolArgsSchema = GetResourceToolArgsSchema.extend({
  id: GetResourceToolArgsSchema.shape.id.describe(
    "The ID of the agent to fetch. Prefer the ID when you already have it.",
  ),
  name: GetResourceToolArgsSchema.shape.name.describe(
    "The exact name of the agent to fetch when you do not already have the ID.",
  ),
}).refine((data) => data.id || data.name, {
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
    name: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Optional agent name filter. Use this when the user names an agent but you still need to look up the ID.",
      ),
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
        knowledgeBaseIds: UpdateAgentSchemaBase.shape.knowledgeBaseIds
          .describe(
            "Replace the agent's assigned knowledge bases with this set.",
          )
          .optional(),
        labels: z
          .array(LabelInputSchema)
          .optional()
          .describe("Replace the agent's labels with this set."),
        name: UpdateAgentSchemaBase.shape.name
          .optional()
          .describe("New name for the agent."),
        connectorIds: UpdateAgentSchemaBase.shape.connectorIds
          .describe(
            "Replace the agent's directly assigned knowledge connectors with this set.",
          )
          .optional(),
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

const ListAgentsOutputSchema = z.object({
  total: z.number().describe("The total number of matching agents."),
  agents: z.array(
    z.object({
      id: z.string().describe("The agent ID."),
      name: z.string().describe("The agent name."),
      scope: AgentScopeSchema.describe("The agent scope."),
      description: z
        .string()
        .nullable()
        .describe("The agent description, if any."),
      teams: z.array(AgentTeamOutputSchema).describe("Teams attached to it."),
      labels: z.array(AgentLabelOutputSchema).describe("Assigned labels."),
      tools: z.array(
        z.object({
          name: z.string().describe("The tool name."),
          description: z
            .string()
            .nullable()
            .describe("The tool description, if any."),
        }),
      ),
      knowledgeSources: z
        .array(KnowledgeSourceOutputSchema)
        .describe("Assigned knowledge bases and connectors."),
    }),
  ),
});

const registry = defineArchestraTools([
  {
    shortName: "create_agent",
    title: "Create Agent",
    description:
      "Create a new agent with the specified name, optional description, labels, prompts, icon emoji, MCP server tool assignments, and sub-agent delegations. Defaults to personal scope. IMPORTANT: When the user mentions MCP servers or sub-agents by name, you MUST first look up their IDs using get_mcp_servers / list_agents / get_agent, then pass the IDs via mcpServerIds / subAgentIds.",
    schema: AgentCreateToolArgsSchema,
  },
  {
    shortName: "get_agent",
    title: "Get Agent",
    description: "Get a specific agent by ID or name.",
    schema: GetAgentToolArgsSchema,
    outputSchema: AgentDetailOutputSchema,
  },
  {
    shortName: "list_agents",
    title: "List Agents",
    description:
      "List agents with optional filtering by name and scope. Returns each agent's assigned tools and knowledge sources for discoverability.",
    schema: ListAgentsToolArgsSchema,
    outputSchema: ListAgentsOutputSchema,
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
  get_agent: TOOL_GET_AGENT_FULL_NAME,
  list_agents: TOOL_LIST_AGENTS_FULL_NAME,
  edit_agent: TOOL_EDIT_AGENT_FULL_NAME,
} = registry.toolFullNames;

export const toolShortNames = registry.toolShortNames;
export const toolArgsSchemas = registry.toolArgsSchemas;
export const toolOutputSchemas = registry.toolOutputSchemas;

// === Exports ===

export const tools = registry.tools;

export async function handleTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  context: ArchestraContext,
): Promise<ReturnType<typeof successResult> | null> {
  const { agent: contextAgent } = context;

  if (toolName === TOOL_CREATE_AGENT_FULL_NAME) {
    return handleCreateResource({
      args: args as CreateAgentArgs,
      context,
      targetAgentType: "agent",
    });
  }

  if (toolName === TOOL_GET_AGENT_FULL_NAME) {
    return handleGetResource({
      args: args as GetAgentArgs,
      context,
      expectedType: "agent",
      getLabel: "agent",
    });
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

      // Batch fetch knowledge base and connector details for all agents
      const allKbIds = [
        ...new Set(results.data.flatMap((a) => a.knowledgeBaseIds)),
      ];
      const allConnectorIds = [
        ...new Set(results.data.flatMap((a) => a.connectorIds)),
      ];
      const knowledgeBases =
        allKbIds.length > 0 ? await KnowledgeBaseModel.findByIds(allKbIds) : [];
      const connectors =
        allConnectorIds.length > 0
          ? await KnowledgeBaseConnectorModel.findByIds(allConnectorIds)
          : [];
      const kbMap = new Map(knowledgeBases.map((kb) => [kb.id, kb]));
      const connectorMap = new Map(connectors.map((c) => [c.id, c]));

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
        knowledgeSources: [
          ...a.knowledgeBaseIds
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
          ...a.connectorIds
            .map((connectorId) => {
              const connector = connectorMap.get(connectorId);
              if (!connector) return null;
              return {
                name: connector.name,
                description: connector.description,
                type: "knowledge_connector" as const,
              };
            })
            .filter(
              (
                connector,
              ): connector is {
                name: string;
                description: string | null;
                type: "knowledge_connector";
              } => connector !== null,
            ),
        ],
      }));

      return structuredSuccessResult(
        { total: results.pagination.total, agents },
        JSON.stringify({ total: results.pagination.total, agents }, null, 2),
      );
    } catch (error) {
      return catchError(error, "listing agents");
    }
  }

  if (toolName === TOOL_EDIT_AGENT_FULL_NAME) {
    return handleEditResource({
      args: args as EditAgentArgs,
      context,
      expectedType: "agent",
    });
  }

  return null;
}

// === Internal helpers ===

type CreateAgentArgs = z.infer<typeof AgentCreateToolArgsSchema>;
type GetAgentArgs = z.infer<typeof GetAgentToolArgsSchema>;
type EditAgentArgs = z.infer<typeof EditAgentToolArgsSchema>;
