import { asc, count, desc, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { createPaginatedResult } from "@/database/utils/pagination";
import type {
  InsertTool,
  PaginationQuery,
  SortingQuery,
  Tool,
  UpdateTool,
} from "@/types";

class ToolModel {
  static async create(tool: InsertTool): Promise<Tool> {
    const [createdTool] = await db
      .insert(schema.toolsTable)
      .values(tool)
      .returning();
    return createdTool;
  }

  static async createToolIfNotExists(tool: InsertTool) {
    return db.insert(schema.toolsTable).values(tool).onConflictDoNothing();
  }

  static async findById(id: string): Promise<Tool | null> {
    const [tool] = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.id, id));
    return tool || null;
  }

  static async findAll() {
    return db
      .select({
        id: schema.toolsTable.id,
        name: schema.toolsTable.name,
        parameters: schema.toolsTable.parameters,
        description: schema.toolsTable.description,
        allowUsageWhenUntrustedDataIsPresent:
          schema.toolsTable.allowUsageWhenUntrustedDataIsPresent,
        dataIsTrustedByDefault: schema.toolsTable.dataIsTrustedByDefault,
        createdAt: schema.toolsTable.createdAt,
        updatedAt: schema.toolsTable.updatedAt,
        agent: {
          id: schema.agentsTable.id,
          name: schema.agentsTable.name,
        },
      })
      .from(schema.toolsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.toolsTable.agentId, schema.agentsTable.id),
      )
      .orderBy(desc(schema.toolsTable.createdAt));
  }

  /**
   * Find all tools with pagination and sorting support
   */
  static async findAllPaginated(
    pagination: PaginationQuery,
    sorting?: SortingQuery,
  ) {
    // Determine the ORDER BY clause based on sorting params
    const orderByClause = ToolModel.getOrderByClause(sorting);

    // Define the select structure for tools with agent
    const selectStructure = {
      id: schema.toolsTable.id,
      name: schema.toolsTable.name,
      parameters: schema.toolsTable.parameters,
      description: schema.toolsTable.description,
      allowUsageWhenUntrustedDataIsPresent:
        schema.toolsTable.allowUsageWhenUntrustedDataIsPresent,
      dataIsTrustedByDefault: schema.toolsTable.dataIsTrustedByDefault,
      createdAt: schema.toolsTable.createdAt,
      updatedAt: schema.toolsTable.updatedAt,
      agent: {
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
      },
    };

    const [data, [{ total }]] = await Promise.all([
      db
        .select(selectStructure)
        .from(schema.toolsTable)
        .innerJoin(
          schema.agentsTable,
          eq(schema.toolsTable.agentId, schema.agentsTable.id),
        )
        .orderBy(orderByClause)
        .limit(pagination.limit)
        .offset(pagination.offset),
      db.select({ total: count() }).from(schema.toolsTable),
    ]);

    return createPaginatedResult(data, Number(total), pagination);
  }

  /**
   * Helper to get the appropriate ORDER BY clause based on sorting params
   */
  private static getOrderByClause(sorting?: SortingQuery) {
    const direction = sorting?.sortDirection === "asc" ? asc : desc;

    switch (sorting?.sortBy) {
      case "name":
        return direction(schema.toolsTable.name);
      case "createdAt":
        return direction(schema.toolsTable.createdAt);
      case "updatedAt":
        return direction(schema.toolsTable.updatedAt);
      case "agentName":
        return direction(schema.agentsTable.name);
      default:
        // Default: newest first
        return desc(schema.toolsTable.createdAt);
    }
  }

  static async findByName(name: string): Promise<Tool | null> {
    const [tool] = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.name, name));
    return tool || null;
  }

  static async update(toolId: string, tool: UpdateTool) {
    const [updatedTool] = await db
      .update(schema.toolsTable)
      .set(tool)
      .where(eq(schema.toolsTable.id, toolId))
      .returning();
    return updatedTool || null;
  }
}

export default ToolModel;
