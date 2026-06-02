import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import { buildContextWindowBreakdown } from "./context-window-breakdown";

function tokensFor(
  breakdown: ReturnType<typeof buildContextWindowBreakdown>,
  category: string,
): number {
  return (
    breakdown.segments.find((segment) => segment.category === category)
      ?.tokens ?? 0
  );
}

describe("buildContextWindowBreakdown", () => {
  const baseParams = {
    provider: "openai" as const,
    model: "gpt-4o",
    contextLength: 128_000,
  };

  it("returns an empty breakdown when there is nothing to send", () => {
    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      messages: [],
    });

    expect(breakdown.segments).toEqual([]);
    expect(breakdown.usedTokens).toBe(0);
    expect(breakdown.freeTokens).toBe(128_000);
    expect(breakdown.usedPercent).toBe(0);
  });

  it("counts the system prompt and user messages in separate categories", () => {
    const messages: ChatMessage[] = [
      { role: "user", parts: [{ type: "text", text: "Hello there, model" }] },
    ];

    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      systemPrompt: "You are a helpful assistant.",
      messages,
    });

    expect(tokensFor(breakdown, "system_prompt")).toBeGreaterThan(0);
    expect(tokensFor(breakdown, "messages")).toBeGreaterThan(0);
    expect(tokensFor(breakdown, "tools")).toBe(0);
  });

  it("attributes tool calls and results to the tool_results category", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        parts: [
          {
            type: "tool-search",
            toolName: "search",
            state: "output-available",
            output: { results: ["a", "b", "c"] },
          },
        ],
      },
    ];

    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      messages,
    });

    expect(tokensFor(breakdown, "tool_results")).toBeGreaterThan(0);
    expect(tokensFor(breakdown, "messages")).toBe(0);
  });

  it("counts tool schemas from the AI SDK tool map", () => {
    const tools = {
      search: {
        description: "Search the knowledge base for relevant documents",
        inputSchema: {
          jsonSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
    };

    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      tools,
      messages: [],
    });

    expect(tokensFor(breakdown, "tools")).toBeGreaterThan(0);
  });

  it("estimates file attachment tokens from byte size", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        parts: [
          {
            type: "file",
            filename: "report.pdf",
            mediaType: "application/pdf",
            fileSize: 120_000,
          },
        ],
      },
    ];

    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      messages,
    });

    // 120_000 bytes / 12 bytes-per-token (PDF heuristic) = 10_000 tokens
    expect(tokensFor(breakdown, "files")).toBe(10_000);
  });

  it("computes used/free/percent against the model context length", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        parts: [
          {
            type: "file",
            filename: "data.bin",
            mediaType: "application/octet-stream",
            fileSize: 4_000,
          },
        ],
      },
    ];

    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      contextLength: 10_000,
      messages,
    });

    // 4_000 bytes / 4 bytes-per-token = 1_000 tokens
    expect(breakdown.usedTokens).toBe(1_000);
    expect(breakdown.freeTokens).toBe(9_000);
    expect(breakdown.usedPercent).toBeCloseTo(10);
  });

  it("reports null free space and percent when context length is unknown", () => {
    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      contextLength: null,
      messages: [
        { role: "user", parts: [{ type: "text", text: "anything at all" }] },
      ],
    });

    expect(breakdown.contextLength).toBeNull();
    expect(breakdown.freeTokens).toBeNull();
    expect(breakdown.usedPercent).toBeNull();
    expect(breakdown.usedTokens).toBeGreaterThan(0);
  });

  it("keeps segments in canonical stack order", () => {
    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      systemPrompt: "system",
      tools: {
        t: { description: "a tool", inputSchema: { jsonSchema: {} } },
      },
      messages: [
        { role: "user", parts: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          parts: [
            {
              type: "tool-x",
              toolName: "x",
              state: "output-available",
              output: { ok: true },
            },
          ],
        },
      ],
    });

    const order = breakdown.segments.map((segment) => segment.category);
    expect(order).toEqual([
      "system_prompt",
      "tools",
      "messages",
      "tool_results",
    ]);
  });
});
