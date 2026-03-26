// ─────────────────────────────────────────────────────────────────────────────
// PATCH: compact-tool-call.tsx
// Add McpAppView rendering after ToolOutput when _meta.ui.resourceUri is present
// ─────────────────────────────────────────────────────────────────────────────

// 1. Add this import near the top of the file:
import { McpAppView } from "./mcp-app-view";

// 2. Inside your component, extract the resourceUri from the tool result _meta.
//    Add this logic wherever you build/render ToolOutput:

/*
  BEFORE (pseudocode showing where ToolOutput is rendered):
  
    <ToolOutput part={part} toolResultPart={toolResultPart} ... />

  AFTER:
*/

// ── Inside your CompactToolCall (or equivalent) component: ───────────────────

// Derive the resource URI from the tool result metadata, if present.
// `toolResultPart` is the ToolUIPart that holds the result content.

const resourceUri: string | undefined = (() => {
  // The MCP spec places metadata in result.content[n]._meta or result._meta.
  // Adjust the path to match how your SDK surfaces it.
  const result = (toolResultPart as any)?.result;
  return (
    result?._meta?.ui?.resourceUri ??
    result?.content?.find?.((c: any) => c?._meta?.ui?.resourceUri)?._meta?.ui
      ?.resourceUri
  );
})();

// Then in JSX, after <ToolOutput .../>:
{
  resourceUri && (
    <McpAppView
      resourceUri={resourceUri}
      toolArgs={(part as any)?.input ?? {}}
      toolResult={(toolResultPart as any)?.result}
      onToolCall={async (_toolName, _args) => {
        // Wire up to your existing tool invocation mechanism, e.g.:
        // return invokeToolFromChat(toolName, args);
        throw new Error("onToolCall not wired up yet");
      }}
    />
  );
}
