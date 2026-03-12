import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import {
  getAgentTypePermissionChecker,
  requireAgentModifyPermission,
} from "@/auth/agent-type-permissions";
import config from "@/config";
import logger from "@/logging";
import { AgentModel, TeamModel } from "@/models";
import type { Agent } from "@/types";
import {
  assignMcpServerTools,
  assignSubAgentDelegations,
  deduplicateLabels,
  formatAssignmentSummary,
} from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

const TOOL_CREATE_AGENT_NAME = "create_agent";
const TOOL_CREATE_LLM_PROXY_NAME = "create_llm_proxy";
const TOOL_CREATE_MCP_GATEWAY_NAME = "create_mcp_gateway";
const TOOL_GET_AGENT_NAME = "get_agent";
const TOOL_GET_LLM_PROXY_NAME = "get_llm_proxy";
const TOOL_GET_MCP_GATEWAY_NAME = "get_mcp_gateway";
const TOOL_LIST_AGENTS_NAME = "list_agents";
const TOOL_EDIT_AGENT_NAME = "edit_agent";

const TOOL_CREATE_AGENT_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_AGENT_NAME}`;
const TOOL_CREATE_LLM_PROXY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_LLM_PROXY_NAME}`;
const TOOL_CREATE_MCP_GATEWAY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_MCP_GATEWAY_NAME}`;
const TOOL_GET_AGENT_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_AGENT_NAME}`;
const TOOL_GET_LLM_PROXY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_LLM_PROXY_NAME}`;
const TOOL_GET_MCP_GATEWAY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_MCP_GATEWAY_NAME}`;
const TOOL_LIST_AGENTS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_LIST_AGENTS_NAME}`;
const TOOL_EDIT_AGENT_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_EDIT_AGENT_NAME}`;

export const toolShortNames = [
  "create_agent",
  "create_llm_proxy",
  "create_mcp_gateway",
  "get_agent",
  "get_llm_proxy",
  "get_mcp_gateway",
  "list_agents",
  "edit_agent",
] as const;

// === Exports ===

export const tools: Tool[] = [
  {
    name: TOOL_CREATE_AGENT_FULL_NAME,
    title: "Create Agent",
    description:
      "Create a new agent with the specified name, optional description, labels, prompts, icon emoji, MCP server tool assignments, and sub-agent delegations. Defaults to personal scope. IMPORTANT: When the user mentions MCP servers or sub-agents by name, you MUST first look up their IDs using get_mcp_servers / list_agents / get_agent, then pass the IDs via mcpServerIds / subAgentIds.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the agent (required)",
        },
        scope: {
          type: "string",
          enum: ["team", "personal", "org"],
          description:
            "The scope of the agent: 'team' for team-scoped, 'personal' for personal, or 'org' for organization-wide (optional, defaults to 'personal')",
        },
        labels: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "The label key" },
              value: {
                type: "string",
                description: "The value for the label",
              },
            },
            required: ["key", "value"],
          },
          description: "Array of labels to assign to the agent (optional)",
        },
        systemPrompt: {
          type: "string",
          description: "System prompt for the agent (optional)",
        },
        userPrompt: {
          type: "string",
          description: "User prompt for the agent (optional)",
        },
        description: {
          type: "string",
          description:
            "A brief description of what this agent does. Helps other agents understand if this agent is relevant for their task (optional)",
        },
        icon: {
          type: "string",
          description: "An emoji character to use as the agent icon (optional)",
        },
        mcpServerIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of MCP server IDs whose tools should be assigned to the agent. Use get_mcp_servers to look up IDs by name. When the user mentions MCP servers by name, always look up their IDs and pass them here.",
        },
        subAgentIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of agent IDs to assign as sub-agents (delegations) to the agent. Use list_agents or get_agent to look up IDs by name. When the user mentions sub-agents by name, always look up their IDs and pass them here.",
        },
      },
      required: ["name"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_CREATE_LLM_PROXY_FULL_NAME,
    title: "Create LLM Proxy",
    description:
      "Create a new LLM proxy with the specified name and optional labels.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the LLM proxy (required)",
        },
        scope: {
          type: "string",
          enum: ["team", "personal", "org"],
          description:
            "The scope of the LLM proxy: 'team' for team-scoped, 'personal' for personal, or 'org' for organization-wide (optional, defaults based on teams)",
        },
        labels: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "The label key" },
              value: {
                type: "string",
                description: "The value for the label",
              },
            },
            required: ["key", "value"],
          },
          description: "Array of labels to assign to the LLM proxy (optional)",
        },
      },
      required: ["name"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_CREATE_MCP_GATEWAY_FULL_NAME,
    title: "Create MCP Gateway",
    description:
      "Create a new MCP gateway with the specified name and optional labels.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the MCP gateway (required)",
        },
        scope: {
          type: "string",
          enum: ["team", "personal", "org"],
          description:
            "The scope of the MCP gateway: 'team' for team-scoped, 'personal' for personal, or 'org' for organization-wide (optional, defaults based on teams)",
        },
        labels: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "The label key" },
              value: {
                type: "string",
                description: "The value for the label",
              },
            },
            required: ["key", "value"],
          },
          description:
            "Array of labels to assign to the MCP gateway (optional)",
        },
      },
      required: ["name"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_GET_AGENT_FULL_NAME,
    title: "Get Agent",
    description:
      "Get a specific agent by ID or name. When searching by name, only your personal agents are matched.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the agent to retrieve",
        },
        name: {
          type: "string",
          description:
            "Search by name (partial match). Only returns your personal agents.",
        },
      },
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_GET_LLM_PROXY_FULL_NAME,
    title: "Get LLM Proxy",
    description:
      "Get a specific LLM proxy by ID or name. When searching by name, only your personal proxies are matched.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the LLM proxy to retrieve",
        },
        name: {
          type: "string",
          description:
            "Search by name (partial match). Only returns your personal proxies.",
        },
      },
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_GET_MCP_GATEWAY_FULL_NAME,
    title: "Get MCP Gateway",
    description:
      "Get a specific MCP gateway by ID or name. When searching by name, only your personal gateways are matched.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the MCP gateway to retrieve",
        },
        name: {
          type: "string",
          description:
            "Search by name (partial match). Only returns your personal gateways.",
        },
      },
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_LIST_AGENTS_FULL_NAME,
    title: "List Agents",
    description: "List agents with optional filtering by name and scope.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Filter by name (partial match, optional)",
        },
        scope: {
          type: "string",
          enum: ["personal", "team", "org"],
          description: "Filter by scope (optional)",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of agents to return (optional, default 20, max 100)",
        },
      },
      required: [],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_EDIT_AGENT_FULL_NAME,
    title: "Edit Agent",
    description:
      "Edit an existing agent. All fields are optional except id. Only provided fields are updated. MCP server and sub-agent assignments are additive. Respects the calling user's access level. IMPORTANT: When the user mentions MCP servers or sub-agents by name, you MUST first look up their IDs using get_mcp_servers / list_agents / get_agent, then pass the IDs via mcpServerIds / subAgentIds.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "The ID of the agent to edit (required). Use list_agents or get_agent to look up by name.",
        },
        name: {
          type: "string",
          description: "New name for the agent",
        },
        description: {
          type: "string",
          description: "New description for the agent",
        },
        systemPrompt: {
          type: "string",
          description: "New system prompt for the agent",
        },
        userPrompt: {
          type: "string",
          description: "New user prompt for the agent",
        },
        icon: {
          type: "string",
          description: "An emoji character to use as the agent icon",
        },
        scope: {
          type: "string",
          enum: ["team", "personal", "org"],
          description: "New scope for the agent",
        },
        teams: {
          type: "array",
          items: { type: "string" },
          description: "Array of team IDs to assign (replaces existing teams)",
        },
        labels: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "The label key" },
              value: {
                type: "string",
                description: "The value for the label",
              },
            },
            required: ["key", "value"],
          },
          description:
            "Array of labels to set on the agent (replaces existing labels)",
        },
        mcpServerIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of MCP server IDs whose tools should be assigned to the agent (additive). Use get_mcp_servers to look up IDs by name.",
        },
        subAgentIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of agent IDs to assign as sub-agents (additive). Use list_agents or get_agent to look up IDs by name.",
        },
      },
      required: ["id"],
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
        return {
          content: [
            {
              type: "text",
              text: `Error: ${toolLabel} name is required and cannot be empty.`,
            },
          ],
          isError: true,
        };
      }

      // Build create params - only agents get prompt fields
      const scope =
        (args?.scope as "team" | "personal" | "org") ??
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
        const userPrompt = args?.userPrompt as string | undefined;
        const description = args?.description as string | undefined;
        const icon = args?.icon as string | undefined;
        if (systemPrompt) createParams.systemPrompt = systemPrompt;
        if (userPrompt) createParams.userPrompt = userPrompt;
        if (description) createParams.description = description;
        if (icon) createParams.icon = icon;
      }

      const created = await AgentModel.create(
        createParams,
        scope === "personal" ? context.userId : undefined,
      );

      // Assign MCP server tools and sub-agents (agent-only)
      const mcpServerIds = (args?.mcpServerIds as string[]) ?? [];
      const subAgentIds = (args?.subAgentIds as string[]) ?? [];
      const mcpServerResults =
        targetAgentType === "agent" && mcpServerIds.length > 0
          ? await assignMcpServerTools(created.id, mcpServerIds)
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
      formatAssignmentSummary(lines, mcpServerResults, subAgentResults);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, `Error creating ${toolLabel}`);
      return {
        content: [
          {
            type: "text",
            text: `Error creating ${toolLabel}: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
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
        return {
          content: [
            {
              type: "text",
              text: "Error: either id or name parameter is required",
            },
          ],
          isError: true,
        };
      }

      let record: Agent | null | undefined;

      if (id) {
        record = await AgentModel.findById(id);
      } else if (name) {
        // Search by name, only matching personal agents owned by the current user
        const results = await AgentModel.findAllPaginated(
          { limit: 1, offset: 0 },
          undefined,
          {
            name,
            agentType: expectedType,
            scope: "personal",
            authorIds: context.userId ? [context.userId] : [],
          },
          context.userId,
          true,
        );

        if (results.data.length > 0) {
          record = results.data[0];
        }
      }

      if (!record) {
        return {
          content: [
            {
              type: "text",
              text: `${getLabel} not found`,
            },
          ],
          isError: true,
        };
      }

      if (record.agentType !== expectedType) {
        return {
          content: [
            {
              type: "text",
              text: `Error: The requested entity is a ${record.agentType}, not a ${expectedType}.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(record, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, `Error getting ${getLabel}`);
      return {
        content: [
          {
            type: "text",
            text: `Error getting ${getLabel}: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_LIST_AGENTS_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, listArgs: args },
      "list_agents tool called",
    );

    try {
      const name = args?.name as string | undefined;
      const scope = args?.scope as "personal" | "team" | "org" | undefined;
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

      const agents = results.data.map((a) => ({
        id: a.id,
        name: a.name,
        scope: a.scope,
        description: a.description,
        teams: a.teams.map((t) => ({ id: t.id, name: t.name })),
        labels: a.labels.map((l) => ({ key: l.key, value: l.value })),
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { total: results.pagination.total, agents },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error listing agents");
      return {
        content: [
          {
            type: "text",
            text: `Error listing agents: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
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
        return {
          content: [{ type: "text", text: "Error: agent id is required." }],
          isError: true,
        };
      }

      if (!context.userId || !organizationId) {
        return {
          content: [
            {
              type: "text",
              text: "Error: user/organization context not available.",
            },
          ],
          isError: true,
        };
      }

      // Fetch existing agent
      const existingAgent = await AgentModel.findById(id);
      if (!existingAgent) {
        return {
          content: [{ type: "text", text: "Error: agent not found." }],
          isError: true,
        };
      }

      if (existingAgent.agentType !== "agent") {
        return {
          content: [
            {
              type: "text",
              text: `Error: this tool only edits agents, not ${existingAgent.agentType}.`,
            },
          ],
          isError: true,
        };
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
      if (args?.userPrompt !== undefined)
        updateData.userPrompt = args.userPrompt;
      if (args?.icon !== undefined) updateData.icon = args.icon;
      if (args?.scope !== undefined) updateData.scope = args.scope;
      if (args?.teams !== undefined) updateData.teams = args.teams;

      if (args?.labels !== undefined) {
        updateData.labels = deduplicateLabels(
          args.labels as Array<{ key: string; value: string }>,
        );
      }

      // Update agent
      const updated = await AgentModel.update(
        id,
        updateData as Parameters<typeof AgentModel.update>[1],
      );

      if (!updated) {
        return {
          content: [{ type: "text", text: "Error: failed to update agent." }],
          isError: true,
        };
      }

      // Assign MCP server tools and sub-agents (additive)
      const mcpServerIds = (args?.mcpServerIds as string[]) ?? [];
      const subAgentIds = (args?.subAgentIds as string[]) ?? [];
      const mcpServerResults =
        mcpServerIds.length > 0
          ? await assignMcpServerTools(id, mcpServerIds)
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
      formatAssignmentSummary(lines, mcpServerResults, subAgentResults);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ err: error }, "Error editing agent");
      return {
        content: [{ type: "text", text: `Error editing agent: ${message}` }],
        isError: true,
      };
    }
  }

  return null;
}
