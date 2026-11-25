import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import { buildArchestraToolOutput } from "./chat-tool-builder";

describe("buildArchestraToolOutput", () => {
  it("keeps a direct policy preview's structuredContent for its diff card", async () => {
    const structuredContent = {
      stage: "preview",
      delivery: "revision",
      before: "",
      after: "[policy]\nversion = 2\n",
    };
    const response: CallToolResult = {
      content: [{ type: "text", text: '{"diff":"..."}' }],
      structuredContent,
    };
    const toolName = archestraMcpBranding.getToolName(
      "preview_guardrails_policy_change",
    );

    const output = await buildArchestraToolOutput({
      response,
      toolName,
      toolArguments: {},
      agentId: "agent",
    });

    expect(output).toMatchObject({ structuredContent });
  });

  it("leaves other direct Archestra results as plain text", async () => {
    const output = await buildArchestraToolOutput({
      response: {
        content: [{ type: "text", text: "{}" }],
        structuredContent: { policy: "x" },
      },
      toolName: archestraMcpBranding.getToolName("get_guardrails_policy"),
      toolArguments: {},
      agentId: "agent",
    });

    expect(output).not.toHaveProperty("structuredContent");
  });

  it("names an audio block a dispatched tool returned, and keeps its payload out of the text", async () => {
    const audio = { type: "audio", data: "UklGRg==", mimeType: "audio/wav" };
    const output = await buildArchestraToolOutput({
      response: {
        content: [{ type: "text", text: "Recording:" }, audio],
      } as CallToolResult,
      toolName: archestraMcpBranding.getToolName("run_tool"),
      toolArguments: { tool_name: "recorder__record", tool_args: {} },
      agentId: "agent",
    });

    // The same marker a direct call gets: the base64 would only fill the
    // model's context.
    expect(output).toMatchObject({ content: "Recording:\n[audio]" });
  });
});
