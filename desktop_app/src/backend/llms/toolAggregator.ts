import ArchestraMcpClient, { type McpTools } from '@backend/archestraMcp';
import McpServerSandboxManager from '@backend/sandbox/manager';
import { type AvailableTool } from '@backend/sandbox/schemas';

/**
 * ToolAggregator combines tools from multiple sources:
 * - Sandboxed MCP servers (managed by McpServerSandboxManager)
 * - Built-in Archestra MCP server (managed by ArchestraMcpClient)
 */
class ToolAggregator {
  /**
   * Get all tools from all sources in the Vercel AI SDK format
   */
  getAllTools(): McpTools {
    const allTools: McpTools = {};

    // Get tools from sandboxed MCP servers
    const sandboxedTools = McpServerSandboxManager.getAllTools();
    for (const [toolId, tool] of Object.entries(sandboxedTools)) {
      allTools[toolId] = tool;
    }

    // Get tools from Archestra MCP server
    const archestraTools = ArchestraMcpClient.getAllTools();
    for (const [toolId, tool] of Object.entries(archestraTools)) {
      allTools[toolId] = tool;
    }

    return allTools;
  }

  /**
   * Get specific tools by ID from all sources in the Vercel AI SDK format
   */
  getToolsById(toolIds: string[]): McpTools {
    const selected: McpTools = {};

    // Try to get each tool from sandboxed servers first
    const sandboxedTools = McpServerSandboxManager.getToolsById(toolIds);
    for (const [toolId, tool] of Object.entries(sandboxedTools)) {
      selected[toolId] = tool;
    }

    // Then try to get remaining tools from Archestra MCP server
    const remainingIds = toolIds.filter((id) => !selected[id]);
    if (remainingIds.length > 0) {
      const archestraTools = ArchestraMcpClient.getToolsById(remainingIds);
      for (const [toolId, tool] of Object.entries(archestraTools)) {
        selected[toolId] = tool;
      }
    }

    return selected;
  }

  /**
   * Get all available tools from all sources in UI format
   */
  getAllAvailableTools(): AvailableTool[] {
    const allTools: AvailableTool[] = [];

    // Get tools from sandboxed MCP servers
    allTools.push(...McpServerSandboxManager.allAvailableTools);

    // Get tools from Archestra MCP server
    if (ArchestraMcpClient.connected) {
      allTools.push(...ArchestraMcpClient.availableToolsList);
    }

    return allTools;
  }

  /**
   * Check if Archestra MCP client is connected
   */
  get archestraConnected(): boolean {
    return ArchestraMcpClient.connected;
  }
}

// Export singleton instance
export default new ToolAggregator();
