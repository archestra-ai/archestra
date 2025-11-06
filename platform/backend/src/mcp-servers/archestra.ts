import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ilike, or } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import {
  InternalMcpCatalogModel,
  McpServerInstallationRequestModel,
} from "@/models";
import type { InsertMcpServerInstallationRequest } from "@/types";

/**
 * User context for the Archestra MCP server
 */
export interface ArchestraUserContext {
  userId: string;
  email: string;
  organizationId: string;
}

/**
 * Execute an Archestra MCP tool
 */
export async function executeArchestraTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  userContext: ArchestraUserContext,
): Promise<CallToolResult> {
  const { userId, email, organizationId } = userContext;

  if (toolName === "archestra__whoami") {
    logger.info({ userId, email }, "whoami tool called");

    return {
      content: [
        {
          type: "text",
          text: `Current user email: ${email}\nUser ID: ${userId}\nOrganization ID: ${organizationId}`,
        },
      ],
      isError: false,
    };
  }

  if (toolName === "archestra__search_private_mcp_registry") {
    logger.info(
      { userId, searchArgs: args },
      "search_private_mcp_registry tool called",
    );

    try {
      const query = args?.query as string | undefined;

      let catalogItems;

      if (query && query.trim() !== "") {
        // Search by name or description
        catalogItems = await db
          .select()
          .from(schema.internalMcpCatalogTable)
          .where(
            or(
              ilike(schema.internalMcpCatalogTable.name, `%${query}%`),
              ilike(schema.internalMcpCatalogTable.description, `%${query}%`),
            ),
          );
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

  if (toolName === "archestra__create_mcp_server_installation_request") {
    logger.info(
      { userId, requestArgs: args },
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
          requestedBy: userId,
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
      name: "archestra__whoami",
      title: "Who Am I",
      description:
        "Returns the email address and user information of the currently authenticated user",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: "archestra__search_private_mcp_registry",
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
      name: "archestra__create_mcp_server_installation_request",
      title: "Create MCP Server Installation Request",
      description:
        "Create a request to install an MCP server. Provide either an external_catalog_id for a server from the public catalog, or custom_server_config for a custom server configuration.",
      inputSchema: {
        type: "object",
        properties: {
          external_catalog_id: {
            type: "string",
            description:
              "The ID of the MCP server from the external catalog (optional if custom_server_config is provided)",
          },
          request_reason: {
            type: "string",
            description:
              "Reason for requesting the installation (optional but recommended)",
          },
          custom_server_config: {
            type: "object",
            description:
              "Custom server configuration (optional if external_catalog_id is provided)",
            properties: {
              type: {
                type: "string",
                enum: ["remote", "local"],
                description: "The type of the custom server",
              },
              label: {
                type: "string",
                description: "A label for the custom server",
              },
              name: {
                type: "string",
                description: "The name of the custom server",
              },
              version: {
                type: "string",
                description: "The version of the custom server (optional)",
              },
            },
            required: ["type", "label", "name"],
          },
        },
        required: [],
      },
      annotations: {},
      _meta: {},
    },
  ];
}
