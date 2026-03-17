import { TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME } from "@shared";
import { z } from "zod";
import { buildUserAcl, queryService } from "@/knowledge-base";
import logger from "@/logging";
import {
  AgentConnectorAssignmentModel,
  AgentKnowledgeBaseModel,
  AgentModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  TeamModel,
  UserModel,
} from "@/models";
import {
  type AclEntry,
  InsertKnowledgeBaseConnectorSchema,
  InsertKnowledgeBaseSchema,
  UpdateKnowledgeBaseConnectorSchema,
  UpdateKnowledgeBaseSchema,
  UuidIdSchema,
} from "@/types";
import {
  catchError,
  defineArchestraTools,
  EmptyToolArgsSchema,
  errorResult,
  successResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

const KnowledgeBaseCreateToolArgsSchema = z
  .object({
    name: InsertKnowledgeBaseSchema.shape.name.describe(
      "Name of the knowledge base.",
    ),
    description: InsertKnowledgeBaseSchema.shape.description
      .optional()
      .describe("Description of the knowledge base."),
  })
  .strict();

const KnowledgeBaseUpdateToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe("Knowledge base ID."),
    name: UpdateKnowledgeBaseSchema.shape.name
      .optional()
      .describe("New knowledge base name."),
    description: UpdateKnowledgeBaseSchema.shape.description
      .optional()
      .describe("New knowledge base description."),
  })
  .strict();

const DynamicObjectSchema = z
  .object({})
  .catchall(z.unknown())
  .describe("Provider-specific configuration object.");

const ConnectorCreateToolArgsSchema = z
  .object({
    name: InsertKnowledgeBaseConnectorSchema.shape.name.describe(
      "Name of the knowledge connector.",
    ),
    connector_type: z
      .string()
      .min(1)
      .describe(
        "Type of the knowledge connector (for example jira, confluence, or google_drive).",
      ),
    config: DynamicObjectSchema,
    description: InsertKnowledgeBaseConnectorSchema.shape.description
      .optional()
      .describe("Description of the knowledge connector."),
  })
  .strict();

const ConnectorUpdateToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe("Knowledge connector ID."),
    name: UpdateKnowledgeBaseConnectorSchema.shape.name
      .optional()
      .describe("New connector name."),
    description: UpdateKnowledgeBaseConnectorSchema.shape.description
      .optional()
      .describe("New connector description."),
    enabled: UpdateKnowledgeBaseConnectorSchema.shape.enabled
      .optional()
      .describe("Whether the connector is enabled."),
    config: DynamicObjectSchema.optional().describe(
      "Updated connector configuration (provider-specific settings).",
    ),
  })
  .strict();

const ConnectorKnowledgeBaseAssignmentSchema = z
  .object({
    connector_id: UuidIdSchema.describe("Knowledge connector ID."),
    knowledge_base_id: UuidIdSchema.describe("Knowledge base ID."),
  })
  .strict();

const KnowledgeBaseAgentAssignmentSchema = z
  .object({
    knowledge_base_id: UuidIdSchema.describe("Knowledge base ID."),
    agent_id: UuidIdSchema.describe("Agent ID."),
  })
  .strict();

const ConnectorAgentAssignmentSchema = z
  .object({
    connector_id: UuidIdSchema.describe("Knowledge connector ID."),
    agent_id: UuidIdSchema.describe("Agent ID."),
  })
  .strict();

const registry = defineArchestraTools([
  {
    shortName: "query_knowledge_sources",
    title: "Query Knowledge Sources",
    description:
      "Query the organization's knowledge sources to retrieve relevant information. Use this tool when the user asks a question you cannot answer from your training data alone, or when they explicitly ask you to search internal documents and data sources. Pass the user's original query as-is — do not rephrase, summarize, or expand it. The system performs its own query optimization internally.",
    schema: z
      .object({
        query: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The user's original query, passed verbatim without rephrasing or expansion.",
          ),
      })
      .strict(),
  },
  // --- Knowledge Base CRUD ---
  {
    shortName: "create_knowledge_base",
    title: "Create Knowledge Base",
    description:
      "Create a new knowledge base for organizing knowledge connectors.",
    schema: KnowledgeBaseCreateToolArgsSchema,
  },
  {
    shortName: "get_knowledge_bases",
    title: "Get Knowledge Bases",
    description: "List all knowledge bases in the organization.",
    schema: EmptyToolArgsSchema,
  },
  {
    shortName: "get_knowledge_base",
    title: "Get Knowledge Base",
    description: "Get details of a specific knowledge base by ID.",
    schema: z
      .object({
        id: UuidIdSchema.describe("Knowledge base ID."),
      })
      .strict(),
  },
  {
    shortName: "update_knowledge_base",
    title: "Update Knowledge Base",
    description: "Update an existing knowledge base.",
    schema: KnowledgeBaseUpdateToolArgsSchema,
  },
  {
    shortName: "delete_knowledge_base",
    title: "Delete Knowledge Base",
    description: "Delete a knowledge base by ID.",
    schema: z
      .object({
        id: UuidIdSchema.describe("Knowledge base ID."),
      })
      .strict(),
  },
  // --- Knowledge Connector CRUD ---
  {
    shortName: "create_knowledge_connector",
    title: "Create Knowledge Connector",
    description:
      "Create a new knowledge connector for ingesting data from external sources.",
    schema: ConnectorCreateToolArgsSchema,
  },
  {
    shortName: "get_knowledge_connectors",
    title: "Get Knowledge Connectors",
    description: "List all knowledge connectors in the organization.",
    schema: EmptyToolArgsSchema,
  },
  {
    shortName: "get_knowledge_connector",
    title: "Get Knowledge Connector",
    description: "Get details of a specific knowledge connector by ID.",
    schema: z
      .object({
        id: UuidIdSchema.describe("Knowledge connector ID."),
      })
      .strict(),
  },
  {
    shortName: "update_knowledge_connector",
    title: "Update Knowledge Connector",
    description: "Update an existing knowledge connector.",
    schema: ConnectorUpdateToolArgsSchema,
  },
  {
    shortName: "delete_knowledge_connector",
    title: "Delete Knowledge Connector",
    description: "Delete a knowledge connector by ID.",
    schema: z
      .object({
        id: UuidIdSchema.describe("Knowledge connector ID."),
      })
      .strict(),
  },
  // --- Connector <-> Knowledge Base Assignments ---
  {
    shortName: "assign_knowledge_connector_to_knowledge_base",
    title: "Assign Knowledge Connector to Knowledge Base",
    description: "Assign a knowledge connector to a knowledge base.",
    schema: ConnectorKnowledgeBaseAssignmentSchema,
  },
  {
    shortName: "unassign_knowledge_connector_from_knowledge_base",
    title: "Unassign Knowledge Connector from Knowledge Base",
    description: "Remove a knowledge connector from a knowledge base.",
    schema: ConnectorKnowledgeBaseAssignmentSchema,
  },
  // --- Knowledge Base <-> Agent Assignments ---
  {
    shortName: "assign_knowledge_base_to_agent",
    title: "Assign Knowledge Base to Agent",
    description: "Assign a knowledge base to an agent.",
    schema: KnowledgeBaseAgentAssignmentSchema,
  },
  {
    shortName: "unassign_knowledge_base_from_agent",
    title: "Unassign Knowledge Base from Agent",
    description: "Remove a knowledge base from an agent.",
    schema: KnowledgeBaseAgentAssignmentSchema,
  },
  // --- Knowledge Connector <-> Agent Assignments ---
  {
    shortName: "assign_knowledge_connector_to_agent",
    title: "Assign Knowledge Connector to Agent",
    description:
      "Directly assign a knowledge connector to an agent (bypassing knowledge base).",
    schema: ConnectorAgentAssignmentSchema,
  },
  {
    shortName: "unassign_knowledge_connector_from_agent",
    title: "Unassign Knowledge Connector from Agent",
    description:
      "Remove a directly-assigned knowledge connector from an agent.",
    schema: ConnectorAgentAssignmentSchema,
  },
] as const);

const {
  query_knowledge_sources: _toolQueryKnowledgeSourcesFullName,
  create_knowledge_base: TOOL_CREATE_KB_FULL,
  get_knowledge_bases: TOOL_GET_KBS_FULL,
  get_knowledge_base: TOOL_GET_KB_FULL,
  update_knowledge_base: TOOL_UPDATE_KB_FULL,
  delete_knowledge_base: TOOL_DELETE_KB_FULL,
  create_knowledge_connector: TOOL_CREATE_CONNECTOR_FULL,
  get_knowledge_connectors: TOOL_GET_CONNECTORS_FULL,
  get_knowledge_connector: TOOL_GET_CONNECTOR_FULL,
  update_knowledge_connector: TOOL_UPDATE_CONNECTOR_FULL,
  delete_knowledge_connector: TOOL_DELETE_CONNECTOR_FULL,
  assign_knowledge_connector_to_knowledge_base: TOOL_ASSIGN_CONNECTOR_KB_FULL,
  unassign_knowledge_connector_from_knowledge_base:
    TOOL_UNASSIGN_CONNECTOR_KB_FULL,
  assign_knowledge_base_to_agent: TOOL_ASSIGN_KB_AGENT_FULL,
  unassign_knowledge_base_from_agent: TOOL_UNASSIGN_KB_AGENT_FULL,
  assign_knowledge_connector_to_agent: TOOL_ASSIGN_CONNECTOR_AGENT_FULL,
  unassign_knowledge_connector_from_agent: TOOL_UNASSIGN_CONNECTOR_AGENT_FULL,
} = registry.toolFullNames;

const ALL_FULL_NAMES = new Set<string>([
  TOOL_CREATE_KB_FULL,
  TOOL_GET_KBS_FULL,
  TOOL_GET_KB_FULL,
  TOOL_UPDATE_KB_FULL,
  TOOL_DELETE_KB_FULL,
  TOOL_CREATE_CONNECTOR_FULL,
  TOOL_GET_CONNECTORS_FULL,
  TOOL_GET_CONNECTOR_FULL,
  TOOL_UPDATE_CONNECTOR_FULL,
  TOOL_DELETE_CONNECTOR_FULL,
  TOOL_ASSIGN_CONNECTOR_KB_FULL,
  TOOL_UNASSIGN_CONNECTOR_KB_FULL,
  TOOL_ASSIGN_KB_AGENT_FULL,
  TOOL_UNASSIGN_KB_AGENT_FULL,
  TOOL_ASSIGN_CONNECTOR_AGENT_FULL,
  TOOL_UNASSIGN_CONNECTOR_AGENT_FULL,
]);

export const toolShortNames = registry.toolShortNames;
export const toolArgsSchemas = registry.toolArgsSchemas;
export const tools = registry.tools;

export async function handleTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  context: ArchestraContext,
) {
  if (
    toolName !== TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME &&
    !ALL_FULL_NAMES.has(toolName)
  )
    return null;

  const { agent: contextAgent, organizationId } = context;

  logger.info(
    { agentId: contextAgent.id, tool: toolName, args },
    "knowledge-management tool called",
  );

  // --- Query Knowledge Sources ---

  if (toolName === TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME) {
    try {
      const query = args?.query as string | undefined;
      if (!query) {
        return errorResult("query parameter is required");
      }

      if (!organizationId) {
        return errorResult("Organization context not available.");
      }

      const agent = await AgentModel.findById(contextAgent.id);

      const hasKbs = agent?.knowledgeBaseIds?.length;
      const connectorAssignments =
        await AgentConnectorAssignmentModel.findByAgent(contextAgent.id);
      const directConnectorIds = connectorAssignments.map((a) => a.connectorId);

      if (!hasKbs && directConnectorIds.length === 0) {
        return errorResult(
          "No knowledge base or connector assigned to this agent. Assign a knowledge base or connector in agent settings to enable knowledge search.",
        );
      }

      // Resolve KB assignments to connector IDs and merge with direct assignments
      const kbConnectorIdArrays = hasKbs
        ? await Promise.all(
            agent.knowledgeBaseIds.map((kbId) =>
              KnowledgeBaseConnectorModel.getConnectorIds(kbId),
            ),
          )
        : [];
      const connectorIds = [
        ...new Set([...kbConnectorIdArrays.flat(), ...directConnectorIds]),
      ];

      if (connectorIds.length === 0) {
        return errorResult(
          "No connectors found for the assigned knowledge bases or agent. Add connectors to enable knowledge search.",
        );
      }

      // Build user ACL from assigned knowledge bases
      const validKbs = hasKbs
        ? (
            await Promise.all(
              agent.knowledgeBaseIds.map((id) =>
                KnowledgeBaseModel.findById(id),
              ),
            )
          ).filter((kb): kb is NonNullable<typeof kb> => kb !== null)
        : [];

      let userAcl: AclEntry[] = ["org:*"];
      if (context.userId) {
        const [user, teamIds] = await Promise.all([
          UserModel.getById(context.userId),
          TeamModel.getUserTeamIds(context.userId),
        ]);
        if (user?.email) {
          const visibility = validKbs.some((kb) => kb.visibility === "org-wide")
            ? "org-wide"
            : validKbs.some((kb) => kb.visibility === "team-scoped")
              ? "team-scoped"
              : "auto-sync-permissions";
          userAcl = buildUserAcl({
            userEmail: user.email,
            teamIds,
            visibility,
          });
        }
      }

      const results = await queryService.query({
        connectorIds,
        organizationId,
        queryText: query,
        userAcl,
        limit: 10,
      });

      return successResult(
        JSON.stringify({
          results,
          totalChunks: results.length,
        }),
      );
    } catch (error) {
      return catchError(error, "querying knowledge base");
    }
  }

  if (!organizationId) return errorResult("Organization context not available");

  // --- Knowledge Base CRUD ---

  if (toolName === TOOL_CREATE_KB_FULL) {
    try {
      const name = args?.name as string | undefined;
      if (!name) return errorResult("name is required");
      const parsed = InsertKnowledgeBaseSchema.parse({
        organizationId,
        name,
        description: (args?.description as string) || null,
      });
      const kb = await KnowledgeBaseModel.create(parsed);
      return successResult(
        `Knowledge base created successfully.\n\n${JSON.stringify(kb, null, 2)}`,
      );
    } catch (error) {
      return catchError(error, "creating knowledge base");
    }
  }

  if (toolName === TOOL_GET_KBS_FULL) {
    try {
      const kbs = await KnowledgeBaseModel.findByOrganization({
        organizationId,
      });
      if (kbs.length === 0) return successResult("No knowledge bases found.");
      return successResult(JSON.stringify(kbs, null, 2));
    } catch (error) {
      return catchError(error, "listing knowledge bases");
    }
  }

  if (toolName === TOOL_GET_KB_FULL) {
    try {
      const id = args?.id as string | undefined;
      if (!id) return errorResult("id is required");
      const kb = await KnowledgeBaseModel.findById(id);
      if (!kb || kb.organizationId !== organizationId)
        return errorResult(`Knowledge base not found: ${id}`);
      return successResult(JSON.stringify(kb, null, 2));
    } catch (error) {
      return catchError(error, "getting knowledge base");
    }
  }

  if (toolName === TOOL_UPDATE_KB_FULL) {
    try {
      const id = args?.id as string | undefined;
      if (!id) return errorResult("id is required");
      const updates: Record<string, unknown> = {};
      if (args?.name !== undefined) updates.name = args.name;
      if (args?.description !== undefined)
        updates.description = args.description;
      if (Object.keys(updates).length === 0)
        return errorResult("At least one field to update is required");
      const existing = await KnowledgeBaseModel.findById(id);
      if (!existing || existing.organizationId !== organizationId)
        return errorResult(`Knowledge base not found: ${id}`);
      const kb = await KnowledgeBaseModel.update(id, updates);
      if (!kb) return errorResult(`Knowledge base not found: ${id}`);
      return successResult(
        `Knowledge base updated successfully.\n\n${JSON.stringify(kb, null, 2)}`,
      );
    } catch (error) {
      return catchError(error, "updating knowledge base");
    }
  }

  if (toolName === TOOL_DELETE_KB_FULL) {
    try {
      const id = args?.id as string | undefined;
      if (!id) return errorResult("id is required");
      const existing = await KnowledgeBaseModel.findById(id);
      if (!existing || existing.organizationId !== organizationId)
        return errorResult(`Knowledge base not found: ${id}`);
      await KnowledgeBaseModel.delete(id);
      return successResult(`Knowledge base deleted: ${id}`);
    } catch (error) {
      return catchError(error, "deleting knowledge base");
    }
  }

  // --- Knowledge Connector CRUD ---

  if (toolName === TOOL_CREATE_CONNECTOR_FULL) {
    try {
      const name = args?.name as string | undefined;
      const connectorType = args?.connector_type as string | undefined;
      const config = args?.config as Record<string, unknown> | undefined;
      if (!name || !connectorType || !config)
        return errorResult("name, connector_type, and config are required");
      // Inject `type` as the discriminator for ConnectorConfigSchema (discriminated union on "type").
      // If the user also passes `type` in config, their value wins via spread order and Zod validates.
      const parsed = InsertKnowledgeBaseConnectorSchema.parse({
        organizationId,
        name,
        connectorType,
        config: { type: connectorType, ...config },
        description: (args?.description as string) || null,
      });
      const connector = await KnowledgeBaseConnectorModel.create(parsed);
      return successResult(
        `Knowledge connector created successfully.\n\n${JSON.stringify(connector, null, 2)}`,
      );
    } catch (error) {
      return catchError(error, "creating knowledge connector");
    }
  }

  if (toolName === TOOL_GET_CONNECTORS_FULL) {
    try {
      const connectors = await KnowledgeBaseConnectorModel.findByOrganization({
        organizationId,
      });
      if (connectors.length === 0)
        return successResult("No knowledge connectors found.");
      return successResult(JSON.stringify(connectors, null, 2));
    } catch (error) {
      return catchError(error, "listing knowledge connectors");
    }
  }

  if (toolName === TOOL_GET_CONNECTOR_FULL) {
    try {
      const id = args?.id as string | undefined;
      if (!id) return errorResult("id is required");
      const connector = await KnowledgeBaseConnectorModel.findById(id);
      if (!connector || connector.organizationId !== organizationId)
        return errorResult(`Knowledge connector not found: ${id}`);
      return successResult(JSON.stringify(connector, null, 2));
    } catch (error) {
      return catchError(error, "getting knowledge connector");
    }
  }

  if (toolName === TOOL_UPDATE_CONNECTOR_FULL) {
    try {
      const id = args?.id as string | undefined;
      if (!id) return errorResult("id is required");
      const rawUpdates: Record<string, unknown> = {};
      if (args?.name !== undefined) rawUpdates.name = args.name;
      if (args?.description !== undefined)
        rawUpdates.description = args.description;
      if (args?.enabled !== undefined) rawUpdates.enabled = args.enabled;
      if (args?.config !== undefined) rawUpdates.config = args.config;
      if (Object.keys(rawUpdates).length === 0)
        return errorResult("At least one field to update is required");
      const updates =
        UpdateKnowledgeBaseConnectorSchema.partial().parse(rawUpdates);
      const existingConnector = await KnowledgeBaseConnectorModel.findById(id);
      if (
        !existingConnector ||
        existingConnector.organizationId !== organizationId
      )
        return errorResult(`Knowledge connector not found: ${id}`);
      const connector = await KnowledgeBaseConnectorModel.update(id, updates);
      if (!connector)
        return errorResult(`Knowledge connector not found: ${id}`);
      return successResult(
        `Knowledge connector updated successfully.\n\n${JSON.stringify(connector, null, 2)}`,
      );
    } catch (error) {
      return catchError(error, "updating knowledge connector");
    }
  }

  if (toolName === TOOL_DELETE_CONNECTOR_FULL) {
    try {
      const id = args?.id as string | undefined;
      if (!id) return errorResult("id is required");
      const existing = await KnowledgeBaseConnectorModel.findById(id);
      if (!existing || existing.organizationId !== organizationId)
        return errorResult(`Knowledge connector not found: ${id}`);
      await KnowledgeBaseConnectorModel.delete(id);
      return successResult(`Knowledge connector deleted: ${id}`);
    } catch (error) {
      return catchError(error, "deleting knowledge connector");
    }
  }

  // --- Connector <-> KB Assignments ---

  if (toolName === TOOL_ASSIGN_CONNECTOR_KB_FULL) {
    try {
      const connectorId = args?.connector_id as string | undefined;
      const kbId = args?.knowledge_base_id as string | undefined;
      if (!connectorId || !kbId)
        return errorResult("connector_id and knowledge_base_id are required");
      await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
        connectorId,
        kbId,
      );
      return successResult(
        `Knowledge connector ${connectorId} assigned to knowledge base ${kbId}`,
      );
    } catch (error) {
      return catchError(
        error,
        "assigning knowledge connector to knowledge base",
      );
    }
  }

  if (toolName === TOOL_UNASSIGN_CONNECTOR_KB_FULL) {
    try {
      const connectorId = args?.connector_id as string | undefined;
      const kbId = args?.knowledge_base_id as string | undefined;
      if (!connectorId || !kbId)
        return errorResult("connector_id and knowledge_base_id are required");
      const kbIds =
        await KnowledgeBaseConnectorModel.getKnowledgeBaseIds(connectorId);
      if (!kbIds.includes(kbId))
        return errorResult(
          `Knowledge connector ${connectorId} is not assigned to knowledge base ${kbId}`,
        );
      await KnowledgeBaseConnectorModel.unassignFromKnowledgeBase(
        connectorId,
        kbId,
      );
      return successResult(
        `Knowledge connector ${connectorId} unassigned from knowledge base ${kbId}`,
      );
    } catch (error) {
      return catchError(
        error,
        "unassigning knowledge connector from knowledge base",
      );
    }
  }

  // --- KB <-> Agent Assignments ---

  if (toolName === TOOL_ASSIGN_KB_AGENT_FULL) {
    try {
      const kbId = args?.knowledge_base_id as string | undefined;
      const agentId = args?.agent_id as string | undefined;
      if (!kbId || !agentId)
        return errorResult("knowledge_base_id and agent_id are required");
      await AgentKnowledgeBaseModel.assign(agentId, kbId);
      return successResult(
        `Knowledge base ${kbId} assigned to agent ${agentId}`,
      );
    } catch (error) {
      return catchError(error, "assigning knowledge base to agent");
    }
  }

  if (toolName === TOOL_UNASSIGN_KB_AGENT_FULL) {
    try {
      const kbId = args?.knowledge_base_id as string | undefined;
      const agentId = args?.agent_id as string | undefined;
      if (!kbId || !agentId)
        return errorResult("knowledge_base_id and agent_id are required");
      const kbIds = await AgentKnowledgeBaseModel.getKnowledgeBaseIds(agentId);
      if (!kbIds.includes(kbId))
        return errorResult(
          `Knowledge base ${kbId} is not assigned to agent ${agentId}`,
        );
      await AgentKnowledgeBaseModel.unassign(agentId, kbId);
      return successResult(
        `Knowledge base ${kbId} unassigned from agent ${agentId}`,
      );
    } catch (error) {
      return catchError(error, "unassigning knowledge base from agent");
    }
  }

  // --- Connector <-> Agent Assignments ---

  if (toolName === TOOL_ASSIGN_CONNECTOR_AGENT_FULL) {
    try {
      const connectorId = args?.connector_id as string | undefined;
      const agentId = args?.agent_id as string | undefined;
      if (!connectorId || !agentId)
        return errorResult("connector_id and agent_id are required");
      await AgentConnectorAssignmentModel.assign(agentId, connectorId);
      return successResult(
        `Knowledge connector ${connectorId} assigned to agent ${agentId}`,
      );
    } catch (error) {
      return catchError(error, "assigning knowledge connector to agent");
    }
  }

  if (toolName === TOOL_UNASSIGN_CONNECTOR_AGENT_FULL) {
    try {
      const connectorId = args?.connector_id as string | undefined;
      const agentId = args?.agent_id as string | undefined;
      if (!connectorId || !agentId)
        return errorResult("connector_id and agent_id are required");
      const connectorIds =
        await AgentConnectorAssignmentModel.getConnectorIds(agentId);
      if (!connectorIds.includes(connectorId))
        return errorResult(
          `Knowledge connector ${connectorId} is not assigned to agent ${agentId}`,
        );
      await AgentConnectorAssignmentModel.unassign(agentId, connectorId);
      return successResult(
        `Knowledge connector ${connectorId} unassigned from agent ${agentId}`,
      );
    } catch (error) {
      return catchError(error, "unassigning knowledge connector from agent");
    }
  }

  return null;
}
