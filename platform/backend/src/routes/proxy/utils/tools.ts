import { inArray } from "drizzle-orm";
import type { z } from "zod";
import db, { schema } from "@/database";
import { AgentToolModel, ToolModel } from "@/models";
import type { Anthropic, OpenAi, Tool } from "@/types";

/**
 * Persist tools if present in the request
 */
export const persistTools = async (
  tools: Array<{
    toolName: string;
    toolParameters?: Record<string, unknown>;
    toolDescription?: string;
  }>,
  agentId: string,
) => {
  for (const { toolName, toolParameters, toolDescription } of tools) {
    // Create or get the tool
    const tool = await ToolModel.createToolIfNotExists({
      name: toolName,
      parameters: toolParameters,
      description: toolDescription,
    });

    // Create the agent-tool relationship
    await AgentToolModel.createIfNotExists(agentId, tool.id);
  }
};

/**
 * Get tools assigned to an agent via the agent_tools junction table
 */
async function getAssignedMCPTools(agentId: string): Promise<Tool[]> {
  const toolIds = await AgentToolModel.findToolIdsByAgent(agentId);

  if (toolIds.length === 0) {
    return [];
  }

  // Fetch full tool details
  const tools = await db
    .select()
    .from(schema.toolsTable)
    .where(inArray(schema.toolsTable.id, toolIds));

  return tools;
}

/**
 * Inject assigned MCP tools into OpenAI tools array
 * Assigned tools take priority and override tools with the same name from the request
 */
export async function injectOpenAITools(
  requestTools: z.infer<typeof OpenAi.Tools.ToolSchema>[] | undefined,
  agentId: string,
): Promise<z.infer<typeof OpenAi.Tools.ToolSchema>[]> {
  const assignedTools = await getAssignedMCPTools(agentId);

  // Convert assigned tools to OpenAI format
  const assignedOpenAITools: z.infer<typeof OpenAi.Tools.ToolSchema>[] =
    assignedTools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description || undefined,
        parameters: tool.parameters,
      },
    }));

  // Create a map of request tools by name for easy lookup
  const requestToolMap = new Map<
    string,
    z.infer<typeof OpenAi.Tools.ToolSchema>
  >();
  for (const tool of requestTools || []) {
    const toolName =
      tool.type === "function" ? tool.function.name : tool.custom.name;
    requestToolMap.set(toolName, tool);
  }

  // Merge: assigned tools override request tools with same name
  const mergedToolMap = new Map<
    string,
    z.infer<typeof OpenAi.Tools.ToolSchema>
  >(requestToolMap);
  for (const assignedTool of assignedOpenAITools) {
    // All assigned tools are function type since we create them that way above
    if (assignedTool.type === "function") {
      mergedToolMap.set(assignedTool.function.name, assignedTool);
    }
  }

  return Array.from(mergedToolMap.values());
}

/**
 * Inject assigned MCP tools into Anthropic tools array
 * Assigned tools take priority and override tools with the same name from the request
 */
export async function injectAnthropicTools(
  requestTools: z.infer<typeof Anthropic.Tools.ToolSchema>[] | undefined,
  agentId: string,
): Promise<z.infer<typeof Anthropic.Tools.ToolSchema>[]> {
  const assignedTools = await getAssignedMCPTools(agentId);

  // Convert assigned tools to Anthropic format (CustomTool)
  const assignedAnthropicTools: z.infer<
    typeof Anthropic.Tools.CustomToolSchema
  >[] = assignedTools.map((tool) => ({
    name: tool.name,
    description: tool.description || undefined,
    input_schema: tool.parameters || {},
    type: "custom" as const,
  }));

  // Create a map of request tools by name
  const requestToolMap = new Map<
    string,
    z.infer<typeof Anthropic.Tools.ToolSchema>
  >();
  for (const tool of requestTools || []) {
    requestToolMap.set(tool.name, tool);
  }

  // Merge: assigned tools override request tools with same name
  const mergedToolMap = new Map<
    string,
    z.infer<typeof Anthropic.Tools.ToolSchema>
  >(requestToolMap);
  for (const assignedTool of assignedAnthropicTools) {
    mergedToolMap.set(assignedTool.name, assignedTool);
  }

  return Array.from(mergedToolMap.values());
}

/**
 * Inject assigned MCP tools into Gemini tools object
 * Assigned tools take priority and override tools with the same name from the request
 */
// export async function injectGeminiTools(
//   requestTools: Gemini.Types.Tool[] | undefined,
//   agentId: string,
// ): Promise<Gemini.Types.Tool[] | undefined> {
//   const assignedTools = await getAssignedMCPTools(agentId);

//   // Convert assigned tools to Gemini format (function declarations)
//   const assignedGeminiFunctions: z.infer<
//     typeof Gemini.Tools.FunctionDeclarationSchema
//   >[] = assignedTools.map((tool) => ({
//     name: tool.name,
//     description: tool.description || "",
//     parameters: tool.parameters,
//   }));

//   if (assignedGeminiFunctions.length === 0 && !requestTools) {
//     return undefined;
//   }

//   // Handle case where requestTools is undefined or empty
//   const requestFunctions: z.infer<
//     typeof Gemini.Tools.FunctionDeclarationSchema
//   >[] = [];
//   if (requestTools && requestTools.length > 0) {
//     for (const tool of requestTools) {
//       if (tool.functionDeclarations) {
//         requestFunctions.push(...tool.functionDeclarations);
//       }
//     }
//   }

//   // Create a map of request functions by name
//   const functionMap = new Map<
//     string,
//     z.infer<typeof Gemini.Tools.FunctionDeclarationSchema>
//   >();
//   for (const func of requestFunctions) {
//     functionMap.set(func.name, func);
//   }

//   // Merge: assigned tools override request tools with same name
//   for (const assignedFunc of assignedGeminiFunctions) {
//     functionMap.set(assignedFunc.name, assignedFunc);
//   }

//   // Return as Gemini.Types.Tool array format
//   const mergedFunctions = Array.from(functionMap.values());
//   if (mergedFunctions.length === 0) {
//     return undefined;
//   }

//   return [{ functionDeclarations: mergedFunctions }];
// }
