import {
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
} from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import type { KbChunkForQuoteCheck } from "@/knowledge-base/quote-verification";
import { __test } from "./chat-tool-builder";

const { collectKbChunksForVerification } = __test;

const REF = "3fa85f64-5717-4562-b3fc-2c963f66afa6#0";
const CHUNK: KbChunkForQuoteCheck = {
  ref: REF,
  content: "TITLE: Data Policy\n\nThe retention period is 90 days.",
};

/** The raw CallToolResult shape query_knowledge_sources produces. */
function kbResult(): CallToolResult {
  const output = { results: [CHUNK], totalChunks: 1 };
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

describe("collectKbChunksForVerification", () => {
  afterEach(() => {
    archestraMcpBranding.syncFromOrganization(null);
  });

  const queryToolFullName = () =>
    archestraMcpBranding.getToolName(TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME);
  const runToolFullName = () =>
    archestraMcpBranding.getToolName(TOOL_RUN_TOOL_SHORT_NAME);

  it("captures chunks from a direct query_knowledge_sources call", () => {
    const kbChunksCollector: KbChunkForQuoteCheck[] = [];
    collectKbChunksForVerification({
      ctx: { kbChunksCollector },
      toolName: queryToolFullName(),
      toolArguments: { query: "retention" },
      response: kbResult(),
    });
    expect(kbChunksCollector).toEqual([CHUNK]);
  });

  it("captures chunks from a run_tool dispatch naming the bare short name", () => {
    // The default My Assistant runs with toolExposureMode search_and_run_only,
    // so its KB queries arrive exactly like this — as run_tool dispatches, not
    // direct calls. Missing this path silently disabled verification on the
    // primary chat surface.
    const kbChunksCollector: KbChunkForQuoteCheck[] = [];
    collectKbChunksForVerification({
      ctx: { kbChunksCollector },
      toolName: runToolFullName(),
      toolArguments: {
        tool_name: TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
        tool_args: { query: "retention" },
      },
      response: kbResult(),
    });
    expect(kbChunksCollector).toEqual([CHUNK]);
  });

  it("captures chunks from a run_tool dispatch naming the full tool name", () => {
    const kbChunksCollector: KbChunkForQuoteCheck[] = [];
    collectKbChunksForVerification({
      ctx: { kbChunksCollector },
      toolName: runToolFullName(),
      toolArguments: {
        tool_name: queryToolFullName(),
        tool_args: { query: "retention" },
      },
      response: kbResult(),
    });
    expect(kbChunksCollector).toEqual([CHUNK]);
  });

  it("captures chunks under white-labeled tool names", () => {
    archestraMcpBranding.syncFromOrganization({
      appName: "Custom Ops",
      iconLogo: null,
    });
    const kbChunksCollector: KbChunkForQuoteCheck[] = [];
    expect(runToolFullName()).toBe("custom_ops__run_tool");
    collectKbChunksForVerification({
      ctx: { kbChunksCollector },
      toolName: runToolFullName(),
      toolArguments: {
        tool_name: queryToolFullName(),
        tool_args: { query: "retention" },
      },
      response: kbResult(),
    });
    expect(kbChunksCollector).toEqual([CHUNK]);
  });

  it("ignores other archestra tools", () => {
    const kbChunksCollector: KbChunkForQuoteCheck[] = [];
    collectKbChunksForVerification({
      ctx: { kbChunksCollector },
      toolName: archestraMcpBranding.getToolName("search_tools"),
      toolArguments: { query: "retention" },
      response: kbResult(),
    });
    expect(kbChunksCollector).toEqual([]);
  });

  it("ignores run_tool dispatches to third-party tools", () => {
    const kbChunksCollector: KbChunkForQuoteCheck[] = [];
    collectKbChunksForVerification({
      ctx: { kbChunksCollector },
      toolName: runToolFullName(),
      toolArguments: {
        tool_name: "github__search_issues",
        tool_args: { query: "retention" },
      },
      response: kbResult(),
    });
    expect(kbChunksCollector).toEqual([]);
  });

  it("ignores a run_tool dispatch whose target cannot be resolved", () => {
    const kbChunksCollector: KbChunkForQuoteCheck[] = [];
    collectKbChunksForVerification({
      ctx: { kbChunksCollector },
      toolName: runToolFullName(),
      toolArguments: { tool_args: { query: "retention" } },
      response: kbResult(),
    });
    expect(kbChunksCollector).toEqual([]);
  });

  it("ignores error results", () => {
    const kbChunksCollector: KbChunkForQuoteCheck[] = [];
    collectKbChunksForVerification({
      ctx: { kbChunksCollector },
      toolName: queryToolFullName(),
      toolArguments: { query: "retention" },
      response: { ...kbResult(), isError: true },
    });
    expect(kbChunksCollector).toEqual([]);
  });

  it("is a no-op without a collector (verification disabled or non-chat path)", () => {
    expect(() =>
      collectKbChunksForVerification({
        ctx: {},
        toolName: queryToolFullName(),
        toolArguments: { query: "retention" },
        response: kbResult(),
      }),
    ).not.toThrow();
  });
});
