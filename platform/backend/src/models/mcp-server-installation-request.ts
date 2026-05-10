import { randomUUID } from "node:crypto";
import type { archestraCatalogTypes } from "@shared";
import { archestraCatalogSdk } from "@shared";
import { and, desc, eq } from "drizzle-orm";
import config from "@/config";
import db, { schema, type Transaction } from "@/database";
import { notDeleted } from "@/database/schemas/_soft-delete";
import { hardDelete, softDelete } from "@/database/soft-delete";
import logger from "@/logging";
import type {
  InsertMcpServerInstallationRequest,
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
      .where(notDeleted(schema.mcpServerInstallationRequestsTable))
      .orderBy(desc(schema.mcpServerInstallationRequestsTable.createdAt));
  }

  static async findById(
    id: string,
  ): Promise<McpServerInstallationRequest | null> {
    const [request] = await db
      .select()
      .from(schema.mcpServerInstallationRequestsTable)
      .where(
        and(
          eq(schema.mcpServerInstallationRequestsTable.id, id),
          notDeleted(schema.mcpServerInstallationRequestsTable),
        ),
      );

    return request || null;
  }

  static async findByStatus(
    status: McpServerInstallationRequestStatus,
  ): Promise<McpServerInstallationRequest[]> {
    return await db
      .select()
      .from(schema.mcpServerInstallationRequestsTable)
      .where(
        and(
          eq(schema.mcpServerInstallationRequestsTable.status, status),
          notDeleted(schema.mcpServerInstallationRequestsTable),
        ),
      )
      .orderBy(desc(schema.mcpServerInstallationRequestsTable.createdAt));
  }

  static async findByRequestedBy(
    userId: string,
  ): Promise<McpServerInstallationRequest[]> {
    return await db
      .select()
      .from(schema.mcpServerInstallationRequestsTable)
      .where(
        and(
          eq(schema.mcpServerInstallationRequestsTable.requestedBy, userId),
          notDeleted(schema.mcpServerInstallationRequestsTable),
        ),
      )
      .orderBy(desc(schema.mcpServerInstallationRequestsTable.createdAt));
  }

  static async findByExternalCatalogId(
    externalCatalogId: string,
  ): Promise<McpServerInstallationRequest[]> {
    return await db
      .select()
      .from(schema.mcpServerInstallationRequestsTable)
      .where(
        and(
          eq(
            schema.mcpServerInstallationRequestsTable.externalCatalogId,
            externalCatalogId,
          ),
          notDeleted(schema.mcpServerInstallationRequestsTable),
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
          notDeleted(schema.mcpServerInstallationRequestsTable),
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
      .where(
        and(
          eq(schema.mcpServerInstallationRequestsTable.id, id),
          notDeleted(schema.mcpServerInstallationRequestsTable),
        ),
      )
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

          // Create internal catalog item from external server data
          await InternalMcpCatalogModel.create({
            name: externalServer.display_name || externalServer.name,
            version: undefined,
            instructions: externalServer.instructions,
            serverType: externalServer.server.type,
            serverUrl:
              externalServer.server.type === "remote"
                ? externalServer.server.url
                : undefined,
            docsUrl:
              externalServer.server.type === "remote"
                ? externalServer.server.docs_url
                : undefined,
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
      .where(
        and(
          eq(schema.mcpServerInstallationRequestsTable.id, id),
          notDeleted(schema.mcpServerInstallationRequestsTable),
        ),
      )
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
      .where(
        and(
          eq(schema.mcpServerInstallationRequestsTable.id, id),
          notDeleted(schema.mcpServerInstallationRequestsTable),
        ),
      )
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

  static async delete(id: string, tx?: Transaction): Promise<boolean> {
    const count = await softDelete(
      tx ?? db,
      schema.mcpServerInstallationRequestsTable,
      eq(schema.mcpServerInstallationRequestsTable.id, id),
    );
    return count > 0;
  }

  static async hardDelete(id: string, tx?: Transaction): Promise<boolean> {
    const count = await hardDelete(
      tx ?? db,
      schema.mcpServerInstallationRequestsTable,
      eq(schema.mcpServerInstallationRequestsTable.id, id),
    );
    return count > 0;
  }
}

export default McpServerInstallationRequestModel;
