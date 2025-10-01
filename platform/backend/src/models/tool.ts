import db, { schema } from "../database";
import type { InsertTool, Tool } from "../types";

class ToolModel {
  static async createToolIfNotExists(tool: InsertTool) {
    return db.insert(schema.toolsTable).values(tool).onConflictDoNothing();
  }

  static async findAll(): Promise<Tool[]> {
    return db.select().from(schema.toolsTable);
  }
}

export default ToolModel;
