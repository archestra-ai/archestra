import { and, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertMcpServerInstallationRequest,
  McpServerInstallationRequest,
  UpdateMcpServerInstallationRequest,
} from "@/types";

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

  static async findAll(
    status?: "pending" | "approved" | "declined",
  ): Promise<McpServerInstallationRequest[]> {
    let query = db
      .select()
      .from(schema.mcpServerInstallationRequestTable)
      .orderBy(desc(schema.mcpServerInstallationRequestTable.createdAt))
      .$dynamic();

    if (status) {
      query = query.where(
        eq(schema.mcpServerInstallationRequestTable.status, status),
      );
    }

    return await query;
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

  static async findByUser(
    userId: string,
  ): Promise<McpServerInstallationRequest[]> {
    return await db
      .select()
      .from(schema.mcpServerInstallationRequestTable)
      .where(eq(schema.mcpServerInstallationRequestTable.requestedBy, userId))
      .orderBy(desc(schema.mcpServerInstallationRequestTable.createdAt));
  }

  static async findByCatalogId(
    catalogId: string,
  ): Promise<McpServerInstallationRequest[]> {
    return await db
      .select()
      .from(schema.mcpServerInstallationRequestTable)
      .where(eq(schema.mcpServerInstallationRequestTable.catalogId, catalogId))
      .orderBy(desc(schema.mcpServerInstallationRequestTable.createdAt));
  }

  static async findPendingRequestForCatalogByUser(
    catalogId: string,
    userId: string,
  ): Promise<McpServerInstallationRequest | null> {
    const [request] = await db
      .select()
      .from(schema.mcpServerInstallationRequestTable)
      .where(
        and(
          eq(schema.mcpServerInstallationRequestTable.catalogId, catalogId),
          eq(schema.mcpServerInstallationRequestTable.requestedBy, userId),
          eq(schema.mcpServerInstallationRequestTable.status, "pending"),
        ),
      );

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
    reviewNotes?: string,
  ): Promise<McpServerInstallationRequest | null> {
    return await this.update(id, {
      status: "approved",
      reviewedBy,
      reviewedAt: new Date(),
      reviewNotes,
    });
  }

  static async decline(
    id: string,
    reviewedBy: string,
    reviewNotes?: string,
  ): Promise<McpServerInstallationRequest | null> {
    return await this.update(id, {
      status: "declined",
      reviewedBy,
      reviewedAt: new Date(),
      reviewNotes,
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
