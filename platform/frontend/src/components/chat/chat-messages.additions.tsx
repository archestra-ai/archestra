/**
 * chat-messages.additions.tsx
 *
 * INSTRUCTIONS: This file shows the EXACT changes to make in
 * frontend/src/components/chat/chat-messages.tsx
 *
 * You need to make two additions:
 *
 * ── ADDITION 1: Import McpAppContainer and McpAppErrorBoundary ────────────
 *
 * Add near the top of chat-messages.tsx, after existing imports:
 *
 *   import { McpAppContainer, McpAppErrorBoundary } from "./mcp-app-container";
 *
 *
 * ── ADDITION 2: Render MCP App after ToolOutput in ExpandedToolCard ───────
 *
 * In the ExpandedToolCard component (inside compact-tool-call.tsx or
 * chat-messages.tsx depending on your structure), after the existing
 * ToolOutput block, add the McpAppSection component below.
 *
 * The key is: only render if the tool's _meta.ui.resourceUri is set.
 *
 * Here is the complete McpAppSection component to add to the file:
 */

import { useMemo } from "react";
import type { McpAppToolResult } from "./mcp-app-container";
import { McpAppContainer, McpAppErrorBoundary } from "./mcp-app-container";

interface McpAppSectionProps {
  /** The tool part from the AI SDK message stream */
  part: {
    toolName?: string;
    input?: Record<string, unknown>;
    output?: unknown;
    /** _meta comes through when chat-mcp-client passes it in tool output */
    _meta?: {
      ui?: {
        resourceUri?: string;
        csp?: string[];
        visibility?: Array<"model" | "app">;
      };
    };
  };
  /** Tool result part if separately tracked */
  toolResultPart?: {
    output?: unknown;
  };
  /** The agent ID for proxy calls */
  agentId: string;
  /** Pre-fetched HTML from SSE data-tool-ui-start event */
  preloadedHtml?: string;
}

/**
 * McpAppSection renders an MCP App iframe if the tool declares a ui:// resource.
 *
 * Drop this component after the ToolOutput blocks in ExpandedToolCard:
 *
 * ```tsx
 * {toolResultPart && (
 *   <ToolOutput ... />
 * )}
 * {!toolResultPart && Boolean(part.output) && (
 *   <ToolOutput ... />
 * )}
 *
 * // ← ADD THIS:
 * <McpAppSection
 *   part={part}
 *   toolResultPart={toolResultPart}
 *   agentId={agentId}
 *   preloadedHtml={preloadedHtml}
 * />
 * ```
 */
export function McpAppSection({
  part,
  toolResultPart,
  agentId,
  preloadedHtml,
}: McpAppSectionProps) {
  const resourceUri = part._meta?.ui?.resourceUri;
  const allowedOrigins = part._meta?.ui?.csp;

  // Derive the server prefix from the tool name (format: "serverPrefix__toolName")
  const serverPrefix = useMemo(() => {
    const toolName = part.toolName ?? "";
    const idx = toolName.indexOf("__");
    return idx > 0 ? toolName.slice(0, idx) : toolName;
  }, [part.toolName]);

  // Build the tool result in MCP Apps format
  const toolResult = useMemo((): McpAppToolResult | undefined => {
    const output = toolResultPart?.output ?? part.output;
    if (!output) return undefined;

    // If output is already structured, pass as structuredContent
    if (typeof output === "object" && output !== null) {
      return { structuredContent: output as Record<string, unknown> };
    }

    // Otherwise wrap in a text content block
    return {
      content: [{ type: "text", text: String(output) }],
    };
  }, [toolResultPart?.output, part.output]);

  if (!resourceUri) return null;

  return (
    <div className="mt-3">
      <McpAppErrorBoundary>
        <McpAppContainer
          resourceUri={resourceUri}
          preloadedHtml={preloadedHtml}
          toolArgs={part.input}
          toolResult={toolResult}
          serverPrefix={serverPrefix}
          agentId={agentId}
          allowedOrigins={allowedOrigins}
        />
      </McpAppErrorBoundary>
    </div>
  );
}

/**
 * ── ADDITION 3: Handle data-tool-ui-start SSE events ─────────────────────
 *
 * In chat-messages.tsx where you handle SSE parts in the message stream,
 * add handling for "data-tool-ui-start" parts:
 *
 * These are emitted by routes/chat/routes.chat.ts when a tool with a
 * ui:// resource begins executing, so the iframe can start loading
 * before the tool result arrives.
 *
 * In your message parts loop, add:
 *
 * ```ts
 * if (part.type === "data-tool-ui-start") {
 *   setEarlyToolUiStarts(prev => ({
 *     ...prev,
 *     [part.toolCallId]: {
 *       html: part.html,
 *       resourceUri: part.resourceUri,
 *     }
 *   }));
 * }
 * ```
 *
 * Then pass earlyToolUiStarts[tool.toolCallId]?.html as preloadedHtml
 * to McpAppSection.
 *
 *
 * ── ADDITION 4: Filter app-only tools from LLM ────────────────────────────
 *
 * In chat-mcp-client.ts, when building the tool list for the LLM, filter
 * out tools where _meta.ui.visibility is ["app"] only (not ["model"]):
 *
 * ```ts
 * const llmTools = allTools.filter(tool => {
 *   const visibility = tool._meta?.ui?.visibility;
 *   if (!visibility) return true; // no restriction → show to LLM
 *   return visibility.includes("model");
 * });
 * ```
 *
 *
 * ── ADDITION 5: Emit data-tool-ui-start in SSE stream ─────────────────────
 *
 * In routes/chat/routes.chat.ts, when a tool call begins streaming,
 * check if it has a _meta.ui.resourceUri and emit the pre-fetched HTML:
 *
 * ```ts
 * if (tool._meta?.ui?.resourceUri) {
 *   const html = await fetchToolUiResource(tool._meta.ui.resourceUri, agentId);
 *   if (html) {
 *     stream.writeData({
 *       type: "data-tool-ui-start",
 *       toolCallId: toolCallId,
 *       resourceUri: tool._meta.ui.resourceUri,
 *       html,
 *     });
 *   }
 * }
 * ```
 */
