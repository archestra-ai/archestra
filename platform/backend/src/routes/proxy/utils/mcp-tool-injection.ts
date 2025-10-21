import type { OpenAi } from "@/types";
import { ToolModel } from "@/models";

/**
 * Get MCP tools assigned to an agent and convert them to OpenAI format
 */
export async function getMcpToolsForAgent(
  agentId: string,
): Promise<OpenAi.Types.ChatCompletionTool[]> {
  // Fetch all tools for the agent
  const allTools = await ToolModel.getToolsByAgent(agentId);

  // Filter for MCP tools only
  const mcpTools = allTools.filter((tool) => tool.source === "mcp_server");

  // Convert to OpenAI format
  return mcpTools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters as OpenAi.Tools.FunctionDefinitionParameters,
    },
  }));
}

/**
 * Merge MCP tools with proxy-sniffed tools from the request
 * Removes duplicates based on tool name
 */
export function mergeTools(
  requestTools: OpenAi.Types.ChatCompletionTool[] | undefined,
  mcpTools: OpenAi.Types.ChatCompletionTool[],
): OpenAi.Types.ChatCompletionTool[] {
  if (!requestTools || requestTools.length === 0) {
    return mcpTools;
  }

  // Create a map of tool names from request tools
  const requestToolNames = new Set(
    requestTools
      .filter((t) => t.type === "function")
      .map((t) => t.function.name),
  );

  // Filter out MCP tools that are already in the request
  const uniqueMcpTools = mcpTools.filter(
    (t) => !requestToolNames.has(t.function.name),
  );

  // Merge both arrays
  return [...requestTools, ...uniqueMcpTools];
}
