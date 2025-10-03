import { desc, eq } from "drizzle-orm";
import db, { schema } from "../database";
import type { InsertTool, Tool, UpdateTool } from "../types";

class ToolModel {
  static async createToolIfNotExists(tool: InsertTool) {
    return db.insert(schema.toolsTable).values(tool).onConflictDoNothing();
  }

  static async findAll(): Promise<Tool[]> {
    return db
      .select()
      .from(schema.toolsTable)
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
