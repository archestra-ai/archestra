/**
 * MCP Tool Execution Utility
 *
 * This module handles execution of MCP server tools.
 * For now, it mocks the execution by console.logging the tool call.
 * Eventually, this will call the actual MCP server via the MCP client protocol.
 */

/**
 * Execute an MCP tool (mock implementation)
 *
 * @param toolName - Name of the tool to execute
 * @param toolArgs - Arguments to pass to the tool (as a JSON string or object)
 * @returns Mock tool result
 */
export async function executeMcpTool(
  toolName: string,
  toolArgs: string | Record<string, unknown>,
): Promise<string> {
  const parsedArgs =
    typeof toolArgs === "string" ? JSON.parse(toolArgs) : toolArgs;

  console.log("=".repeat(80));
  console.log("🔧 MCP TOOL EXECUTION (MOCK)");
  console.log("=".repeat(80));
  console.log(`Tool Name: ${toolName}`);
  console.log(`Tool Arguments:`, JSON.stringify(parsedArgs, null, 2));
  console.log("=".repeat(80));

  // Mock responses based on tool name
  switch (toolName) {
    case "read_file":
      return `Mock file contents from: ${parsedArgs.path}\n\nThis is a mock response. In production, this would read the actual file via MCP protocol.`;

    case "list_directory":
      return JSON.stringify(
        {
          files: [
            { name: "file1.txt", type: "file" },
            { name: "file2.js", type: "file" },
            { name: "subdir", type: "directory" },
          ],
          path: parsedArgs.path,
        },
        null,
        2,
      );

    case "search_files":
      return JSON.stringify(
        {
          matches: [
            `${parsedArgs.base_path || "/mock/path"}/matching-file-1.txt`,
            `${parsedArgs.base_path || "/mock/path"}/matching-file-2.js`,
          ],
          pattern: parsedArgs.pattern,
        },
        null,
        2,
      );

    default:
      return `Mock result for tool: ${toolName}\nArguments: ${JSON.stringify(parsedArgs, null, 2)}\n\nThis tool is not yet implemented in the mock.`;
  }
}

/**
 * Check if there are more tool calls to process
 *
 * @param responseContent - The response content from the LLM (provider-specific)
 * @returns True if there are tool calls to process
 */
export function hasToolCalls(
  responseContent: { tool_calls?: unknown[] } | { content?: unknown[] },
): boolean {
  // OpenAI format
  if ("tool_calls" in responseContent && responseContent.tool_calls) {
    return responseContent.tool_calls.length > 0;
  }

  // Anthropic format
  if ("content" in responseContent && Array.isArray(responseContent.content)) {
    return responseContent.content.some(
      (item: { type?: string }) => item.type === "tool_use",
    );
  }

  return false;
}
