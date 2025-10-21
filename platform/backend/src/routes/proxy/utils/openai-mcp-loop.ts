import type OpenAIProvider from "openai";
import type { OpenAi } from "@/types";
import { ToolModel } from "@/models";
import { executeMcpTool } from "./mcp-tool-execution";

/**
 * Handle tool execution loop for OpenAI chat completions
 * Executes MCP tools and continues the conversation until no more tool calls
 *
 * @param openAiClient - OpenAI client instance
 * @param body - Original request body
 * @param messages - Messages array (will be mutated with tool results)
 * @param tools - Tools array
 * @param agentId - Agent ID for looking up MCP tools
 * @param maxRounds - Maximum number of tool execution rounds (default: 5)
 * @returns Final assistant message after all tool calls are resolved
 */
export async function handleMcpToolExecutionLoop(
  openAiClient: OpenAIProvider,
  body: OpenAi.Types.ChatCompletionsRequest,
  messages: OpenAi.Types.ChatCompletionMessage[],
  tools: OpenAi.Types.ChatCompletionTool[] | undefined,
  agentId: string,
  maxRounds = 5,
): Promise<OpenAi.Types.ChatCompletionMessage> {
  let currentMessages = [...messages];
  let round = 0;

  while (round < maxRounds) {
    // Make LLM request
    const response = await openAiClient.chat.completions.create({
      ...body,
      messages: currentMessages,
      tools,
      stream: false,
    });

    const assistantMessage = response.choices[0].message;

    // Check if there are tool calls
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      // No more tool calls, return final message
      return assistantMessage;
    }

    // Add assistant message with tool calls to history
    currentMessages.push(assistantMessage);

    // Get all tools for this agent to identify MCP tools
    const allTools = await ToolModel.getToolsByAgent(agentId);
    const mcpToolNames = new Set(
      allTools.filter((t) => t.source === "mcp_server").map((t) => t.name),
    );

    // Execute each tool call
    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== "function") {
        continue;
      }

      const toolName = toolCall.function.name;
      const toolArgs = toolCall.function.arguments;

      // Check if this is an MCP tool
      const isMcpTool = mcpToolNames.has(toolName);

      let toolResult: string;

      if (isMcpTool) {
        // Execute MCP tool (mock for now)
        toolResult = await executeMcpTool(toolName, toolArgs);
      } else {
        // For non-MCP tools, we can't execute them here
        // The client application should handle these
        toolResult =
          "This tool cannot be executed by the proxy. Please handle this tool call in your application.";
      }

      // Add tool result to messages
      currentMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }

    round++;
  }

  // If we hit max rounds, make one final request
  const finalResponse = await openAiClient.chat.completions.create({
    ...body,
    messages: currentMessages,
    tools,
    stream: false,
  });

  return finalResponse.choices[0].message;
}
