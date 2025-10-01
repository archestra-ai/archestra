import db, { schema } from "../database";
import type { Tool } from "../types";

class ToolModel {
  static async findAll(): Promise<Tool[]> {
    const tools = await db.select().from(schema.toolsTable);
    return tools;
  }
}

export default ToolModel;
