import { eq } from "drizzle-orm";
import db, { schema } from "../database";
import type { InsertTool, Tool, UpdateTool } from "../types";

class ToolModel {
  static async createToolIfNotExists(tool: InsertTool) {
    return db.insert(schema.toolsTable).values(tool).onConflictDoNothing();
  }

  static async findAll(): Promise<Tool[]> {
    return db.select().from(schema.toolsTable);
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
