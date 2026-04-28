import {
  TOOL_CREATE_AGENT_SHORT_NAME,
  TOOL_EDIT_AGENT_SHORT_NAME,
  TOOL_GET_AGENT_SHORT_NAME,
  TOOL_GET_MCP_SERVER_TOOLS_SHORT_NAME,
  TOOL_LIST_AGENTS_SHORT_NAME,
} from "@shared";
import { z } from "zod";
import { isAgentTypeAdmin } from "@/auth/agent-type-permissions";
import logger from "@/logging";
import {
  AgentModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
} from "@/models";
import {
  AgentScopeSchema,
  InsertAgentSchemaBase,
  ToolExposureModeSchema,
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
  defineArchestraTool,
  defineArchestraTools,
  structuredSuccessResult,
} from "./helpers";

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
  })
  .strict();

const EditAgentToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe(
      `The ID of the agent to edit. Use ${TOOL_GET_AGENT_SHORT_NAME} or ${TOOL_LIST_AGENTS_SHORT_NAME} to look it up by name.`,
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
        toolExposureMode: ToolExposureModeSchema.optional().describe(
          "How tools should be exposed to MCP clients and models.",
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
  defineArchestraTool({
    shortName: TOOL_CREATE_AGENT_SHORT_NAME,
    title: "Create Agent",
    description: `Create a new agent with the specified name, optional description, labels, prompts, icon emoji, explicit tool assignments, and sub-agent delegations. Defaults to personal scope. IMPORTANT: When the user mentions MCP servers or sub-agents by name, you MUST first look up the exact tool IDs and agent IDs using ${TOOL_GET_MCP_SERVER_TOOLS_SHORT_NAME} / ${TOOL_LIST_AGENTS_SHORT_NAME} / ${TOOL_GET_AGENT_SHORT_NAME}, then pass them via toolAssignments / subAgentIds.`,
    schema: AgentCreateToolArgsSchema,
    async handler({ args, context }) {
      return handleCreateResource({
        args,
        context,
        targetAgentType: "agent",
      });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_GET_AGENT_SHORT_NAME,
    title: "Get Agent",
    description: "Get a specific agent by ID or name.",
    schema: GetAgentToolArgsSchema,
    outputSchema: AgentDetailOutputSchema,
    async handler({ args, context }) {
      return handleGetResource({
        args,
        context,
        expectedType: "agent",
        getLabel: "agent",
      });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_LIST_AGENTS_SHORT_NAME,
    title: "List Agents",
    description:
      "List agents with optional filtering by name. Returns each agent's assigned tools and knowledge sources for discoverability.",
    schema: ListAgentsToolArgsSchema,
    outputSchema: ListAgentsOutputSchema,
    async handler({ args, context }) {
      const { agent: contextAgent } = context;

      logger.info(
        { agentId: contextAgent.id, listArgs: args },
        "list_agents tool called",
      );

      try {
        const limit = Math.min(args.limit ?? 20, 100);

        const isAdmin =
          context.userId && context.organizationId
            ? await isAgentTypeAdmin({
                userId: context.userId,
                organizationId: context.organizationId,
                agentType: "agent",
              })
            : false;

        const results = await AgentModel.findAllPaginated(
          { limit, offset: 0 },
          undefined,
          {
            agentType: "agent",
            ...(args.name ? { name: args.name } : {}),
            // Hide other users' personal agents. swap_agent is the primary
            // Archestra MCP use-case and requires only the caller's own
            // personal agents to be visible, even though admins can see all
            // personal agents in the UI.
            excludeOtherPersonalAgents: true,
          },
          context.userId,
          isAdmin,
        );

        const allKbIds = [
          ...new Set(results.data.flatMap((a) => a.knowledgeBaseIds)),
        ];
        const allConnectorIds = [
          ...new Set(results.data.flatMap((a) => a.connectorIds)),
        ];
        const knowledgeBases =
          allKbIds.length > 0
            ? await KnowledgeBaseModel.findByIds(allKbIds)
            : [];
        const connectors =
          allConnectorIds.length > 0
            ? await KnowledgeBaseConnectorModel.findByIds(allConnectorIds)
            : [];
        const kbMap = new Map(knowledgeBases.map((kb) => [kb.id, kb]));
        const connectorMap = new Map(connectors.map((c) => [c.id, c]));

        const agents = results.data.map((agent) => ({
          id: agent.id,
          name: agent.name,
          scope: agent.scope,
          description: agent.description,
          teams: agent.teams.map((team) => ({ id: team.id, name: team.name })),
          labels: agent.labels.map((label) => ({
            key: label.key,
            value: label.value,
          })),
          tools: agent.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
          })),
          knowledgeSources: [
            ...agent.knowledgeBaseIds
              .map((knowledgeBaseId) => {
                const knowledgeBase = kbMap.get(knowledgeBaseId);
                if (!knowledgeBase) return null;
                return {
                  name: knowledgeBase.name,
                  description: knowledgeBase.description,
                  type: "knowledge_base" as const,
                };
              })
              .filter(
                (
                  knowledgeBase,
                ): knowledgeBase is {
                  name: string;
                  description: string | null;
                  type: "knowledge_base";
                } => knowledgeBase !== null,
              ),
            ...agent.connectorIds
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
    },
  }),
  defineArchestraTool({
    shortName: TOOL_EDIT_AGENT_SHORT_NAME,
    title: "Edit Agent",
    description: `Edit an existing agent. All fields are optional except id. Only provided fields are updated. Tool assignments and sub-agent delegations are additive. Respects the calling user's access level. IMPORTANT: When the user mentions MCP servers or sub-agents by name, you MUST first look up the exact tool IDs and agent IDs using ${TOOL_GET_MCP_SERVER_TOOLS_SHORT_NAME} / ${TOOL_LIST_AGENTS_SHORT_NAME} / ${TOOL_GET_AGENT_SHORT_NAME}, then pass them via toolAssignments / subAgentIds.`,
    schema: EditAgentToolArgsSchema,
    async handler({ args, context }) {
      return handleEditResource({
        args,
        context,
        expectedType: "agent",
      });
    },
  }),
] as const);

export const toolShortNames = registry.toolShortNames;
export const toolArgsSchemas = registry.toolArgsSchemas;
export const toolOutputSchemas = registry.toolOutputSchemas;
export const toolEntries = registry.toolEntries;

// === Exports ===

export const tools = registry.tools;
