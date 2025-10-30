import { randomUUID } from "node:crypto";
import { archestraCatalogSdk } from "@shared";
import { and, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertMcpServerInstallationRequest,
  McpServerInstallationRequest,
  McpServerInstallationRequestStatus,
  UpdateMcpServerInstallationRequest,
} from "@/types";
import InternalMcpCatalogModel from "./internal-mcp-catalog";

class McpServerInstallationRequestModel {
  static async create(
    request: InsertMcpServerInstallationRequest,
  ): Promise<McpServerInstallationRequest> {
    const [createdRequest] = await db
      .insert(schema.mcpServerInstallationRequestTable)
      .values(request)
      .returning();

    return createdRequest;
  }

  static async findAll(): Promise<McpServerInstallationRequest[]> {
    return await db
      .select()
      .from(schema.mcpServerInstallationRequestTable)
      .orderBy(desc(schema.mcpServerInstallationRequestTable.createdAt));
  }

  static async findById(
    id: string,
  ): Promise<McpServerInstallationRequest | null> {
    const [request] = await db
      .select()
      .from(schema.mcpServerInstallationRequestTable)
      .where(eq(schema.mcpServerInstallationRequestTable.id, id));

    return request || null;
  }

  static async findByStatus(
    status: McpServerInstallationRequestStatus,
  ): Promise<McpServerInstallationRequest[]> {
    return await db
      .select()
      .from(schema.mcpServerInstallationRequestTable)
      .where(eq(schema.mcpServerInstallationRequestTable.status, status))
      .orderBy(desc(schema.mcpServerInstallationRequestTable.createdAt));
  }

  static async findByRequestedBy(
    userId: string,
  ): Promise<McpServerInstallationRequest[]> {
    return await db
      .select()
      .from(schema.mcpServerInstallationRequestTable)
      .where(eq(schema.mcpServerInstallationRequestTable.requestedBy, userId))
      .orderBy(desc(schema.mcpServerInstallationRequestTable.createdAt));
  }

  static async findByExternalCatalogId(
    externalCatalogId: string,
  ): Promise<McpServerInstallationRequest[]> {
    return await db
      .select()
      .from(schema.mcpServerInstallationRequestTable)
      .where(
        eq(
          schema.mcpServerInstallationRequestTable.externalCatalogId,
          externalCatalogId,
        ),
      )
      .orderBy(desc(schema.mcpServerInstallationRequestTable.createdAt));
  }

  static async findPendingByExternalCatalogId(
    externalCatalogId: string,
  ): Promise<McpServerInstallationRequest | null> {
    const [request] = await db
      .select()
      .from(schema.mcpServerInstallationRequestTable)
      .where(
        and(
          eq(
            schema.mcpServerInstallationRequestTable.externalCatalogId,
            externalCatalogId,
          ),
          eq(schema.mcpServerInstallationRequestTable.status, "pending"),
        ),
      )
      .orderBy(desc(schema.mcpServerInstallationRequestTable.createdAt))
      .limit(1);

    return request || null;
  }

  static async update(
    id: string,
    request: Partial<UpdateMcpServerInstallationRequest>,
  ): Promise<McpServerInstallationRequest | null> {
    const [updatedRequest] = await db
      .update(schema.mcpServerInstallationRequestTable)
      .set(request)
      .where(eq(schema.mcpServerInstallationRequestTable.id, id))
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
            label: externalServer.display_name || externalServer.name,
            name: externalServer.name,
            version: undefined,
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
            oauthConfig: externalServer.oauth_config,
          });
        }
      } else if (currentRequest.customServerConfig) {
        // Custom server request - use provided config
        const config = currentRequest.customServerConfig;

        if (config.type === "remote") {
          await InternalMcpCatalogModel.create({
            label: config.label,
            name: config.name,
            version: config.version,
            serverType: "remote",
            serverUrl: config.serverUrl,
            docsUrl: config.docsUrl,
            userConfig: config.userConfig,
            oauthConfig: config.oauthConfig,
          });
        } else if (config.type === "local") {
          await InternalMcpCatalogModel.create({
            label: config.label,
            name: config.name,
            version: config.version,
            serverType: "local",
            localConfig: config.localConfig,
          });
        }
      }
    } catch (error) {
      // Log the error but still approve the request - admin can handle catalog creation manually
      console.error("Failed to create catalog item during approval:", error);
    }

    // Update the request status
    const [updatedRequest] = await db
      .update(schema.mcpServerInstallationRequestTable)
      .set({
        status: "approved",
        reviewedBy,
        reviewedAt: new Date(),
        adminResponse,
      })
      .where(eq(schema.mcpServerInstallationRequestTable.id, id))
      .returning();

    return updatedRequest || null;
  }

  static async decline(
    id: string,
    reviewedBy: string,
    adminResponse?: string,
  ): Promise<McpServerInstallationRequest | null> {
    const [updatedRequest] = await db
      .update(schema.mcpServerInstallationRequestTable)
      .set({
        status: "declined",
        reviewedBy,
        reviewedAt: new Date(),
        adminResponse,
      })
      .where(eq(schema.mcpServerInstallationRequestTable.id, id))
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
      .delete(schema.mcpServerInstallationRequestTable)
      .where(eq(schema.mcpServerInstallationRequestTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default McpServerInstallationRequestModel;
