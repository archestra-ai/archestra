import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
} from "@shared";
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
} from "@/types";
import { catchError, errorResult, successResult } from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

const TOOL_CREATE_KB_NAME = "create_knowledge_base";
const TOOL_GET_KBS_NAME = "get_knowledge_bases";
const TOOL_GET_KB_NAME = "get_knowledge_base";
const TOOL_UPDATE_KB_NAME = "update_knowledge_base";
const TOOL_DELETE_KB_NAME = "delete_knowledge_base";
const TOOL_CREATE_CONNECTOR_NAME = "create_knowledge_connector";
const TOOL_GET_CONNECTORS_NAME = "get_knowledge_connectors";
const TOOL_GET_CONNECTOR_NAME = "get_knowledge_connector";
const TOOL_UPDATE_CONNECTOR_NAME = "update_knowledge_connector";
const TOOL_DELETE_CONNECTOR_NAME = "delete_knowledge_connector";
const TOOL_ASSIGN_CONNECTOR_KB_NAME =
  "assign_knowledge_connector_to_knowledge_base";
const TOOL_UNASSIGN_CONNECTOR_KB_NAME =
  "unassign_knowledge_connector_from_knowledge_base";
const TOOL_ASSIGN_KB_AGENT_NAME = "assign_knowledge_base_to_agent";
const TOOL_UNASSIGN_KB_AGENT_NAME = "unassign_knowledge_base_from_agent";
const TOOL_ASSIGN_CONNECTOR_AGENT_NAME = "assign_knowledge_connector_to_agent";
const TOOL_UNASSIGN_CONNECTOR_AGENT_NAME =
  "unassign_knowledge_connector_from_agent";

const fullName = (short: string) =>
  `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${short}`;

const TOOL_CREATE_KB_FULL = fullName(TOOL_CREATE_KB_NAME);
const TOOL_GET_KBS_FULL = fullName(TOOL_GET_KBS_NAME);
const TOOL_GET_KB_FULL = fullName(TOOL_GET_KB_NAME);
const TOOL_UPDATE_KB_FULL = fullName(TOOL_UPDATE_KB_NAME);
const TOOL_DELETE_KB_FULL = fullName(TOOL_DELETE_KB_NAME);
const TOOL_CREATE_CONNECTOR_FULL = fullName(TOOL_CREATE_CONNECTOR_NAME);
const TOOL_GET_CONNECTORS_FULL = fullName(TOOL_GET_CONNECTORS_NAME);
const TOOL_GET_CONNECTOR_FULL = fullName(TOOL_GET_CONNECTOR_NAME);
const TOOL_UPDATE_CONNECTOR_FULL = fullName(TOOL_UPDATE_CONNECTOR_NAME);
const TOOL_DELETE_CONNECTOR_FULL = fullName(TOOL_DELETE_CONNECTOR_NAME);
const TOOL_ASSIGN_CONNECTOR_KB_FULL = fullName(TOOL_ASSIGN_CONNECTOR_KB_NAME);
const TOOL_UNASSIGN_CONNECTOR_KB_FULL = fullName(
  TOOL_UNASSIGN_CONNECTOR_KB_NAME,
);
const TOOL_ASSIGN_KB_AGENT_FULL = fullName(TOOL_ASSIGN_KB_AGENT_NAME);
const TOOL_UNASSIGN_KB_AGENT_FULL = fullName(TOOL_UNASSIGN_KB_AGENT_NAME);
const TOOL_ASSIGN_CONNECTOR_AGENT_FULL = fullName(
  TOOL_ASSIGN_CONNECTOR_AGENT_NAME,
);
const TOOL_UNASSIGN_CONNECTOR_AGENT_FULL = fullName(
  TOOL_UNASSIGN_CONNECTOR_AGENT_NAME,
);

const ALL_FULL_NAMES = new Set([
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

// === Exports ===

export const toolShortNames = [
  "query_knowledge_sources",
  TOOL_CREATE_KB_NAME,
  TOOL_GET_KBS_NAME,
  TOOL_GET_KB_NAME,
  TOOL_UPDATE_KB_NAME,
  TOOL_DELETE_KB_NAME,
  TOOL_CREATE_CONNECTOR_NAME,
  TOOL_GET_CONNECTORS_NAME,
  TOOL_GET_CONNECTOR_NAME,
  TOOL_UPDATE_CONNECTOR_NAME,
  TOOL_DELETE_CONNECTOR_NAME,
  TOOL_ASSIGN_CONNECTOR_KB_NAME,
  TOOL_UNASSIGN_CONNECTOR_KB_NAME,
  TOOL_ASSIGN_KB_AGENT_NAME,
  TOOL_UNASSIGN_KB_AGENT_NAME,
  TOOL_ASSIGN_CONNECTOR_AGENT_NAME,
  TOOL_UNASSIGN_CONNECTOR_AGENT_NAME,
] as const;

export const tools: Tool[] = [
  // --- Query Knowledge Sources ---
  {
    name: TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
    title: "Query Knowledge Sources",
    description:
      "Query the organization's knowledge sources to retrieve relevant information. Use this tool when the user asks a question you cannot answer from your training data alone, or when they explicitly ask you to search internal documents and data sources. Formulate queries about the actual content you are looking for — ask about topics, concepts, or information rather than about source systems.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "A natural language query about the content you are looking for. Ask about topics, concepts, or information rather than about source systems.",
        },
      },
      required: ["query"],
    },
    annotations: {},
    _meta: {},
  },
  // --- Knowledge Base CRUD ---
  {
    name: TOOL_CREATE_KB_FULL,
    title: "Create Knowledge Base",
    description:
      "Create a new knowledge base for organizing knowledge connectors.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the knowledge base" },
        description: {
          type: "string",
          description: "Description of the knowledge base",
        },
      },
      required: ["name"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_GET_KBS_FULL,
    title: "Get Knowledge Bases",
    description: "List all knowledge bases in the organization.",
    inputSchema: { type: "object", properties: {} },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_GET_KB_FULL,
    title: "Get Knowledge Base",
    description: "Get details of a specific knowledge base by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Knowledge base ID" },
      },
      required: ["id"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_UPDATE_KB_FULL,
    title: "Update Knowledge Base",
    description: "Update an existing knowledge base.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Knowledge base ID" },
        name: { type: "string", description: "New name" },
        description: { type: "string", description: "New description" },
      },
      required: ["id"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_DELETE_KB_FULL,
    title: "Delete Knowledge Base",
    description: "Delete a knowledge base by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Knowledge base ID" },
      },
      required: ["id"],
    },
    annotations: {},
    _meta: {},
  },
  // --- Knowledge Connector CRUD ---
  {
    name: TOOL_CREATE_CONNECTOR_FULL,
    title: "Create Knowledge Connector",
    description:
      "Create a new knowledge connector for ingesting data from external sources.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the knowledge connector",
        },
        connector_type: {
          type: "string",
          description:
            "Type of the knowledge connector (e.g., jira, confluence, google_drive)",
        },
        config: {
          type: "object",
          description:
            "Configuration for the knowledge connector (depends on connector_type)",
        },
        description: {
          type: "string",
          description: "Description of the knowledge connector",
        },
      },
      required: ["name", "connector_type", "config"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_GET_CONNECTORS_FULL,
    title: "Get Knowledge Connectors",
    description: "List all knowledge connectors in the organization.",
    inputSchema: { type: "object", properties: {} },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_GET_CONNECTOR_FULL,
    title: "Get Knowledge Connector",
    description: "Get details of a specific knowledge connector by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Knowledge connector ID" },
      },
      required: ["id"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_UPDATE_CONNECTOR_FULL,
    title: "Update Knowledge Connector",
    description: "Update an existing knowledge connector.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Knowledge connector ID" },
        name: { type: "string", description: "New name" },
        description: { type: "string", description: "New description" },
        enabled: {
          type: "boolean",
          description: "Whether the knowledge connector is enabled",
        },
        config: {
          type: "object",
          description:
            "Updated connector configuration (provider-specific settings)",
        },
      },
      required: ["id"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_DELETE_CONNECTOR_FULL,
    title: "Delete Knowledge Connector",
    description: "Delete a knowledge connector by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Knowledge connector ID" },
      },
      required: ["id"],
    },
    annotations: {},
    _meta: {},
  },
  // --- Connector <-> Knowledge Base Assignments ---
  {
    name: TOOL_ASSIGN_CONNECTOR_KB_FULL,
    title: "Assign Knowledge Connector to Knowledge Base",
    description: "Assign a knowledge connector to a knowledge base.",
    inputSchema: {
      type: "object",
      properties: {
        connector_id: {
          type: "string",
          description: "Knowledge connector ID",
        },
        knowledge_base_id: {
          type: "string",
          description: "Knowledge base ID",
        },
      },
      required: ["connector_id", "knowledge_base_id"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_UNASSIGN_CONNECTOR_KB_FULL,
    title: "Unassign Knowledge Connector from Knowledge Base",
    description: "Remove a knowledge connector from a knowledge base.",
    inputSchema: {
      type: "object",
      properties: {
        connector_id: {
          type: "string",
          description: "Knowledge connector ID",
        },
        knowledge_base_id: {
          type: "string",
          description: "Knowledge base ID",
        },
      },
      required: ["connector_id", "knowledge_base_id"],
    },
    annotations: {},
    _meta: {},
  },
  // --- Knowledge Base <-> Agent Assignments ---
  {
    name: TOOL_ASSIGN_KB_AGENT_FULL,
    title: "Assign Knowledge Base to Agent",
    description: "Assign a knowledge base to an agent.",
    inputSchema: {
      type: "object",
      properties: {
        knowledge_base_id: {
          type: "string",
          description: "Knowledge base ID",
        },
        agent_id: { type: "string", description: "Agent ID" },
      },
      required: ["knowledge_base_id", "agent_id"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_UNASSIGN_KB_AGENT_FULL,
    title: "Unassign Knowledge Base from Agent",
    description: "Remove a knowledge base from an agent.",
    inputSchema: {
      type: "object",
      properties: {
        knowledge_base_id: {
          type: "string",
          description: "Knowledge base ID",
        },
        agent_id: { type: "string", description: "Agent ID" },
      },
      required: ["knowledge_base_id", "agent_id"],
    },
    annotations: {},
    _meta: {},
  },
  // --- Knowledge Connector <-> Agent Assignments ---
  {
    name: TOOL_ASSIGN_CONNECTOR_AGENT_FULL,
    title: "Assign Knowledge Connector to Agent",
    description:
      "Directly assign a knowledge connector to an agent (bypassing knowledge base).",
    inputSchema: {
      type: "object",
      properties: {
        connector_id: {
          type: "string",
          description: "Knowledge connector ID",
        },
        agent_id: { type: "string", description: "Agent ID" },
      },
      required: ["connector_id", "agent_id"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_UNASSIGN_CONNECTOR_AGENT_FULL,
    title: "Unassign Knowledge Connector from Agent",
    description:
      "Remove a directly-assigned knowledge connector from an agent.",
    inputSchema: {
      type: "object",
      properties: {
        connector_id: {
          type: "string",
          description: "Knowledge connector ID",
        },
        agent_id: { type: "string", description: "Agent ID" },
      },
      required: ["connector_id", "agent_id"],
    },
    annotations: {},
    _meta: {},
  },
];

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
