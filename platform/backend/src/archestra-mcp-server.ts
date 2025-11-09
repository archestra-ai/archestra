import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import logger from "@/logging";
import { InternalMcpCatalogModel } from "@/models";
import type { Agent, InternalMcpCatalog } from "@/types";

/**
 * Constants for Archestra MCP server
 */
export const MCP_SERVER_NAME = "archestra";
const TOOL_WHOAMI_NAME = "whoami";
const TOOL_SEARCH_PRIVATE_MCP_REGISTRY_NAME = "search_private_mcp_registry";
const TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_NAME =
  "create_mcp_server_installation_request";

// Construct fully-qualified tool names
const TOOL_WHOAMI_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_WHOAMI_NAME}`;
const TOOL_SEARCH_PRIVATE_MCP_REGISTRY_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_SEARCH_PRIVATE_MCP_REGISTRY_NAME}`;
const _TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_NAME}`;

/**
 * Context for the Archestra MCP server
 */
export interface ArchestraContext {
  agent: Agent;
}

/**
 * Execute an Archestra MCP tool
 */
export async function executeArchestraTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent } = context;

  if (toolName === TOOL_WHOAMI_FULL_NAME) {
    logger.info(
      { agentId: agent.id, agentName: agent.name },
      "whoami tool called",
    );

    return {
      content: [
        {
          type: "text",
          text: `Agent Name: ${agent.name}\nAgent ID: ${agent.id}`,
        },
      ],
      isError: false,
    };
  }

  if (toolName === TOOL_SEARCH_PRIVATE_MCP_REGISTRY_FULL_NAME) {
    logger.info(
      { agentId: agent.id, searchArgs: args },
      "search_private_mcp_registry tool called",
    );

    try {
      const query = args?.query as string | undefined;

      let catalogItems: InternalMcpCatalog[];

      if (query && query.trim() !== "") {
        // Search by name or description
        catalogItems = await InternalMcpCatalogModel.searchByQuery(query);
      } else {
        // Return all catalog items
        catalogItems = await InternalMcpCatalogModel.findAll();
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
            text: `Error searching private MCP registry: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * TODO: Currently there is no user available in the mcp-gateway context. In order to be able to create
   * an MCP server installation request, we'd either need to have an explicit user, create a "fake archestra mcp server" user
   * (probably a bad idea), or modify McpServerInstallationRequestModel such that createdBy is renamed to createdByUser
   * (and can be null) + we add createdByAgent
   */
  /*
  if (toolName === TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME) {
    logger.info(
      { agentId: agent.id, requestArgs: args },
      "create_mcp_server_installation_request tool called",
    );

    try {
      const externalCatalogId = args?.external_catalog_id as string | undefined;
      const requestReason = args?.request_reason as string | undefined;
      const customServerConfig = args?.custom_server_config as
        | InsertMcpServerInstallationRequest["customServerConfig"]
        | undefined;

      // Validate that either externalCatalogId or customServerConfig is provided
      if (!externalCatalogId && !customServerConfig) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Either external_catalog_id or custom_server_config must be provided.",
            },
          ],
          isError: true,
        };
      }

      // Check if there's already a pending request for this external catalog ID
      if (externalCatalogId) {
        const existingRequest =
          await McpServerInstallationRequestModel.findPendingByExternalCatalogId(
            externalCatalogId,
          );
        if (existingRequest) {
          return {
            content: [
              {
                type: "text",
                text: `A pending installation request already exists for this MCP server (Request ID: ${existingRequest.id}). Please wait for it to be reviewed.`,
              },
            ],
            isError: false,
          };
        }
      }

      // Create the installation request
      const installationRequest =
        await McpServerInstallationRequestModel.create({
          externalCatalogId: externalCatalogId || null,
          requestedBy: userId, // This would need to be changed as per TODO above
          requestReason: requestReason || null,
          customServerConfig: customServerConfig || null,
          status: "pending",
        });

      return {
        content: [
          {
            type: "text",
            text: `Successfully created MCP server installation request.\n\nRequest ID: ${installationRequest.id}\nStatus: ${installationRequest.status}\n\nYour request will be reviewed by an administrator.`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error(
        { err: error },
        "Error creating MCP server installation request",
      );
      return {
        content: [
          {
            type: "text",
            text: `Error creating installation request: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }
  */

  // If the tool is not an Archestra tool, throw an error
  throw {
    code: -32601, // Method not found
    message: `Tool '${toolName}' not found`,
  };
}

/**
 * Get the list of Archestra MCP tools
 */
export function getArchestraMcpTools(): Tool[] {
  return [
    {
      name: TOOL_WHOAMI_FULL_NAME,
      title: "Who Am I",
      description: "Returns the name and ID of the current agent",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      annotations: {},
      _meta: {},
    },
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
    // TODO: MCP server installation request tool is temporarily disabled until user context is available
    // {
    //   name: TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME,
    //   title: "Create MCP Server Installation Request",
    //   description:
    //     "Create a request to install an MCP server. Provide either an external_catalog_id for a server from the public catalog, or custom_server_config for a custom server configuration.",
    //   inputSchema: {
    //     type: "object",
    //     properties: {
    //       external_catalog_id: {
    //         type: "string",
    //         description:
    //           "The ID of the MCP server from the external catalog (optional if custom_server_config is provided)",
    //       },
    //       request_reason: {
    //         type: "string",
    //         description:
    //           "Reason for requesting the installation (optional but recommended)",
    //       },
    //       custom_server_config: {
    //         type: "object",
    //         description:
    //           "Custom server configuration (optional if external_catalog_id is provided)",
    //         properties: {
    //           type: {
    //             type: "string",
    //             enum: ["remote", "local"],
    //             description: "The type of the custom server",
    //           },
    //           label: {
    //             type: "string",
    //             description: "A label for the custom server",
    //           },
    //           name: {
    //             type: "string",
    //             description: "The name of the custom server",
    //           },
    //           version: {
    //             type: "string",
    //             description: "The version of the custom server (optional)",
    //           },
    //         },
    //         required: ["type", "label", "name"],
    //       },
    //     },
    //     required: [],
    //   },
    //   annotations: {},
    //   _meta: {},
    // },
  ];
}
