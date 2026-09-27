import type { UIMessageChunk } from "ai";
import { describe, expect, test } from "vitest";
import type { ToolUiResourceData } from "@/clients/chat-mcp-client";
import { createToolUiStartTransform } from "./tool-ui-stream";

async function pipeThroughTransform(
  chunks: UIMessageChunk[],
  transform: TransformStream<UIMessageChunk, UIMessageChunk>,
): Promise<UIMessageChunk[]> {
  const source = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

  const out: UIMessageChunk[] = [];
  const reader = source.pipeThrough(transform).getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("createToolUiStartTransform", () => {
  test("injects data-tool-ui-start immediately after its tool-input-start", async () => {
    const prefetched = new Map<string, ToolUiResourceData>([
      ["search", { html: "<div>app</div>" }],
    ]);
    const transform = createToolUiStartTransform({
      prefetchedUiResources: prefetched,
      toolUiResourceUris: { search: "ui://search" },
    });

    const out = await pipeThroughTransform(
      [
        { type: "text-start", id: "t0" },
        { type: "tool-input-start", toolCallId: "call-1", toolName: "search" },
        { type: "tool-input-delta", toolCallId: "call-1", inputTextDelta: "{" },
      ],
      transform,
    );

    const types = out.map((c) => c.type);
    const startIdx = types.indexOf("tool-input-start");
    expect(types[startIdx + 1]).toBe("data-tool-ui-start");
    // arrives before any tool input delta
    expect(startIdx + 1).toBeLessThan(types.indexOf("tool-input-delta"));

    const uiStart = out[startIdx + 1] as unknown as {
      data: { toolCallId: string; uiResourceUri: string; html: string };
    };
    expect(uiStart.data).toMatchObject({
      toolCallId: "call-1",
      uiResourceUri: "ui://search",
      html: "<div>app</div>",
    });
  });

  test("leaves a tool without a prefetched resource untouched", async () => {
    const transform = createToolUiStartTransform({
      prefetchedUiResources: new Map(),
      toolUiResourceUris: {},
    });

    const input: UIMessageChunk[] = [
      { type: "tool-input-start", toolCallId: "call-1", toolName: "plain" },
      { type: "tool-input-delta", toolCallId: "call-1", inputTextDelta: "{}" },
    ];
    const out = await pipeThroughTransform(input, transform);

    expect(out.map((c) => c.type)).toEqual([
      "tool-input-start",
      "tool-input-delta",
    ]);
  });

  test("injects once per tool when several tools open in one turn", async () => {
    const prefetched = new Map<string, ToolUiResourceData>([
      ["search", { html: "<a/>" }],
      ["browse", { html: "<b/>" }],
    ]);
    const transform = createToolUiStartTransform({
      prefetchedUiResources: prefetched,
      toolUiResourceUris: { search: "ui://search", browse: "ui://browse" },
    });

    const out = await pipeThroughTransform(
      [
        { type: "tool-input-start", toolCallId: "c1", toolName: "search" },
        { type: "tool-input-start", toolCallId: "c2", toolName: "browse" },
      ],
      transform,
    );

    expect(out.map((c) => c.type)).toEqual([
      "tool-input-start",
      "data-tool-ui-start",
      "tool-input-start",
      "data-tool-ui-start",
    ]);
  });
});
