import { and, eq, sql } from 'drizzle-orm';

import db from '@backend/database';
import { Tool, ToolAnalysisResult, ToolSchema, toolsTable } from '@backend/database/schema/tool';
import { OllamaClient } from '@backend/ollama';
import { McpTools } from '@backend/sandbox/sandboxedMcp';
import log from '@backend/utils/logger';

export class ToolModel {
  /**
   * Create or update a tool
   */
  static async upsert(data: Partial<Tool> & { id: string; mcp_server_id: string; name: string }): Promise<Tool> {
    const [tool] = await db
      .insert(toolsTable)
      .values({
        ...data,
        updated_at: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: toolsTable.id,
        set: {
          ...data,
          updated_at: new Date().toISOString(),
        },
      })
      .returning();

    return ToolSchema.parse(tool);
  }

  /**
   * Create or update multiple tools
   */
  static async upsertMany(
    tools: Array<Partial<Tool> & { id: string; mcp_server_id: string; name: string }>
  ): Promise<Tool[]> {
    if (tools.length === 0) return [];

    const values = tools.map((tool) => ({
      ...tool,
      updated_at: new Date().toISOString(),
    }));

    const results = await db
      .insert(toolsTable)
      .values(values)
      .onConflictDoUpdate({
        target: toolsTable.id,
        set: {
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          input_schema: sql`excluded.input_schema`,
          is_read: sql`excluded.is_read`,
          is_write: sql`excluded.is_write`,
          idempotent: sql`excluded.idempotent`,
          reversible: sql`excluded.reversible`,
          analyzed_at: sql`excluded.analyzed_at`,
          updated_at: sql`excluded.updated_at`,
        },
      })
      .returning();

    return results.map((result) => ToolSchema.parse(result));
  }

  /**
   * Get a tool by ID
   */
  static async getById(id: string): Promise<Tool | null> {
    const result = await db.select().from(toolsTable).where(eq(toolsTable.id, id)).limit(1);

    if (result.length === 0) return null;
    return ToolSchema.parse(result[0]);
  }

  /**
   * Get tools by MCP server ID
   */
  static async getByMcpServerId(mcpServerId: string): Promise<Tool[]> {
    const results = await db.select().from(toolsTable).where(eq(toolsTable.mcp_server_id, mcpServerId));

    return results.map((result) => ToolSchema.parse(result));
  }

  /**
   * Get all tools
   */
  static async getAll(): Promise<Tool[]> {
    const results = await db.select().from(toolsTable);
    return results.map((result) => ToolSchema.parse(result));
  }

  /**
   * Update tool analysis results
   */
  static async updateAnalysisResults(id: string, analysisResults: ToolAnalysisResult): Promise<Tool | null> {
    const [result] = await db
      .update(toolsTable)
      .set({
        ...analysisResults,
        analyzed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where(eq(toolsTable.id, id))
      .returning();

    if (!result) return null;
    return ToolSchema.parse(result);
  }

  /**
   * Get unanalyzed tools for a given MCP server
   */
  static async getUnanalyzedByMcpServerId(mcpServerId: string): Promise<Tool[]> {
    const results = await db
      .select()
      .from(toolsTable)
      .where(and(eq(toolsTable.mcp_server_id, mcpServerId), eq(toolsTable.analyzed_at, sql`null`)));

    return results.map((result) => ToolSchema.parse(result));
  }

  /**
   * Analyze tools - saves tools immediately and analyzes in background
   * This is non-blocking and will not wait for Ollama models to be available
   */
  static async analyze(tools: McpTools, mcpServerId: string): Promise<void> {
    try {
      log.info(`Starting async analysis of ${Object.keys(tools).length} tools for MCP server ${mcpServerId}`);

      // Prepare tools for saving
      const toolsToSave = Object.entries(tools).map(([name, tool]) => ({
        id: `${mcpServerId}__${name}`,
        mcp_server_id: mcpServerId,
        name,
        description: tool.description || '',
        input_schema: tool.inputSchema,
      }));

      // Save tools immediately without analysis results
      await ToolModel.upsertMany(toolsToSave);
      log.info(`Saved ${toolsToSave.length} tools for MCP server ${mcpServerId}, analysis will happen in background`);

      // Start analysis in background without awaiting
      ToolModel.performBackgroundAnalysis(tools, mcpServerId).catch((error) => {
        log.error(`Background analysis failed for MCP server ${mcpServerId}:`, error);
      });
    } catch (error) {
      log.error(`Failed to save tools for MCP server ${mcpServerId}:`, error);
      throw error;
    }
  }

  /**
   * Perform tool analysis in the background
   * This method will wait for Ollama models if needed and update tools with analysis results
   */
  private static async performBackgroundAnalysis(tools: McpTools, mcpServerId: string): Promise<void> {
    try {
      log.info(`Starting background analysis for ${Object.keys(tools).length} tools of MCP server ${mcpServerId}`);

      // Prepare tools for analysis
      const toolsForAnalysis = Object.entries(tools).map(([name, tool]) => ({
        id: `${mcpServerId}__${name}`,
        name,
        description: tool.description || '',
        inputSchema: tool.inputSchema,
      }));

      // Analyze tools in batches
      const batchSize = 10;
      for (let i = 0; i < toolsForAnalysis.length; i += batchSize) {
        const batch = toolsForAnalysis.slice(i, i + batchSize);

        try {
          // This will wait for the model if it's not available yet
          const analysisResults = await OllamaClient.analyzeTools(batch);

          // Update tools with analysis results
          for (const toolData of batch) {
            const analysis = analysisResults[toolData.name];
            if (analysis) {
              await ToolModel.updateAnalysisResults(toolData.id, analysis);
              log.info(`Updated analysis for tool ${toolData.name}`);
            }
          }
        } catch (error) {
          log.error(`Failed to analyze batch of tools in background:`, error);
          // Continue with next batch even if this one fails
        }
      }

      log.info(`Completed background analysis for MCP server ${mcpServerId}`);
    } catch (error) {
      log.error(`Background analysis failed for MCP server ${mcpServerId}:`, error);
    }
  }
}
