import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { jsonSchema, type ToolSet, tool } from "ai";

/**
 * Expose the MCP gateway's tools to the model.
 *
 * The gateway is dialled as an ordinary external client with the invoking
 * user's own bearer, so whatever it lists is exactly that person's tool
 * access — this process has no privileged path back into the platform and does
 * no filtering of its own.
 */
export async function loadGatewayTools(client: Client): Promise<ToolSet> {
  const { tools: mcpTools } = await client.listTools();
  const toolSet: ToolSet = {};

  for (const mcpTool of mcpTools) {
    toolSet[mcpTool.name] = tool({
      description: mcpTool.description || `Tool: ${mcpTool.name}`,
      inputSchema: jsonSchema(
        (mcpTool.inputSchema as Record<string, unknown>) ?? {
          type: "object",
          properties: {},
        },
      ),
      execute: async (args: unknown) => {
        const result = await client.callTool({
          name: mcpTool.name,
          arguments: isRecord(args) ? args : {},
        });
        return renderToolResult(result);
      },
    });
  }

  return toolSet;
}

/**
 * Flatten an MCP result into text the model can read. Non-text content is
 * named rather than dropped, so a tool that returns an image does not look to
 * the model like a tool that returned nothing.
 */
function renderToolResult(result: unknown): string {
  if (!isRecord(result)) return String(result);
  const content = result.content;
  if (!Array.isArray(content)) return JSON.stringify(result);

  const parts = content.map((entry) => {
    if (!isRecord(entry)) return String(entry);
    if (entry.type === "text" && typeof entry.text === "string") {
      return entry.text;
    }
    return `[${String(entry.type ?? "content")}]`;
  });
  const text = parts.join("\n");
  return result.isError === true ? `Tool error: ${text}` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
