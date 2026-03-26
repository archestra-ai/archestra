// ─────────────────────────────────────────────────────────────────────────────
// PATCH: backend/src/routes/proxy/llm-proxy-helpers.ts  (or adapterV2/)
//
// Goal: when converting MCP tool definitions → OpenAI / Anthropic tool format,
// preserve the _meta.ui field so downstream clients get the UI metadata.
// ─────────────────────────────────────────────────────────────────────────────

// ── 1. Type augmentation ──────────────────────────────────────────────────────

// Add (or merge into your existing types file):

export interface McpUiMeta {
  /** A ui:// resource URI the frontend can load as an iframe app */
  resourceUri?: string;
  /** Preferred display mode: "panel" | "inline" | "modal" */
  displayMode?: "panel" | "inline" | "modal";
}

export interface McpToolMeta {
  ui?: McpUiMeta;
}

// Extend however you currently type MCP tool definitions:
export interface McpToolDefinitionWithMeta {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>; // JSON Schema
  _meta?: McpToolMeta;
}

// ── 2. Conversion helper ──────────────────────────────────────────────────────

/**
 * Converts an MCP tool definition to the OpenAI function-calling format,
 * preserving _meta.ui in the function description's metadata extension field
 * AND in a top-level `_meta` key that Archestra-aware clients can read.
 *
 * OpenAI doesn't have a native _meta field, so we embed it in two places:
 *   a) As a JSON-encoded suffix in the description (for dumb passthrough clients)
 *   b) As a top-level `_meta` key on the tool object (for Archestra clients)
 */
export function mcpToolToOpenAITool(tool: McpToolDefinitionWithMeta): Record<string, unknown> {
  const baseTool: Record<string, unknown> = {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema,
    },
  };

  if (tool._meta) {
    // Archestra-aware clients read this directly
    (baseTool as any)._meta = tool._meta;

    // Embed in description for passthrough compatibility
    if (tool._meta.ui) {
      const fn = baseTool.function as Record<string, unknown>;
      fn.description =
        `${fn.description ?? ""}\n\n<!-- _meta:${JSON.stringify(tool._meta)} -->`.trim();
    }
  }

  return baseTool;
}

/**
 * Converts an MCP tool definition to Anthropic tool format,
 * preserving _meta.ui in the custom field supported by the Anthropic SDK.
 */
export function mcpToolToAnthropicTool(tool: McpToolDefinitionWithMeta): Record<string, unknown> {
  const baseTool: Record<string, unknown> = {
    name: tool.name,
    description: tool.description ?? "",
    input_schema: tool.inputSchema,
  };

  if (tool._meta) {
    // Anthropic API ignores unknown top-level keys; clients reading the
    // raw tool list (e.g. via the proxy response) will see this.
    (baseTool as any)._meta = tool._meta;
  }

  return baseTool;
}

// ── 3. Apply the patch ───────────────────────────────────────────────────────
//
// Find wherever your proxy currently does something like:
//
//   const openAiTools = mcpTools.map(t => ({
//     type: "function",
//     function: { name: t.name, description: t.description, parameters: t.inputSchema }
//   }));
//
// Replace with:
//
//   import { mcpToolToOpenAITool } from "./llm-proxy-helpers";
//   const openAiTools = mcpTools.map(mcpToolToOpenAITool);
//
// And for Anthropic-format proxying:
//
//   import { mcpToolToAnthropicTool } from "./llm-proxy-helpers";
//   const anthropicTools = mcpTools.map(mcpToolToAnthropicTool);
