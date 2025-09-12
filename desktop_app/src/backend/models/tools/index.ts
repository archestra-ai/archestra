import { and, eq, sql } from 'drizzle-orm';

import db from '@backend/database';
import { Tool, ToolAnalysisResult, ToolSchema, toolsTable } from '@backend/database/schema/tool';
import { OllamaClient } from '@backend/ollama';
import { McpTools } from '@backend/sandbox/sandboxedMcp';
import log from '@backend/utils/logger';
import WebSocketService from '@backend/websocket';

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
          // Always update tool metadata with latest values
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          input_schema: sql`excluded.input_schema`,
          // IMPORTANT: Preserve existing analysis values if new values are NULL
          // This prevents loss of analysis data when tools are re-discovered on app restart
          // COALESCE uses the first non-null value, so:
          // - If excluded (new) value has analysis data, it will be used
          // - If excluded value is NULL (tool re-discovered without analysis), existing data is preserved
          is_read: sql`COALESCE(excluded.is_read, tools.is_read)`,
          is_write: sql`COALESCE(excluded.is_write, tools.is_write)`,
          idempotent: sql`COALESCE(excluded.idempotent, tools.idempotent)`,
          reversible: sql`COALESCE(excluded.reversible, tools.reversible)`,
          analyzed_at: sql`COALESCE(excluded.analyzed_at, tools.analyzed_at)`,
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
      const totalTools = Object.keys(tools).length;
      log.info(`Starting background analysis for ${totalTools} tools of MCP server ${mcpServerId}`);

      // Broadcast start of analysis
      WebSocketService.broadcast({
        type: 'tool-analysis-progress',
        payload: {
          mcpServerId,
          status: 'started',
          totalTools,
          analyzedTools: 0,
          message: `Analyzing ${totalTools} tools for ${mcpServerId}...`,
        },
      });

      // Prepare tools for analysis
      const toolsForAnalysis = Object.entries(tools).map(([name, tool]) => ({
        id: `${mcpServerId}__${name}`,
        name,
        description: tool.description || '',
        inputSchema: tool.inputSchema,
      }));

      let analyzedCount = 0;

      // Analyze tools one by one
      for (const toolData of toolsForAnalysis) {
        try {
          // Broadcast progress for current tool
          WebSocketService.broadcast({
            type: 'tool-analysis-progress',
            payload: {
              mcpServerId,
              status: 'analyzing',
              totalTools,
              analyzedTools: analyzedCount,
              currentTool: toolData.name,
              progress: Math.round((analyzedCount / totalTools) * 100),
              message: `Analyzing ${toolData.name} (${analyzedCount + 1}/${totalTools})...`,
            },
          });

          // Analyze single tool - this will wait for the model if it's not available yet
          const analysisResults = await OllamaClient.analyzeTools([toolData]);

          // Update tool with analysis results
          const analysis = analysisResults[toolData.name];
          if (analysis) {
            await ToolModel.updateAnalysisResults(toolData.id, analysis);
            analyzedCount++;
            log.info(`Updated analysis for tool ${toolData.name}`);

            // Broadcast progress after successful analysis
            WebSocketService.broadcast({
              type: 'tool-analysis-progress',
              payload: {
                mcpServerId,
                status: 'analyzing',
                totalTools,
                analyzedTools: analyzedCount,
                progress: Math.round((analyzedCount / totalTools) * 100),
                message: `Analyzed ${analyzedCount}/${totalTools} tools...`,
              },
            });
          }
        } catch (error) {
          log.error(`Failed to analyze tool ${toolData.name}:`, error);
          // Continue with next tool even if this one fails
        }
      }

      // Broadcast completion
      WebSocketService.broadcast({
        type: 'tool-analysis-progress',
        payload: {
          mcpServerId,
          status: 'completed',
          totalTools,
          analyzedTools: analyzedCount,
          progress: 100,
          message: `Completed analysis of ${analyzedCount} tools for ${mcpServerId}`,
        },
      });

      log.info(`Completed background analysis for MCP server ${mcpServerId}`);
    } catch (error) {
      log.error(`Background analysis failed for MCP server ${mcpServerId}:`, error);

      // Broadcast error
      WebSocketService.broadcast({
        type: 'tool-analysis-progress',
        payload: {
          mcpServerId,
          status: 'error',
          error: error instanceof Error ? error.message : 'Analysis failed',
          message: `Failed to analyze tools for ${mcpServerId}`,
        },
      });
    }
  }
}
