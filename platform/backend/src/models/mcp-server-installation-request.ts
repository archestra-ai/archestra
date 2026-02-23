import { randomUUID } from "node:crypto";
import type { archestraCatalogTypes } from "@shared";
import { archestraCatalogSdk } from "@shared";
import { and, desc, eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
import type {
  InsertMcpServerInstallationRequest,
  LocalConfig,
  McpServerInstallationRequest,
  McpServerInstallationRequestStatus,
  UpdateMcpServerInstallationRequest,
} from "@/types";
import InternalMcpCatalogModel from "./internal-mcp-catalog";

/**
 * Rewrite OAuth redirect URIs to use the platform's callback URL
 */
function rewriteOAuthRedirectUris(
  oauthConfig?: archestraCatalogTypes.ArchestraMcpServerManifest["oauth_config"],
):
  | archestraCatalogTypes.ArchestraMcpServerManifest["oauth_config"]
  | undefined {
  if (!oauthConfig || oauthConfig.requires_proxy) {
    return oauthConfig;
  }

  return {
    ...oauthConfig,
    redirect_uris: oauthConfig.redirect_uris?.map((uri) =>
      uri === "http://localhost:8080/oauth/callback"
        ? `${config.frontendBaseUrl}/oauth-callback`
        : uri,
    ),
  };
}

function transformExternalServerToCatalogItem(
  externalServer: archestraCatalogTypes.ArchestraMcpServerManifest,
): {
  serverType: "local" | "remote";
  serverUrl?: string;
  docsUrl?: string;
  localConfig?: LocalConfig;
} {
  const server = externalServer.server;
  if (server.type === "remote") {
    return {
      serverType: "remote",
      serverUrl: server.url,
      docsUrl: server.docs_url ?? undefined,
    };
  } else {
    // local server
    const localConfig: LocalConfig = {};
    // Use archestra_config.client_config_permutations if available for better defaults
    const archestraConfig = externalServer.archestra_config;
    let preferredCommand = server.command;
    let preferredArgs = server.args;
    let preferredEnv = server.env;
    let preferredDockerImage = server.docker_image;
    let preferredServiceAccount = server.service_account;

    if (archestraConfig?.client_config_permutations) {
      const permutations = archestraConfig.client_config_permutations;
      // Pick the first permutation (usually the recommended one for Archestra)
      const firstKey = Object.keys(permutations)[0];
      if (firstKey) {
        const perm = permutations[firstKey];
        if (perm) {
          preferredCommand = perm.command ?? preferredCommand;
          preferredArgs = perm.args ?? preferredArgs;
          preferredEnv = { ...preferredEnv, ...perm.env };
          preferredDockerImage = perm.docker_image ?? preferredDockerImage;
        }
      }
    }

    if (preferredCommand) {
      localConfig.command = preferredCommand;
    }
    if (preferredArgs && preferredArgs.length > 0) {
      localConfig.arguments = preferredArgs;
    }
    if (preferredEnv && Object.keys(preferredEnv).length > 0) {
      localConfig.environment = Object.entries(preferredEnv).map(([key, value]) => ({
        key,
        type: "plain_text" as const,
        value: value,
        promptOnInstallation: true,
        required: false,
        description: "",
      }));
    }
    if (preferredDockerImage) {
      localConfig.dockerImage = preferredDockerImage;
    }
    if (preferredServiceAccount) {
      localConfig.serviceAccount = preferredServiceAccount;
    }
    // Determine transport type based on args or oauth config
    const oauthConfig = externalServer.oauth_config;
    if (oauthConfig?.streamable_http_port) {
      localConfig.transportType = "streamable-http";
      localConfig.httpPort = oauthConfig.streamable_http_port;
    } else if (server.args?.some(arg => arg.includes("streamable-http"))) {
      localConfig.transportType = "streamable-http";
      localConfig.httpPort = 8000; // default
    }
    return {
      serverType: "local",
      localConfig,
    };
  }
}

class McpServerInstallationRequestModel {
  static async create(
    requestedBy: string,
    request: Omit<InsertMcpServerInstallationRequest, "requestedBy">,
  ): Promise<McpServerInstallationRequest> {
    const [createdRequest] = await db
      .insert(schema.mcpServerInstallationRequestsTable)
      .values({ ...request, requestedBy })
      .returning();

    return createdRequest;
  }

  static async findAll(): Promise<McpServerInstallationRequest[]> {
    return await db
      .select()
      .from(schema.mcpServerInstallationRequestsTable)
      .orderBy(desc(schema.mcpServerInstallationRequestsTable.createdAt));
  }

  static async findById(
    id: string,
  ): Promise<McpServerInstallationRequest | null> {
    const [request] = await db
      .select()
      .from(schema.mcpServerInstallationRequestsTable)
      .where(eq(schema.mcpServerInstallationRequestsTable.id, id));

    return request || null;
  }

  static async findByStatus(
    status: McpServerInstallationRequestStatus,
  ): Promise<McpServerInstallationRequest[]> {
    return await db
      .select()
      .from(schema.mcpServerInstallationRequestsTable)
      .where(eq(schema.mcpServerInstallationRequestsTable.status, status))
      .orderBy(desc(schema.mcpServerInstallationRequestsTable.createdAt));
  }

  static async findByRequestedBy(
    userId: string,
  ): Promise<McpServerInstallationRequest[]> {
    return await db
      .select()
      .from(schema.mcpServerInstallationRequestsTable)
      .where(eq(schema.mcpServerInstallationRequestsTable.requestedBy, userId))
      .orderBy(desc(schema.mcpServerInstallationRequestsTable.createdAt));
  }

  static async findByExternalCatalogId(
    externalCatalogId: string,
  ): Promise<McpServerInstallationRequest[]> {
    return await db
      .select()
      .from(schema.mcpServerInstallationRequestsTable)
      .where(
        eq(
          schema.mcpServerInstallationRequestsTable.externalCatalogId,
          externalCatalogId,
        ),
      )
      .orderBy(desc(schema.mcpServerInstallationRequestsTable.createdAt));
  }

  static async findPendingByExternalCatalogId(
    externalCatalogId: string,
  ): Promise<McpServerInstallationRequest | null> {
    const [request] = await db
      .select()
      .from(schema.mcpServerInstallationRequestsTable)
      .where(
        and(
          eq(
            schema.mcpServerInstallationRequestsTable.externalCatalogId,
            externalCatalogId,
          ),
          eq(schema.mcpServerInstallationRequestsTable.status, "pending"),
        ),
      )
      .orderBy(desc(schema.mcpServerInstallationRequestsTable.createdAt))
      .limit(1);

    return request || null;
  }

  static async update(
    id: string,
    request: Partial<UpdateMcpServerInstallationRequest>,
  ): Promise<McpServerInstallationRequest | null> {
    const [updatedRequest] = await db
      .update(schema.mcpServerInstallationRequestsTable)
      .set(request)
      .where(eq(schema.mcpServerInstallationRequestsTable.id, id))
      .returning();

    return updatedRequest || null;
  }

  static async approve(
    id: string,
    reviewedBy: string,
    adminResponse?: string,
  ): Promise<McpServerInstallationRequest | null> {
    // First, get the current request to check status and get data
    const currentRequest = await McpServerInstallationRequestModel.findById(id);
    if (!currentRequest) {
      return null;
    }

    // Short-circuit if already approved
    if (currentRequest.status === "approved") {
      return currentRequest;
    }

    // Create internal catalog item based on request type
    try {
      if (currentRequest.externalCatalogId) {
        const externalServerResponse = await archestraCatalogSdk.getMcpServer({
          path: { name: currentRequest.externalCatalogId },
        });

        if (externalServerResponse.data) {
          const externalServer = externalServerResponse.data;

          // Transform external server to catalog item
          const { serverType, serverUrl, docsUrl, localConfig } =
            transformExternalServerToCatalogItem(externalServer);
          // Create internal catalog item from external server data
          await InternalMcpCatalogModel.create({
            name: externalServer.display_name || externalServer.name,
            version: undefined,
            instructions: externalServer.instructions,
            serverType,
            serverUrl,
            docsUrl,
            localConfig,
            userConfig: externalServer.user_config,
            oauthConfig: rewriteOAuthRedirectUris(externalServer.oauth_config),
          });
        }
      } else if (currentRequest.customServerConfig) {
        // Custom server request - use provided config
        const customConfig = currentRequest.customServerConfig;

        if (customConfig.type === "remote") {
          await InternalMcpCatalogModel.create({
            name: customConfig.name,
            version: customConfig.version,
            serverType: "remote",
            serverUrl: customConfig.serverUrl,
            docsUrl: customConfig.docsUrl,
            userConfig: customConfig.userConfig,
            oauthConfig: rewriteOAuthRedirectUris(customConfig.oauthConfig),
          });
        } else if (customConfig.type === "local") {
          await InternalMcpCatalogModel.create({
            name: customConfig.name,
            version: customConfig.version,
            serverType: "local",
            localConfig: customConfig.localConfig,
          });
        }
      }
    } catch (error) {
      // Log the error but still approve the request - admin can handle catalog creation manually
      logger.error(
        { err: error },
        "Failed to create catalog item during approval:",
      );
    }

    // Update the request status
    const [updatedRequest] = await db
      .update(schema.mcpServerInstallationRequestsTable)
      .set({
        status: "approved",
        reviewedBy,
        reviewedAt: new Date(),
        adminResponse,
      })
      .where(eq(schema.mcpServerInstallationRequestsTable.id, id))
      .returning();

    return updatedRequest || null;
  }

  static async decline(
    id: string,
    reviewedBy: string,
    adminResponse?: string,
  ): Promise<McpServerInstallationRequest | null> {
    const [updatedRequest] = await db
      .update(schema.mcpServerInstallationRequestsTable)
      .set({
        status: "declined",
        reviewedBy,
        reviewedAt: new Date(),
        adminResponse,
      })
      .where(eq(schema.mcpServerInstallationRequestsTable.id, id))
      .returning();

    return updatedRequest || null;
  }

  static async addNote(
    id: string,
    userId: string,
    userName: string,
    content: string,
  ): Promise<McpServerInstallationRequest | null> {
    // First, get the current request
    const currentRequest = await McpServerInstallationRequestModel.findById(id);
    if (!currentRequest) {
      return null;
    }

    // Create the new note
    const newNote = {
      id: randomUUID(),
      userId,
      userName,
      content,
      createdAt: new Date().toISOString(),
    };

    // Append to existing notes
    const updatedNotes = [...(currentRequest.notes || []), newNote];

    // Update the request with the new notes array
    return McpServerInstallationRequestModel.update(id, {
      notes: updatedNotes,
    });
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.mcpServerInstallationRequestsTable)
      .where(eq(schema.mcpServerInstallationRequestsTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default McpServerInstallationRequestModel;
