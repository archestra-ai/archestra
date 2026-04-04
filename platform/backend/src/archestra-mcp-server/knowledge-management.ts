import {
  TOOL_ASSIGN_KNOWLEDGE_BASE_TO_AGENT_SHORT_NAME,
  TOOL_ASSIGN_KNOWLEDGE_CONNECTOR_TO_AGENT_SHORT_NAME,
  TOOL_ASSIGN_KNOWLEDGE_CONNECTOR_TO_KNOWLEDGE_BASE_SHORT_NAME,
  TOOL_CREATE_KNOWLEDGE_BASE_SHORT_NAME,
  TOOL_CREATE_KNOWLEDGE_CONNECTOR_SHORT_NAME,
  TOOL_DELETE_KNOWLEDGE_BASE_SHORT_NAME,
  TOOL_DELETE_KNOWLEDGE_CONNECTOR_SHORT_NAME,
  TOOL_GET_KNOWLEDGE_BASE_SHORT_NAME,
  TOOL_GET_KNOWLEDGE_BASES_SHORT_NAME,
  TOOL_GET_KNOWLEDGE_CONNECTOR_SHORT_NAME,
  TOOL_GET_KNOWLEDGE_CONNECTORS_SHORT_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  TOOL_UNASSIGN_KNOWLEDGE_BASE_FROM_AGENT_SHORT_NAME,
  TOOL_UNASSIGN_KNOWLEDGE_CONNECTOR_FROM_AGENT_SHORT_NAME,
  TOOL_UNASSIGN_KNOWLEDGE_CONNECTOR_FROM_KNOWLEDGE_BASE_SHORT_NAME,
  TOOL_UPDATE_KNOWLEDGE_BASE_SHORT_NAME,
  TOOL_UPDATE_KNOWLEDGE_CONNECTOR_SHORT_NAME,
} from "@shared";
import { z } from "zod";
import {
  buildUserAccessControlList,
  didKnowledgeSourceAclInputsChange,
  isTeamScopedWithoutTeams,
  knowledgeSourceAccessControlService,
  queryService,
} from "@/knowledge-base";
import logger from "@/logging";
import {
  AgentConnectorAssignmentModel,
  AgentKnowledgeBaseModel,
  AgentModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  UserModel,
} from "@/models";
import {
  type AclEntry,
  InsertKnowledgeBaseConnectorSchema,
  InsertKnowledgeBaseSchema,
  KnowledgeSourceVisibilitySchema,
  UpdateKnowledgeBaseConnectorSchema,
  UpdateKnowledgeBaseSchema,
  UuidIdSchema,
} from "@/types";
import { archestraMcpBranding } from "./branding";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  EmptyToolArgsSchema,
  errorResult,
  structuredSuccessResult,
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
    visibility: KnowledgeSourceVisibilitySchema.optional().describe(
      "Visibility for the knowledge connector.",
    ),
    team_ids: z
      .array(z.string())
      .optional()
      .describe("Team IDs allowed to access a team-scoped connector."),
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
    visibility: KnowledgeSourceVisibilitySchema.optional().describe(
      "Updated visibility for the connector.",
    ),
    team_ids: z
      .array(z.string())
      .optional()
      .describe("Updated team IDs for a team-scoped connector."),
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

const QueryKnowledgeSourcesOutputSchema = z.object({
  results: z.array(z.unknown()).describe("Retrieved knowledge results."),
  totalChunks: z.number().describe("The number of result chunks returned."),
});

const KnowledgeBaseOutputItemSchema = z.object({
  id: z.string().describe("The knowledge base ID."),
  organizationId: z.string().describe("The organization ID."),
  name: z.string().describe("The knowledge base name."),
  description: z
    .string()
    .nullable()
    .describe("The knowledge base description, if any."),
  status: z.string().describe("The knowledge base status."),
});

const KnowledgeBasesOutputSchema = z.object({
  knowledgeBases: z
    .array(KnowledgeBaseOutputItemSchema)
    .describe("Knowledge bases in the organization."),
});

const KnowledgeBaseOutputSchema = z.object({
  knowledgeBase: KnowledgeBaseOutputItemSchema.describe(
    "The requested knowledge base.",
  ),
});

const KnowledgeConnectorOutputItemSchema = z.object({
  id: z.string().describe("The knowledge connector ID."),
  organizationId: z.string().describe("The organization ID."),
  knowledgeBaseId: z.string().nullable().optional(),
  name: z.string().describe("The connector name."),
  connectorType: z.string().describe("The connector type."),
  description: z
    .string()
    .nullable()
    .describe("The connector description, if any."),
  enabled: z.boolean().optional(),
  config: z
    .unknown()
    .describe("The provider-specific connector configuration."),
});

const KnowledgeConnectorsOutputSchema = z.object({
  knowledgeConnectors: z
    .array(KnowledgeConnectorOutputItemSchema)
    .describe("Knowledge connectors in the organization."),
});

const KnowledgeConnectorOutputSchema = z.object({
  knowledgeConnector: KnowledgeConnectorOutputItemSchema.describe(
    "The requested knowledge connector.",
  ),
});

const QueryKnowledgeSourcesToolArgsSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .describe(
        "The user's original query, passed verbatim without rephrasing or expansion.",
      ),
  })
  .strict();

const GetKnowledgeBaseToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe("Knowledge base ID."),
  })
  .strict();

const DeleteKnowledgeBaseToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe("Knowledge base ID."),
  })
  .strict();

const GetKnowledgeConnectorToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe("Knowledge connector ID."),
  })
  .strict();

const DeleteKnowledgeConnectorToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe("Knowledge connector ID."),
  })
  .strict();

type QueryKnowledgeSourcesToolArgs = z.infer<
  typeof QueryKnowledgeSourcesToolArgsSchema
>;
type KnowledgeBaseCreateToolArgs = z.infer<
  typeof KnowledgeBaseCreateToolArgsSchema
>;
type KnowledgeBaseUpdateToolArgs = z.infer<
  typeof KnowledgeBaseUpdateToolArgsSchema
>;
type GetKnowledgeBaseToolArgs = z.infer<typeof GetKnowledgeBaseToolArgsSchema>;
type DeleteKnowledgeBaseToolArgs = z.infer<
  typeof DeleteKnowledgeBaseToolArgsSchema
>;
type ConnectorCreateToolArgs = z.infer<typeof ConnectorCreateToolArgsSchema>;
type ConnectorUpdateToolArgs = z.infer<typeof ConnectorUpdateToolArgsSchema>;
type GetKnowledgeConnectorToolArgs = z.infer<
  typeof GetKnowledgeConnectorToolArgsSchema
>;
type DeleteKnowledgeConnectorToolArgs = z.infer<
  typeof DeleteKnowledgeConnectorToolArgsSchema
>;
type ConnectorKnowledgeBaseAssignmentArgs = z.infer<
  typeof ConnectorKnowledgeBaseAssignmentSchema
>;
type KnowledgeBaseAgentAssignmentArgs = z.infer<
  typeof KnowledgeBaseAgentAssignmentSchema
>;
type ConnectorAgentAssignmentArgs = z.infer<
  typeof ConnectorAgentAssignmentSchema
>;

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
    title: "Query Knowledge Sources",
    description:
      "Query the organization's knowledge sources to retrieve relevant information. Use this tool when the user asks a question you cannot answer from your training data alone, or when they explicitly ask you to search internal documents and data sources. Pass the user's original query as-is — do not rephrase, summarize, or expand it. The system performs its own query optimization internally.",
    schema: QueryKnowledgeSourcesToolArgsSchema,
    outputSchema: QueryKnowledgeSourcesOutputSchema,
    async handler({ args, context }) {
      return handleQueryKnowledgeSources({ args, context });
    },
  }),
  // --- Knowledge Base CRUD ---
  defineArchestraTool({
    shortName: TOOL_CREATE_KNOWLEDGE_BASE_SHORT_NAME,
    title: "Create Knowledge Base",
    description:
      "Create a new knowledge base for organizing knowledge connectors.",
    schema: KnowledgeBaseCreateToolArgsSchema,
    outputSchema: KnowledgeBaseOutputSchema,
    async handler({ args, context }) {
      return handleCreateKnowledgeBase({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_GET_KNOWLEDGE_BASES_SHORT_NAME,
    title: "Get Knowledge Bases",
    description: "List all knowledge bases in the organization.",
    schema: EmptyToolArgsSchema,
    outputSchema: KnowledgeBasesOutputSchema,
    async handler({ context }) {
      return handleGetKnowledgeBases({ context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_GET_KNOWLEDGE_BASE_SHORT_NAME,
    title: "Get Knowledge Base",
    description: "Get details of a specific knowledge base by ID.",
    schema: GetKnowledgeBaseToolArgsSchema,
    outputSchema: KnowledgeBaseOutputSchema,
    async handler({ args, context }) {
      return handleGetKnowledgeBase({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_UPDATE_KNOWLEDGE_BASE_SHORT_NAME,
    title: "Update Knowledge Base",
    description: "Update an existing knowledge base.",
    schema: KnowledgeBaseUpdateToolArgsSchema,
    outputSchema: KnowledgeBaseOutputSchema,
    async handler({ args, context }) {
      return handleUpdateKnowledgeBase({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_DELETE_KNOWLEDGE_BASE_SHORT_NAME,
    title: "Delete Knowledge Base",
    description: "Delete a knowledge base by ID.",
    schema: DeleteKnowledgeBaseToolArgsSchema,
    async handler({ args, context }) {
      return handleDeleteKnowledgeBase({ args, context });
    },
  }),
  // --- Knowledge Connector CRUD ---
  defineArchestraTool({
    shortName: TOOL_CREATE_KNOWLEDGE_CONNECTOR_SHORT_NAME,
    title: "Create Knowledge Connector",
    description:
      "Create a new knowledge connector for ingesting data from external sources.",
    schema: ConnectorCreateToolArgsSchema,
    outputSchema: KnowledgeConnectorOutputSchema,
    async handler({ args, context }) {
      return handleCreateKnowledgeConnector({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_GET_KNOWLEDGE_CONNECTORS_SHORT_NAME,
    title: "Get Knowledge Connectors",
    description: "List all knowledge connectors in the organization.",
    schema: EmptyToolArgsSchema,
    outputSchema: KnowledgeConnectorsOutputSchema,
    async handler({ context }) {
      return handleGetKnowledgeConnectors({ context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_GET_KNOWLEDGE_CONNECTOR_SHORT_NAME,
    title: "Get Knowledge Connector",
    description: "Get details of a specific knowledge connector by ID.",
    schema: GetKnowledgeConnectorToolArgsSchema,
    outputSchema: KnowledgeConnectorOutputSchema,
    async handler({ args, context }) {
      return handleGetKnowledgeConnector({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_UPDATE_KNOWLEDGE_CONNECTOR_SHORT_NAME,
    title: "Update Knowledge Connector",
    description: "Update an existing knowledge connector.",
    schema: ConnectorUpdateToolArgsSchema,
    outputSchema: KnowledgeConnectorOutputSchema,
    async handler({ args, context }) {
      return handleUpdateKnowledgeConnector({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_DELETE_KNOWLEDGE_CONNECTOR_SHORT_NAME,
    title: "Delete Knowledge Connector",
    description: "Delete a knowledge connector by ID.",
    schema: DeleteKnowledgeConnectorToolArgsSchema,
    async handler({ args, context }) {
      return handleDeleteKnowledgeConnector({ args, context });
    },
  }),
  // --- Connector <-> Knowledge Base Assignments ---
  defineArchestraTool({
    shortName: TOOL_ASSIGN_KNOWLEDGE_CONNECTOR_TO_KNOWLEDGE_BASE_SHORT_NAME,
    title: "Assign Knowledge Connector to Knowledge Base",
    description: "Assign a knowledge connector to a knowledge base.",
    schema: ConnectorKnowledgeBaseAssignmentSchema,
    async handler({ args, context }) {
      return handleAssignKnowledgeConnectorToKnowledgeBase({
        args,
        context,
      });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_UNASSIGN_KNOWLEDGE_CONNECTOR_FROM_KNOWLEDGE_BASE_SHORT_NAME,
    title: "Unassign Knowledge Connector from Knowledge Base",
    description: "Remove a knowledge connector from a knowledge base.",
    schema: ConnectorKnowledgeBaseAssignmentSchema,
    async handler({ args, context }) {
      return handleUnassignKnowledgeConnectorFromKnowledgeBase({
        args,
        context,
      });
    },
  }),
  // --- Knowledge Base <-> Agent Assignments ---
  defineArchestraTool({
    shortName: TOOL_ASSIGN_KNOWLEDGE_BASE_TO_AGENT_SHORT_NAME,
    title: "Assign Knowledge Base to Agent",
    description: "Assign a knowledge base to an agent.",
    schema: KnowledgeBaseAgentAssignmentSchema,
    async handler({ args, context }) {
      return handleAssignKnowledgeBaseToAgent({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_UNASSIGN_KNOWLEDGE_BASE_FROM_AGENT_SHORT_NAME,
    title: "Unassign Knowledge Base from Agent",
    description: "Remove a knowledge base from an agent.",
    schema: KnowledgeBaseAgentAssignmentSchema,
    async handler({ args, context }) {
      return handleUnassignKnowledgeBaseFromAgent({ args, context });
    },
  }),
  // --- Knowledge Connector <-> Agent Assignments ---
  defineArchestraTool({
    shortName: TOOL_ASSIGN_KNOWLEDGE_CONNECTOR_TO_AGENT_SHORT_NAME,
    title: "Assign Knowledge Connector to Agent",
    description:
      "Directly assign a knowledge connector to an agent (bypassing knowledge base).",
    schema: ConnectorAgentAssignmentSchema,
    async handler({ args, context }) {
      return handleAssignKnowledgeConnectorToAgent({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_UNASSIGN_KNOWLEDGE_CONNECTOR_FROM_AGENT_SHORT_NAME,
    title: "Unassign Knowledge Connector from Agent",
    description:
      "Remove a directly-assigned knowledge connector from an agent.",
    schema: ConnectorAgentAssignmentSchema,
    async handler({ args, context }) {
      return handleUnassignKnowledgeConnectorFromAgent({ args, context });
    },
  }),
] as const);

export const toolShortNames = registry.toolShortNames;
export const toolArgsSchemas = registry.toolArgsSchemas;
export const toolOutputSchemas = registry.toolOutputSchemas;
export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

async function handleQueryKnowledgeSources(params: {
  args: QueryKnowledgeSourcesToolArgs;
  context: ArchestraContext;
}) {
  const { args, context } = params;
  const { agent: contextAgent, organizationId } = context;

  logger.info(
    {
      agentId: contextAgent.id,
      tool: archestraMcpBranding.getToolName(
        TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
      ),
      args,
    },
    "knowledge-management tool called",
  );

  try {
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

    const access =
      context.userId && organizationId
        ? await knowledgeSourceAccessControlService.buildAccessControlContext({
            userId: context.userId,
            organizationId,
          })
        : null;

    const validKbs = hasKbs
      ? await KnowledgeBaseModel.findByIds(agent.knowledgeBaseIds)
      : [];
    const visibleKbs = access
      ? knowledgeSourceAccessControlService.filterKnowledgeBases(
          access,
          validKbs,
        )
      : validKbs;

    const directConnectors = directConnectorIds.length
      ? await KnowledgeBaseConnectorModel.findByIds(directConnectorIds)
      : [];
    const visibleDirectConnectors = access
      ? knowledgeSourceAccessControlService.filterConnectors(
          access,
          directConnectors,
        )
      : directConnectors;

    const connectorIdsFromVisibleKbs = visibleKbs.length
      ? (
          await Promise.all(
            visibleKbs.map((kb) =>
              KnowledgeBaseConnectorModel.findByKnowledgeBaseId(kb.id, {
                canReadAll: access?.canReadAll,
                viewerTeamIds: access?.teamIds,
              }),
            ),
          )
        )
          .flat()
          .map((connector) => connector.id)
      : [];
    const connectorIds = [
      ...new Set([
        ...connectorIdsFromVisibleKbs,
        ...visibleDirectConnectors.map((connector) => connector.id),
      ]),
    ];

    if (visibleKbs.length === 0 && visibleDirectConnectors.length === 0) {
      return errorResult(
        "No visible knowledge sources found for the current user.",
      );
    }

    if (connectorIds.length === 0) {
      return errorResult(
        "No connectors found for the assigned knowledge bases or agent. Add connectors to enable knowledge search.",
      );
    }

    let userAcl: AclEntry[] = ["org:*"];
    if (context.userId) {
      const user = await UserModel.getById(context.userId);
      if (user?.email) {
        userAcl = buildUserAccessControlList({
          userEmail: user.email,
          teamIds: access?.teamIds ?? [],
        });
      }
    }

    const results = await queryService.query({
      connectorIds,
      organizationId,
      queryText: args.query,
      userAcl,
      bypassAcl: access?.canReadAll ?? false,
      limit: 10,
    });

    const output = {
      results,
      totalChunks: results.length,
    };
    return structuredSuccessResult(output, JSON.stringify(output));
  } catch (error) {
    return catchError(error, "querying knowledge base");
  }
}

async function handleCreateKnowledgeBase(params: {
  args: KnowledgeBaseCreateToolArgs;
  context: ArchestraContext;
}) {
  const { args, context } = params;

  try {
    if (!context.organizationId) {
      return errorResult("Organization context not available");
    }

    const kb = await KnowledgeBaseModel.create(
      InsertKnowledgeBaseSchema.parse({
        organizationId: context.organizationId,
        name: args.name,
        description: args.description ?? null,
      }),
    );
    return structuredSuccessResult(
      { knowledgeBase: kb },
      `Knowledge base created successfully.\n\n${JSON.stringify(kb, null, 2)}`,
    );
  } catch (error) {
    return catchError(error, "creating knowledge base");
  }
}

async function handleGetKnowledgeBases(params: { context: ArchestraContext }) {
  const { context } = params;

  try {
    if (!context.organizationId) {
      return errorResult("Organization context not available");
    }

    const kbs = await KnowledgeBaseModel.findByOrganization({
      organizationId: context.organizationId,
    });
    if (kbs.length === 0) {
      return structuredSuccessResult(
        { knowledgeBases: [] },
        "No knowledge bases found.",
      );
    }
    return structuredSuccessResult(
      { knowledgeBases: kbs },
      JSON.stringify(kbs, null, 2),
    );
  } catch (error) {
    return catchError(error, "listing knowledge bases");
  }
}

async function handleGetKnowledgeBase(params: {
  args: GetKnowledgeBaseToolArgs;
  context: ArchestraContext;
}) {
  const { args, context } = params;

  try {
    if (!context.organizationId) {
      return errorResult("Organization context not available");
    }

    const kb = await KnowledgeBaseModel.findById(args.id);
    if (!kb || kb.organizationId !== context.organizationId) {
      return errorResult(`Knowledge base not found: ${args.id}`);
    }
    return structuredSuccessResult(
      { knowledgeBase: kb },
      JSON.stringify(kb, null, 2),
    );
  } catch (error) {
    return catchError(error, "getting knowledge base");
  }
}

async function handleUpdateKnowledgeBase(params: {
  args: KnowledgeBaseUpdateToolArgs;
  context: ArchestraContext;
}) {
  const { args, context } = params;

  try {
    if (!context.organizationId) {
      return errorResult("Organization context not available");
    }

    const updates: Record<string, unknown> = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.description !== undefined) updates.description = args.description;
    if (Object.keys(updates).length === 0) {
      return errorResult("At least one field to update is required");
    }

    const existing = await KnowledgeBaseModel.findById(args.id);
    if (!existing || existing.organizationId !== context.organizationId) {
      return errorResult(`Knowledge base not found: ${args.id}`);
    }
    const kb = await KnowledgeBaseModel.update(args.id, updates);
    if (!kb) {
      return errorResult(`Knowledge base not found: ${args.id}`);
    }
    return structuredSuccessResult(
      { knowledgeBase: kb },
      `Knowledge base updated successfully.\n\n${JSON.stringify(kb, null, 2)}`,
    );
  } catch (error) {
    return catchError(error, "updating knowledge base");
  }
}

async function handleDeleteKnowledgeBase(params: {
  args: DeleteKnowledgeBaseToolArgs;
  context: ArchestraContext;
}) {
  const { args, context } = params;

  try {
    if (!context.organizationId) {
      return errorResult("Organization context not available");
    }

    const existing = await KnowledgeBaseModel.findById(args.id);
    if (!existing || existing.organizationId !== context.organizationId) {
      return errorResult(`Knowledge base not found: ${args.id}`);
    }
    await KnowledgeBaseModel.delete(args.id);
    return successResult(`Knowledge base deleted: ${args.id}`);
  } catch (error) {
    return catchError(error, "deleting knowledge base");
  }
}

async function handleCreateKnowledgeConnector(params: {
  args: ConnectorCreateToolArgs;
  context: ArchestraContext;
}) {
  const { args, context } = params;

  try {
    if (!context.organizationId) {
      return errorResult("Organization context not available");
    }

    const teamIds = args.team_ids ?? [];
    const visibility = args.visibility ?? "org-wide";
    if (isTeamScopedWithoutTeams({ visibility, teamIds })) {
      return errorResult(
        "At least one team must be selected for team-scoped connectors",
      );
    }

    const connector = await KnowledgeBaseConnectorModel.create(
      InsertKnowledgeBaseConnectorSchema.parse({
        organizationId: context.organizationId,
        name: args.name,
        connectorType: args.connector_type,
        config: { type: args.connector_type, ...args.config },
        description: args.description ?? null,
        visibility: args.visibility,
        teamIds: args.team_ids,
      }),
    );
    return structuredSuccessResult(
      { knowledgeConnector: connector },
      `Knowledge connector created successfully.\n\n${JSON.stringify(connector, null, 2)}`,
    );
  } catch (error) {
    return catchError(error, "creating knowledge connector");
  }
}

async function handleGetKnowledgeConnectors(params: {
  context: ArchestraContext;
}) {
  const { context } = params;

  try {
    if (!context.organizationId) {
      return errorResult("Organization context not available");
    }

    const access = context.userId
      ? await knowledgeSourceAccessControlService.buildAccessControlContext({
          userId: context.userId,
          organizationId: context.organizationId,
        })
      : null;

    const connectors = await KnowledgeBaseConnectorModel.findByOrganization({
      organizationId: context.organizationId,
      canReadAll: access?.canReadAll,
      viewerTeamIds: access?.teamIds,
    });
    if (connectors.length === 0) {
      return structuredSuccessResult(
        { knowledgeConnectors: [] },
        "No knowledge connectors found.",
      );
    }
    return structuredSuccessResult(
      { knowledgeConnectors: connectors },
      JSON.stringify(connectors, null, 2),
    );
  } catch (error) {
    return catchError(error, "listing knowledge connectors");
  }
}

async function handleGetKnowledgeConnector(params: {
  args: GetKnowledgeConnectorToolArgs;
  context: ArchestraContext;
}) {
  const { args, context } = params;

  try {
    if (!context.organizationId) {
      return errorResult("Organization context not available");
    }

    const [connector, access] = await Promise.all([
      KnowledgeBaseConnectorModel.findById(args.id),
      context.userId
        ? knowledgeSourceAccessControlService.buildAccessControlContext({
            userId: context.userId,
            organizationId: context.organizationId,
          })
        : null,
    ]);
    if (
      !connector ||
      connector.organizationId !== context.organizationId ||
      (access &&
        !knowledgeSourceAccessControlService.canAccessConnector(
          access,
          connector,
        ))
    ) {
      return errorResult(`Knowledge connector not found: ${args.id}`);
    }
    return structuredSuccessResult(
      { knowledgeConnector: connector },
      JSON.stringify(connector, null, 2),
    );
  } catch (error) {
    return catchError(error, "getting knowledge connector");
  }
}

async function handleUpdateKnowledgeConnector(params: {
  args: ConnectorUpdateToolArgs;
  context: ArchestraContext;
}) {
  const { args, context } = params;

  try {
    if (!context.organizationId) {
      return errorResult("Organization context not available");
    }

    const rawUpdates: Record<string, unknown> = {};
    if (args.name !== undefined) rawUpdates.name = args.name;
    if (args.description !== undefined)
      rawUpdates.description = args.description;
    if (args.enabled !== undefined) rawUpdates.enabled = args.enabled;
    if (args.visibility !== undefined) rawUpdates.visibility = args.visibility;
    if (args.team_ids !== undefined) rawUpdates.teamIds = args.team_ids;
    if (args.config !== undefined) rawUpdates.config = args.config;
    if (Object.keys(rawUpdates).length === 0) {
      return errorResult("At least one field to update is required");
    }

    const updates =
      UpdateKnowledgeBaseConnectorSchema.partial().parse(rawUpdates);
    const [existingConnector, access] = await Promise.all([
      KnowledgeBaseConnectorModel.findById(args.id),
      context.userId
        ? knowledgeSourceAccessControlService.buildAccessControlContext({
            userId: context.userId,
            organizationId: context.organizationId,
          })
        : null,
    ]);
    if (
      !existingConnector ||
      existingConnector.organizationId !== context.organizationId ||
      (access &&
        !knowledgeSourceAccessControlService.canAccessConnector(
          access,
          existingConnector,
        ))
    ) {
      return errorResult(`Knowledge connector not found: ${args.id}`);
    }
    const nextVisibility = updates.visibility ?? existingConnector.visibility;
    const nextTeamIds = updates.teamIds ?? existingConnector.teamIds;
    if (
      isTeamScopedWithoutTeams({
        visibility: nextVisibility,
        teamIds: nextTeamIds,
      })
    ) {
      return errorResult(
        "At least one team must be selected for team-scoped connectors",
      );
    }
    const connector = await KnowledgeBaseConnectorModel.update(
      args.id,
      updates,
    );
    if (!connector) {
      return errorResult(`Knowledge connector not found: ${args.id}`);
    }
    if (
      didKnowledgeSourceAclInputsChange({
        current: existingConnector,
        updates: {
          visibility: updates.visibility,
          teamIds: updates.teamIds,
        },
      })
    ) {
      // This rewrites ACLs across every document and chunk for the connector,
      // so only run it when the connector's actual ACL inputs changed.
      await knowledgeSourceAccessControlService.refreshConnectorDocumentAccessControlLists(
        args.id,
      );
    }
    return structuredSuccessResult(
      { knowledgeConnector: connector },
      `Knowledge connector updated successfully.\n\n${JSON.stringify(connector, null, 2)}`,
    );
  } catch (error) {
    return catchError(error, "updating knowledge connector");
  }
}

async function handleDeleteKnowledgeConnector(params: {
  args: DeleteKnowledgeConnectorToolArgs;
  context: ArchestraContext;
}) {
  const { args, context } = params;

  try {
    if (!context.organizationId) {
      return errorResult("Organization context not available");
    }

    const [existing, access] = await Promise.all([
      KnowledgeBaseConnectorModel.findById(args.id),
      context.userId
        ? knowledgeSourceAccessControlService.buildAccessControlContext({
            userId: context.userId,
            organizationId: context.organizationId,
          })
        : null,
    ]);
    if (
      !existing ||
      existing.organizationId !== context.organizationId ||
      (access &&
        !knowledgeSourceAccessControlService.canAccessConnector(
          access,
          existing,
        ))
    ) {
      return errorResult(`Knowledge connector not found: ${args.id}`);
    }
    await KnowledgeBaseConnectorModel.delete(args.id);
    return successResult(`Knowledge connector deleted: ${args.id}`);
  } catch (error) {
    return catchError(error, "deleting knowledge connector");
  }
}

async function handleAssignKnowledgeConnectorToKnowledgeBase(params: {
  args: ConnectorKnowledgeBaseAssignmentArgs;
  context: ArchestraContext;
}) {
  const { args } = params;

  try {
    await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
      args.connector_id,
      args.knowledge_base_id,
    );
    return successResult(
      `Knowledge connector ${args.connector_id} assigned to knowledge base ${args.knowledge_base_id}`,
    );
  } catch (error) {
    return catchError(error, "assigning knowledge connector to knowledge base");
  }
}

async function handleUnassignKnowledgeConnectorFromKnowledgeBase(params: {
  args: ConnectorKnowledgeBaseAssignmentArgs;
  context: ArchestraContext;
}) {
  const { args } = params;

  try {
    const kbIds = await KnowledgeBaseConnectorModel.getKnowledgeBaseIds(
      args.connector_id,
    );
    if (!kbIds.includes(args.knowledge_base_id)) {
      return errorResult(
        `Knowledge connector ${args.connector_id} is not assigned to knowledge base ${args.knowledge_base_id}`,
      );
    }
    await KnowledgeBaseConnectorModel.unassignFromKnowledgeBase(
      args.connector_id,
      args.knowledge_base_id,
    );
    return successResult(
      `Knowledge connector ${args.connector_id} unassigned from knowledge base ${args.knowledge_base_id}`,
    );
  } catch (error) {
    return catchError(
      error,
      "unassigning knowledge connector from knowledge base",
    );
  }
}

async function handleAssignKnowledgeBaseToAgent(params: {
  args: KnowledgeBaseAgentAssignmentArgs;
  context: ArchestraContext;
}) {
  const { args } = params;

  try {
    await AgentKnowledgeBaseModel.assign(args.agent_id, args.knowledge_base_id);
    return successResult(
      `Knowledge base ${args.knowledge_base_id} assigned to agent ${args.agent_id}`,
    );
  } catch (error) {
    return catchError(error, "assigning knowledge base to agent");
  }
}

async function handleUnassignKnowledgeBaseFromAgent(params: {
  args: KnowledgeBaseAgentAssignmentArgs;
  context: ArchestraContext;
}) {
  const { args } = params;

  try {
    const kbIds = await AgentKnowledgeBaseModel.getKnowledgeBaseIds(
      args.agent_id,
    );
    if (!kbIds.includes(args.knowledge_base_id)) {
      return errorResult(
        `Knowledge base ${args.knowledge_base_id} is not assigned to agent ${args.agent_id}`,
      );
    }
    await AgentKnowledgeBaseModel.unassign(
      args.agent_id,
      args.knowledge_base_id,
    );
    return successResult(
      `Knowledge base ${args.knowledge_base_id} unassigned from agent ${args.agent_id}`,
    );
  } catch (error) {
    return catchError(error, "unassigning knowledge base from agent");
  }
}

async function handleAssignKnowledgeConnectorToAgent(params: {
  args: ConnectorAgentAssignmentArgs;
  context: ArchestraContext;
}) {
  const { args } = params;

  try {
    await AgentConnectorAssignmentModel.assign(
      args.agent_id,
      args.connector_id,
    );
    return successResult(
      `Knowledge connector ${args.connector_id} assigned to agent ${args.agent_id}`,
    );
  } catch (error) {
    return catchError(error, "assigning knowledge connector to agent");
  }
}

async function handleUnassignKnowledgeConnectorFromAgent(params: {
  args: ConnectorAgentAssignmentArgs;
  context: ArchestraContext;
}) {
  const { args } = params;

  try {
    const connectorIds = await AgentConnectorAssignmentModel.getConnectorIds(
      args.agent_id,
    );
    if (!connectorIds.includes(args.connector_id)) {
      return errorResult(
        `Knowledge connector ${args.connector_id} is not assigned to agent ${args.agent_id}`,
      );
    }
    await AgentConnectorAssignmentModel.unassign(
      args.agent_id,
      args.connector_id,
    );
    return successResult(
      `Knowledge connector ${args.connector_id} unassigned from agent ${args.agent_id}`,
    );
  } catch (error) {
    return catchError(error, "unassigning knowledge connector from agent");
  }
}
