import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import db, { schema } from "@/database";
import type {
  InsertMcpServerInstallationRequest,
  McpServerInstallationRequest,
  UpdateMcpServerInstallationRequest,
} from "@/types";

type RequestStatus = "pending" | "approved" | "declined";

class McpServerInstallationRequestModel {
  static async create(
    request: InsertMcpServerInstallationRequest
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
    id: string
  ): Promise<McpServerInstallationRequest | null> {
    const [request] = await db
      .select()
      .from(schema.mcpServerInstallationRequestTable)
      .where(eq(schema.mcpServerInstallationRequestTable.id, id));

    return request || null;
  }

  static async findByStatus(
    status: RequestStatus
  ): Promise<McpServerInstallationRequest[]> {
    return await db
      .select()
      .from(schema.mcpServerInstallationRequestTable)
      .where(eq(schema.mcpServerInstallationRequestTable.status, status))
      .orderBy(desc(schema.mcpServerInstallationRequestTable.createdAt));
  }

  static async findByRequestedBy(
    userId: string
  ): Promise<McpServerInstallationRequest[]> {
    return await db
      .select()
      .from(schema.mcpServerInstallationRequestTable)
      .where(eq(schema.mcpServerInstallationRequestTable.requestedBy, userId))
      .orderBy(desc(schema.mcpServerInstallationRequestTable.createdAt));
  }

  static async findByCatalogId(
    catalogId: string
  ): Promise<McpServerInstallationRequest[]> {
    return await db
      .select()
      .from(schema.mcpServerInstallationRequestTable)
      .where(eq(schema.mcpServerInstallationRequestTable.catalogId, catalogId))
      .orderBy(desc(schema.mcpServerInstallationRequestTable.createdAt));
  }

  static async findPendingByCatalogId(
    catalogId: string
  ): Promise<McpServerInstallationRequest | null> {
    const [request] = await db
      .select()
      .from(schema.mcpServerInstallationRequestTable)
      .where(
        and(
          eq(schema.mcpServerInstallationRequestTable.catalogId, catalogId),
          eq(schema.mcpServerInstallationRequestTable.status, "pending")
        )
      )
      .orderBy(desc(schema.mcpServerInstallationRequestTable.createdAt))
      .limit(1);

    return request || null;
  }

  static async update(
    id: string,
    request: Partial<UpdateMcpServerInstallationRequest>
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
    adminResponse?: string
  ): Promise<McpServerInstallationRequest | null> {
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
    adminResponse?: string
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
    content: string
  ): Promise<McpServerInstallationRequest | null> {
    // First, get the current request
    const currentRequest = await this.findById(id);
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
    return await this.update(id, { notes: updatedNotes });
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.mcpServerInstallationRequestTable)
      .where(eq(schema.mcpServerInstallationRequestTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default McpServerInstallationRequestModel;
