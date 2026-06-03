import type { UIMessageChunk } from "ai";
import type { ToolUiResourceData } from "@/clients/chat-mcp-client";

// Injects a `data-tool-ui-start` chunk right after each `tool-input-start` chunk
// that has a prefetched UI resource, so the frontend renders the MCP App iframe
// as soon as the tool call opens. This deliberately lives in a transform over
// the merged UI message stream rather than in streamText's `onChunk`: `onChunk`
// runs upstream of the SDK's internal stream tee, so the empty-response probe
// (which pulls the first renderable chunk ahead of the merge) would fire it and
// emit `data-tool-ui-start` before its own `tool-input-start` ever reaches the
// client. Emitting in stream order keeps the UI-start right after its tool.
export function createToolUiStartTransform(params: {
  prefetchedUiResources: ReadonlyMap<string, ToolUiResourceData>;
  toolUiResourceUris: Record<string, string>;
}): TransformStream<UIMessageChunk, UIMessageChunk> {
  const { prefetchedUiResources, toolUiResourceUris } = params;
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (chunk.type !== "tool-input-start") return;
      const prefetched = prefetchedUiResources.get(chunk.toolName);
      if (!prefetched) return;
      controller.enqueue({
        type: "data-tool-ui-start",
        data: {
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          uiResourceUri: toolUiResourceUris[chunk.toolName],
          html: prefetched.html,
          csp: prefetched.csp,
          permissions: prefetched.permissions,
        },
      });
    },
  });
}
