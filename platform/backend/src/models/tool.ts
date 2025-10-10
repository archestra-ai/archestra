import { desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertTool, Tool, UpdateTool } from "@/types";

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
