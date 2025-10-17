import { desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertTool,
  Tool,
  ToolResultTreatment,
  UpdateTool,
} from "@/types";

class ToolModel {
  static async create(tool: InsertTool): Promise<Tool> {
    const [createdTool] = await db
      .insert(schema.toolsTable)
      .values(tool)
      .returning();
    return {
      ...createdTool,
      toolResultTreatment:
        createdTool.toolResultTreatment as ToolResultTreatment,
    };
  }

  static async createToolIfNotExists(tool: InsertTool) {
    return db.insert(schema.toolsTable).values(tool).onConflictDoNothing();
  }

  static async findById(id: string): Promise<Tool | null> {
    const [tool] = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.id, id));
    if (!tool) return null;
    return {
      ...tool,
      toolResultTreatment: tool.toolResultTreatment as ToolResultTreatment,
    };
  }

  static async findAll() {
    const tools = await db
      .select({
        id: schema.toolsTable.id,
        name: schema.toolsTable.name,
        parameters: schema.toolsTable.parameters,
        description: schema.toolsTable.description,
        allowUsageWhenUntrustedDataIsPresent:
          schema.toolsTable.allowUsageWhenUntrustedDataIsPresent,
        toolResultTreatment: schema.toolsTable.toolResultTreatment,
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

    return tools.map((tool) => ({
      ...tool,
      toolResultTreatment: tool.toolResultTreatment as ToolResultTreatment,
    }));
  }

  static async findByName(name: string): Promise<Tool | null> {
    const [tool] = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.name, name));
    if (!tool) return null;
    return {
      ...tool,
      toolResultTreatment: tool.toolResultTreatment as ToolResultTreatment,
    };
  }

  static async update(toolId: string, tool: UpdateTool) {
    const [updatedTool] = await db
      .update(schema.toolsTable)
      .set(tool)
      .where(eq(schema.toolsTable.id, toolId))
      .returning();
    if (!updatedTool) return null;
    return {
      ...updatedTool,
      toolResultTreatment:
        updatedTool.toolResultTreatment as ToolResultTreatment,
    };
  }
}

export default ToolModel;
