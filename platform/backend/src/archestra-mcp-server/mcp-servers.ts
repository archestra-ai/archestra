import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME,
} from "@shared";
import { userHasPermission } from "@/auth/utils";
import logger from "@/logging";
import { InternalMcpCatalogModel, ToolModel } from "@/models";
import type { InternalMcpCatalog } from "@/types";
import type { ArchestraContext } from "./types";

// === Constants ===

const TOOL_SEARCH_PRIVATE_MCP_REGISTRY_NAME = "search_private_mcp_registry";
const TOOL_GET_MCP_SERVERS_NAME = "get_mcp_servers";
const TOOL_GET_MCP_SERVER_TOOLS_NAME = "get_mcp_server_tools";
const TOOL_EDIT_MCP_NAME = "edit_mcp";

const TOOL_SEARCH_PRIVATE_MCP_REGISTRY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_SEARCH_PRIVATE_MCP_REGISTRY_NAME}`;
const TOOL_GET_MCP_SERVERS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_MCP_SERVERS_NAME}`;
const TOOL_GET_MCP_SERVER_TOOLS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_MCP_SERVER_TOOLS_NAME}`;
const TOOL_EDIT_MCP_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_EDIT_MCP_NAME}`;

export const toolShortNames = [
  "search_private_mcp_registry",
  "get_mcp_servers",
  "get_mcp_server_tools",
  "edit_mcp",
  "create_mcp_server_installation_request",
] as const;

// === Exports ===

export const tools: Tool[] = [
  {
    name: TOOL_SEARCH_PRIVATE_MCP_REGISTRY_FULL_NAME,
    title: "Search Private MCP Registry",
    description:
      "Search the private MCP registry for available MCP servers. Optionally provide a search query to filter results by name or description.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Optional search query to filter MCP servers by name or description",
        },
      },
      required: [],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_GET_MCP_SERVERS_FULL_NAME,
    title: "Get MCP Servers",
    description:
      "List all MCP servers from the catalog. Returns catalog item IDs that can be used with mcpServerIds in create_agent/edit_agent.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_GET_MCP_SERVER_TOOLS_FULL_NAME,
    title: "Get MCP Server Tools",
    description:
      "Get all tools available for a specific MCP server by its catalog ID (from get_mcp_servers).",
    inputSchema: {
      type: "object",
      properties: {
        mcpServerId: {
          type: "string",
          description: "The catalog ID of the MCP server",
        },
      },
      required: ["mcpServerId"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_EDIT_MCP_FULL_NAME,
    title: "Edit MCP Server",
    description:
      "Edit an MCP server's name, icon, or description. Only these three fields can be changed — no other configuration is modified. Use get_mcp_servers to look up IDs by name.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "The catalog ID of the MCP server to edit. Use get_mcp_servers to look up by name.",
        },
        name: {
          type: "string",
          description: "New display name for the MCP server",
        },
        icon: {
          type: "string",
          description: "An emoji character to use as the MCP server icon",
        },
        description: {
          type: "string",
          description: "New description for the MCP server",
        },
      },
      required: ["id"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME,
    title: "Create MCP Server Installation Request",
    description:
      "Allows users from within the Archestra Platform chat UI to submit a request for an MCP server to be added to their Archestra Platform's internal MCP server registry. This will open a dialog for the user to submit an installation request. When you trigger this tool, just tell the user to go through the dialog to submit the request. Do not provider any additional information",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
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

  if (toolName === TOOL_SEARCH_PRIVATE_MCP_REGISTRY_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, searchArgs: args },
      "search_private_mcp_registry tool called",
    );

    try {
      const query = args?.query as string | undefined;

      let catalogItems: InternalMcpCatalog[];

      if (query && query.trim() !== "") {
        // Search by name or description - don't expand secrets, we do not need them to execute the tool
        catalogItems = await InternalMcpCatalogModel.searchByQuery(query, {
          expandSecrets: false,
        });
      } else {
        // Return all catalog items - don't expand secrets, we do not need actual secrets for this
        catalogItems = await InternalMcpCatalogModel.findAll({
          expandSecrets: false,
        });
      }

      if (catalogItems.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: query
                ? `No MCP servers found matching query: "${query}"`
                : "No MCP servers found in the private registry.",
            },
          ],
          isError: false,
        };
      }

      // Format the results
      const formattedResults = catalogItems
        .map((item) => {
          let result = `**${item.name}**`;
          if (item.version) result += ` (v${item.version})`;
          if (item.description) result += `\n  ${item.description}`;
          result += `\n  Type: ${item.serverType}`;
          if (item.serverUrl) result += `\n  URL: ${item.serverUrl}`;
          if (item.repository) result += `\n  Repository: ${item.repository}`;
          result += `\n  ID: ${item.id}`;
          return result;
        })
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Found ${catalogItems.length} MCP server(s):\n\n${formattedResults}`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error searching private MCP registry");
      return {
        content: [
          {
            type: "text",
            text: `Error searching private MCP registry: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_MCP_SERVERS_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, filters: args },
      "get_mcp_servers tool called",
    );

    try {
      const catalogItems = await InternalMcpCatalogModel.findAll({
        expandSecrets: false,
      });

      const items = catalogItems.map((c) => ({
        id: c.id,
        name: c.name,
        icon: c.icon,
        description: c.description,
        scope: c.scope,
        teams: c.teams?.map((t) => ({ id: t.id, name: t.name })) ?? [],
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(items, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error getting MCP servers");
      return {
        content: [
          {
            type: "text",
            text: `Error getting MCP servers: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_MCP_SERVER_TOOLS_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, mcpServerId: args?.mcpServerId },
      "get_mcp_server_tools tool called",
    );

    try {
      const mcpServerId = args?.mcpServerId as string;

      if (!mcpServerId) {
        return {
          content: [
            {
              type: "text",
              text: "Error: mcpServerId parameter is required",
            },
          ],
          isError: true,
        };
      }

      const tools = await ToolModel.findByCatalogId(mcpServerId);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(tools, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error getting MCP server tools");
      return {
        content: [
          {
            type: "text",
            text: `Error getting MCP server tools: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_EDIT_MCP_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, editArgs: args },
      "edit_mcp tool called",
    );

    try {
      const id = args?.id as string | undefined;
      if (!id) {
        return {
          content: [
            { type: "text", text: "Error: MCP server catalog id is required." },
          ],
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

      const existing = await InternalMcpCatalogModel.findById(id);
      if (!existing) {
        return {
          content: [{ type: "text", text: "Error: MCP server not found." }],
          isError: true,
        };
      }

      // Check permissions: admins can edit any, non-admins only their own personal items
      const isAdmin = await userHasPermission(
        context.userId,
        organizationId,
        "mcpServerInstallation",
        "admin",
      );

      if (!isAdmin) {
        if (
          existing.scope !== "personal" ||
          existing.authorId !== context.userId
        ) {
          return {
            content: [
              {
                type: "text",
                text: "Error: you can only edit your own personal MCP servers.",
              },
            ],
            isError: true,
          };
        }
      }

      const updateData: Record<string, unknown> = {};
      if (args?.name !== undefined) updateData.name = args.name;
      if (args?.icon !== undefined) updateData.icon = args.icon;
      if (args?.description !== undefined)
        updateData.description = args.description;

      if (Object.keys(updateData).length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No fields to update. Provide name, icon, or description.",
            },
          ],
          isError: true,
        };
      }

      const updated = await InternalMcpCatalogModel.update(
        existing.id,
        updateData as Parameters<typeof InternalMcpCatalogModel.update>[1],
      );

      if (!updated) {
        return {
          content: [
            { type: "text", text: "Error: failed to update MCP server." },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: [
              "Successfully updated MCP server.",
              "",
              `Name: ${updated.name}`,
              `ID: ${updated.id}`,
              `Icon: ${updated.icon || "None"}`,
              `Description: ${updated.description || "None"}`,
            ].join("\n"),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error editing MCP server");
      return {
        content: [
          {
            type: "text",
            text: `Error editing MCP server: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * This tool is quite unique in that the tool handler doesn't actually need to do anything
   * see the useChat() usage in the chat UI for more details
   */
  if (toolName === TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, requestArgs: args },
      "create_mcp_server_installation_request tool called",
    );

    try {
      return {
        content: [
          {
            type: "text",
            // Return a user-friendly message explaining what will happen
            // Note: The frontend will show either the "Add MCP Server to Private Registry" dialog
            // (for users with internalMcpCatalog:create permission) or the installation request dialog
            text: "A dialog for adding or requesting an MCP server should now be visible in the chat. Please review and submit to proceed.",
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error(
        { err: error },
        "Error handling MCP server installation request",
      );
      return {
        content: [
          {
            type: "text",
            text: `Error handling installation request: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  return null;
}
