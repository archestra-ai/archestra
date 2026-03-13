import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME } from "@shared";
import { buildUserAcl, queryService } from "@/knowledge-base";
import logger from "@/logging";
import {
  AgentConnectorAssignmentModel,
  AgentModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  TeamModel,
  UserModel,
} from "@/models";
import type { AclEntry } from "@/types/kb-document";
import type { ArchestraContext } from "./types";

// === Constants ===

export const toolShortNames = ["query_knowledge_sources"] as const;

// === Exports ===

export const tools: Tool[] = [
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
];

export async function handleTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  context: ArchestraContext,
): Promise<CallToolResult | null> {
  if (toolName !== TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME) {
    return null;
  }

  const { agent: contextAgent, organizationId } = context;

  logger.info(
    { agentId: contextAgent.id, queryArgs: args },
    "query_knowledge_sources tool called",
  );

  try {
    const query = args?.query as string | undefined;
    if (!query) {
      return {
        content: [{ type: "text", text: "Error: query parameter is required" }],
        isError: true,
      };
    }

    const agent = await AgentModel.findById(contextAgent.id);

    const hasKbs = agent?.knowledgeBaseIds?.length;
    const connectorAssignments =
      await AgentConnectorAssignmentModel.findByAgent(contextAgent.id);
    const directConnectorIds = connectorAssignments.map((a) => a.connectorId);

    if (!hasKbs && directConnectorIds.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No knowledge base or connector assigned to this agent. Assign a knowledge base or connector in agent settings to enable knowledge search.",
          },
        ],
        isError: true,
      };
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
      return {
        content: [
          {
            type: "text",
            text: "No connectors found for the assigned knowledge bases or agent. Add connectors to enable knowledge search.",
          },
        ],
        isError: true,
      };
    }

    // Build user ACL from assigned knowledge bases
    const validKbs = hasKbs
      ? (
          await Promise.all(
            agent.knowledgeBaseIds.map((id) => KnowledgeBaseModel.findById(id)),
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

    if (!organizationId) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Organization context not available.",
          },
        ],
        isError: true,
      };
    }

    const results = await queryService.query({
      connectorIds,
      organizationId,
      queryText: query,
      userAcl,
      limit: 10,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results,
            totalChunks: results.length,
          }),
        },
      ],
    };
  } catch (error) {
    logger.error(
      {
        agentId: contextAgent.id,
        error: error instanceof Error ? error.message : String(error),
      },
      "query_knowledge_sources failed",
    );
    return {
      content: [
        {
          type: "text",
          text: `Error querying knowledge base: ${error instanceof Error ? error.message : "Unknown error"}`,
        },
      ],
      isError: true,
    };
  }
}
