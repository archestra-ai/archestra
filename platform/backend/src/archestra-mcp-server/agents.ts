import {
  TOOL_CREATE_AGENT_SHORT_NAME,
  TOOL_CREATE_SKILL_SHORT_NAME,
  TOOL_DRAFT_SKILL_FROM_AGENT_SHORT_NAME,
  TOOL_EDIT_AGENT_SHORT_NAME,
  TOOL_GET_AGENT_SHORT_NAME,
  TOOL_GET_MCP_SERVER_TOOLS_SHORT_NAME,
  TOOL_LIST_AGENTS_SHORT_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
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
  agentToSkill,
  SCOPE_FIELD,
  serializeSkillManifest,
} from "@/skills/agent-migration";
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
import { archestraMcpBranding } from "./branding";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
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

const DraftSkillFromAgentToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe(
      `The ID of the agent to convert into a skill draft. Use ${TOOL_LIST_AGENTS_SHORT_NAME} or ${TOOL_GET_AGENT_SHORT_NAME} to look it up by name.`,
    ),
  })
  .strict();

const MigrationFieldOutputSchema = z.object({
  field: z.string(),
  detail: z.string(),
});

const DraftSkillFromAgentOutputSchema = z.object({
  manifest: z
    .string()
    .describe(
      "The complete SKILL.md manifest, as data. Review and edit it, then pass it to create_skill to persist. Keep the metadata block to preserve the link to the origin agent.",
    ),
  carried: z
    .array(MigrationFieldOutputSchema)
    .describe("Agent fields carried over directly to native skill fields."),
  annotated: z
    .array(MigrationFieldOutputSchema)
    .describe(
      "Agent fields with no skill equivalent, folded into the manifest body or metadata.",
    ),
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
    shortName: TOOL_DRAFT_SKILL_FROM_AGENT_SHORT_NAME,
    title: "Draft Skill From Agent",
    description:
      "Convert an internal agent into a draft SKILL.md manifest for review. " +
      "Returns the manifest plus a summary of what was carried over versus " +
      "annotated — the agent's tools, model, and knowledge bindings have no " +
      "skill equivalent and are listed under a Requirements section instead. " +
      "This does NOT create anything: edit the manifest body if you like, then " +
      `call ${TOOL_CREATE_SKILL_SHORT_NAME} with the final manifest to persist ` +
      "it. Keep the metadata block so the skill stays linked to its origin " +
      `agent. NOTE: ${TOOL_CREATE_SKILL_SHORT_NAME} always creates a PERSONAL ` +
      "skill — the agent's scope is not carried over here. If the skill should " +
      "be shared with a team or the whole org, change its scope in the Skills UI " +
      "after creating it.",
    schema: DraftSkillFromAgentToolArgsSchema,
    outputSchema: DraftSkillFromAgentOutputSchema,
    async handler({ args, context }) {
      if (!context.userId || !context.organizationId) {
        return errorResult("This tool requires an authenticated user session.");
      }

      const isAdmin = await isAgentTypeAdmin({
        userId: context.userId,
        organizationId: context.organizationId,
        agentType: "agent",
      });
      const agent = await AgentModel.findById(args.id, context.userId, isAdmin);
      if (!agent || agent.organizationId !== context.organizationId) {
        return errorResult(
          `No agent "${args.id}" exists, or you do not have access to it.`,
        );
      }
      if (agent.agentType !== "agent" || agent.builtInAgentConfig) {
        return errorResult("Only internal agents can be converted to skills.");
      }

      const { draft, report } = agentToSkill(agent);

      // create_skill (the documented next step) always persists a personal skill
      // and the SKILL.md manifest can't encode scope, so the agent's scope is not
      // carried through this path. Report it annotated rather than letting the
      // caller assume the shared/team visibility survived.
      const annotated = [
        ...report.annotated,
        {
          field: SCOPE_FIELD,
          detail: `agent scope "${draft.scope}" not carried — ${TOOL_CREATE_SKILL_SHORT_NAME} makes a personal skill; change scope in the Skills UI.`,
        },
      ];

      // Return the manifest as a discrete structured field rather than embedding
      // it in a markdown code fence. The manifest body contains the agent's
      // system prompt verbatim (untrusted for shared agents); a fenced block lets
      // a prompt with triple backticks break out and inject instructions next to
      // the "now call create_skill" guidance. As a JSON string value it stays
      // inert data — the guidance lives in this tool's description instead.
      return structuredSuccessResult({
        manifest: serializeSkillManifest(draft),
        carried: report.carried,
        annotated,
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

        // HOTFIX: query_knowledge_sources is auto-injected at runtime by
        // ToolModel.getMcpToolsByAgent based on whether the agent has any
        // knowledge sources, but historical seed rows in agent_tools (from
        // ensurePersonalChatAgent → assignDefaultArchestraToolsToAgent) leak
        // through list_agents because this path reads agent_tools directly.
        // Filter the tool out for agents with no KB and no connectors.
        // TODO: drop query_knowledge_sources from DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES
        // and clean up stale agent_tools rows so this filter becomes unnecessary.
        const queryKnowledgeSourcesToolName = archestraMcpBranding.getToolName(
          TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
        );

        const agents = results.data.map((agent) => {
          const hasKnowledgeSources =
            agent.knowledgeBaseIds.length > 0 || agent.connectorIds.length > 0;
          return {
            id: agent.id,
            name: agent.name,
            scope: agent.scope,
            description: agent.description,
            teams: agent.teams.map((team) => ({
              id: team.id,
              name: team.name,
            })),
            labels: agent.labels.map((label) => ({
              key: label.key,
              value: label.value,
            })),
            tools: agent.tools
              .filter(
                (tool) =>
                  hasKnowledgeSources ||
                  tool.name !== queryKnowledgeSourcesToolName,
              )
              .map((tool) => ({
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
          };
        });

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

export const toolEntries = registry.toolEntries;

// === Exports ===

export const tools = registry.tools;
