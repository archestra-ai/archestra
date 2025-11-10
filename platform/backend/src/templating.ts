import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import Handlebars from "handlebars";
import type { CommonToolResult } from "@/types";

/**
 * Register custom Handlebars helpers for template rendering
 */
Handlebars.registerHelper("json", (context) => {
  // If context is a string, try to parse it as JSON
  if (typeof context === "string") {
    try {
      return JSON.parse(context);
    } catch {
      // If not valid JSON, return the string as-is
      return context;
    }
  }
  // If context is an object, stringify it
  return JSON.stringify(context);
});

// Helper to escape strings for use in JSON
Handlebars.registerHelper("escapeJson", (str) => {
  if (typeof str !== "string") return str;
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
});

/**
 * Apply a handlebars template to transform a tool response
 *
 * The content from MCP tools will look like:
 * https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools
 *
 * @param templateString - Handlebars template string
 * @param toolCallResponseResultContent - The content returned from an MCP tool call
 * @returns Transformed content (parsed JSON or original content on failure)
 */
export function applyResponseModifierTemplate(
  templateString: string,
  toolCallResponseResultContent: Awaited<
    ReturnType<typeof Client.prototype.callTool>
  >["content"],
): CommonToolResult["content"] {
  try {
    const template = Handlebars.compile(templateString);

    // Render the template with the response as context
    const rendered = template({ response: toolCallResponseResultContent });

    // Try to parse as JSON if possible, otherwise return as text
    try {
      return JSON.parse(rendered);
    } catch {
      // If it's not valid JSON, return as a text content block
      return [{ type: "text", text: rendered }];
    }
  } catch {
    // If template compilation or rendering fails, return original content
    return toolCallResponseResultContent;
  }
}
